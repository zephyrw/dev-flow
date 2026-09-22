import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setup } from "../helpers.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  DEFAULT_ATTACHMENT_PROMPT,
  SubagentCapabilitiesSchema,
  type ConversationFile,
  type ConversationMessage,
  type FeedbackMessage,
  type FunctionalIssue,
  type Run,
  type State,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import { ConversationFileService } from "../../packages/core/src/conversation-files.js";
import {
  ConversationMessageService,
  CONVERSATION_MESSAGE_ERROR,
  type ConversationControlPort,
} from "../../packages/core/src/conversation-message-service.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { FunctionalIssueService } from "../../packages/core/src/functional-issues.js";
import { now } from "../../packages/core/src/util.js";
import {
  prepareConversationInputMaterials,
} from "../../packages/core/src/conversation-input-materials.js";
import {
  conversationMessagePlugin,
  consoleHumanGuard,
} from "../../apps/api/src/routes/conversation-messages.js";
import type { ConversationControlRequest } from "../../packages/core/src/conversation-control.js";
import type { AsideSession } from "../../packages/contracts/src/feedback.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const TEXT_BODY = Buffer.from("conversation-message-same-hash");
const PROFILE: ToolProfile = {
  id: "profile-codex",
  revision: 1,
  adapterId: "codex",
  modelSelection: "native-config",
  options: {},
};
const ALL_INPUT = SubagentCapabilitiesSchema.parse({
  file_input: { text: true, image: true, binary: true },
});

class RecordingControl implements ConversationControlPort {
  calls: Array<{ workflowId: string; request: ConversationControlRequest }> = [];
  async pauseTree(
    workflowId: string,
    request: ConversationControlRequest,
  ): Promise<unknown> {
    this.calls.push({ workflowId, request });
    return { status: "complete" };
  }
}

const opened: Array<{
  app?: Awaited<ReturnType<typeof Fastify>>;
  store: ReturnType<typeof setup>["store"];
}> = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    if (item.app) await item.app.close();
    item.store.close();
  }
});

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function workflowRecord(id: string, state: State, runId: string): Workflow {
  return {
    id,
    project_id: "p1",
    title: "会话消息",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "new_worktree",
    state,
    stage: "exec",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
    run_id: runId,
  };
}

function runRecord(id: string, workflowId: string): Run {
  return {
    id,
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "codex",
    purpose: "implement",
    stage: "execute",
    status: "running",
    started_at: "2026-09-20T00:00:00.000Z",
    package_hash: "pkg",
    profile: PROFILE,
  };
}

function ctx(workflowId: string, runId: string, nativeId: string) {
  return {
    project_id: "p1",
    workflow_id: workflowId,
    run_id: runId,
    adapter_id: "codex",
    scope: "profile-codex",
    lineage_id: `lineage-${workflowId}`,
    purpose: "implement",
    root_native_id: nativeId,
  };
}

function event(
  nativeId: string,
  extra: Partial<NativeConversationEvent> = {},
): NativeConversationEvent {
  return {
    source_id: extra.source_id ?? `src-${nativeId}`,
    source_seq: extra.source_seq ?? "1",
    root_native_id: nativeId,
    session_native_id: extra.session_native_id ?? nativeId,
    kind: extra.kind ?? "discovered",
    payload: extra.payload ?? { title: "主会话", status: "running" },
  };
}

async function upload(
  files: ConversationFileService,
  workflowId: string,
  requestId: string,
  displayName: string,
  mime: string,
  content: Buffer,
) {
  const created = files.createMetadata(workflowId, {
    request_id: requestId,
    display_name: displayName,
    size: content.length,
    declared_mime: mime,
  });
  return files.writeContent(workflowId, created.file_id, content);
}

function fixture(states: Record<string, State> = { wf1: "EXECUTING" }) {
  const s = setup();
  const files = new ConversationFileService(s.store, s.config.storage_root);
  const conversations = new ConversationService(s.store);
  const control = new RecordingControl();
  const roots = new Map<string, { id: string; generation: number }>();
  for (const [workflowId, state] of Object.entries(states)) {
    const runId = `run-${workflowId}`;
    const nativeId = `native-${workflowId}`;
    s.store.put("workflow", workflowId, "p1", workflowRecord(workflowId, state, runId));
    s.store.put("run", runId, workflowId, runRecord(runId, workflowId));
    conversations.setCapabilities(workflowId, ALL_INPUT);
    const node = conversations.applyEvent(
      ctx(workflowId, runId, nativeId),
      event(nativeId),
    ).node!;
    roots.set(workflowId, { id: node.id, generation: 0 });
  }
  const messages = new ConversationMessageService({
    store: s.store,
    files,
    feedback: new FeedbackService(s.store),
    asides: new AsideSessionService(s.store),
    issues: new FunctionalIssueService(s.store),
    conversations,
    storageRoot: s.config.storage_root,
    control,
  });
  opened.push({ store: s.store });
  return { s, files, conversations, messages, control, roots };
}

async function startApp(states?: Record<string, State>) {
  const f = fixture(states);
  const app = Fastify({ logger: false });
  await app.register(conversationMessagePlugin, {
    messages: f.messages,
    human: consoleHumanGuard,
  });
  await app.ready();
  opened[opened.length - 1]!.app = app;
  return { ...f, app };
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}

function payload(
  roots: Map<string, { id: string; generation: number }>,
  workflowId: string,
  extra: Record<string, unknown> = {},
) {
  const root = roots.get(workflowId)!;
  return {
    request_id: "req-1",
    root_conversation_id: root.id,
    expected_generation: root.generation,
    text: "请继续当前任务",
    refs: [],
    attachment_ids: [],
    ...extra,
  };
}

function resumeMaterials(
  files: ConversationFileService,
  storageRoot: string,
  workflowId: string,
  fileId: string,
  mode: "formal" | "aside" = "formal",
) {
  return prepareConversationInputMaterials({
    text: "resume",
    mode,
    files: [files.getMetadata(workflowId, fileId)],
    storageRoot,
    workflowId,
    profile: PROFILE,
    fileInput: ALL_INPUT.file_input,
  });
}

describe("SA-I17 conversation message attachment paths", () => {
  it("formal/planning/functional/aside bind ready files and resume the same hash", async () => {
    const f = fixture({
      "wf-exec": "EXECUTING",
      "wf-plan": "PLAN_PENDING",
      "wf-human": "HUMAN_PENDING",
      "wf-aside": "EXECUTING",
    });
    const note = await upload(
      f.files,
      "wf-exec",
      "file-exec",
      "note.txt",
      "text/plain",
      TEXT_BODY,
    );
    const planFile = await upload(
      f.files,
      "wf-plan",
      "file-plan",
      "plan.txt",
      "text/plain",
      TEXT_BODY,
    );
    const issueFile = await upload(
      f.files,
      "wf-human",
      "file-human",
      "bug.txt",
      "text/plain",
      TEXT_BODY,
    );
    const asideFile = await upload(
      f.files,
      "wf-aside",
      "file-aside",
      "shot.png",
      "image/png",
      PNG_1X1,
    );
    const formal = await f.messages.submit(
      "wf-exec",
      payload(f.roots, "wf-exec", { attachment_ids: [note.id] }),
    );
    const planning = await f.messages.submit(
      "wf-plan",
      payload(f.roots, "wf-plan", {
        request_id: "req-plan",
        text: "请缩小范围",
        attachment_ids: [planFile.id],
      }),
    );
    const functional = await f.messages.submit(
      "wf-human",
      payload(f.roots, "wf-human", {
        request_id: "req-human",
        text: "登录按钮无反应",
        attachment_ids: [issueFile.id],
      }),
    );
    const aside = await f.messages.submit(
      "wf-aside",
      payload(f.roots, "wf-aside", {
        request_id: "req-aside",
        text: "/btw 这段为什么这样设计？",
        attachment_ids: [asideFile.id],
      }),
    );
    expect(formal.mode).toBe("formal");
    expect(planning.mode).toBe("formal");
    expect(functional.mode).toBe("formal");
    expect(aside.mode).toBe("aside");
    expect(aside.aside_id).toBeTruthy();
    const feedback = f.s.store.list<FeedbackMessage>("feedback_message", "wf-exec");
    expect(feedback[0]?.attachment_ids).toEqual([note.id]);
    expect(feedback[0]?.kind).toBe("execution");
    const planFeedback = f.s.store.list<FeedbackMessage>(
      "feedback_message",
      "wf-plan",
    );
    expect(planFeedback[0]?.kind).toBe("planning");
    expect(planFeedback[0]?.attachment_ids).toEqual([planFile.id]);
    const issue = f.s.store.list<FunctionalIssue>("functional_issue", "wf-human")[0];
    expect(issue?.attachment_ids).toEqual([issueFile.id]);
    const asideSession = f.s.store.get<AsideSession>(
      "aside_session",
      aside.aside_id!,
    );
    expect(asideSession?.attachment_ids).toEqual([asideFile.id]);
    const reopened = new ConversationFileService(
      f.s.store,
      f.s.config.storage_root,
    );
    const execMaterials = resumeMaterials(
      reopened,
      f.s.config.storage_root,
      "wf-exec",
      note.id,
    );
    const asideMaterials = resumeMaterials(
      reopened,
      f.s.config.storage_root,
      "wf-aside",
      asideFile.id,
      "aside",
    );
    expect(execMaterials.resolved.ok).toBe(true);
    expect(asideMaterials.resolved.ok).toBe(true);
    if (!execMaterials.resolved.ok || !asideMaterials.resolved.ok) return;
    expect(execMaterials.resolved.attachments[0]?.sha256).toBe(digest(TEXT_BODY));
    expect(asideMaterials.resolved.attachments[0]?.sha256).toBe(digest(PNG_1X1));
    expect(
      readFileSync(execMaterials.resolved.attachments[0]!.absolute_path),
    ).toEqual(TEXT_BODY);
    expect(
      readFileSync(asideMaterials.resolved.attachments[0]!.absolute_path),
    ).toEqual(PNG_1X1);
    expect(execMaterials.deliver_to_main_model).toBe(true);
    expect(asideMaterials.deliver_to_main_model).toBe(false);
    expect(
      resumeMaterials(
        reopened,
        f.s.config.storage_root,
        "wf-plan",
        planFile.id,
      ).resolved.ok,
    ).toBe(true);
    expect(
      resumeMaterials(
        reopened,
        f.s.config.storage_root,
        "wf-human",
        issueFile.id,
      ).resolved.ok,
    ).toBe(true);
  });
});

describe("SA-I18 conversation message routing and guards", () => {
  it("splits slash aside and accepts file-only formal without pausing for aside", async () => {
    const { app, messages, control, files, s, roots } = await startApp();
    const ready = await upload(
      files,
      "wf1",
      "file-ok",
      "note.txt",
      "text/plain",
      TEXT_BODY,
    );
    const aside = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-messages",
      headers: jsonHeaders(),
      payload: payload(roots, "wf1", {
        request_id: "slash-1",
        text: "/btw 为什么要等测试？",
        attachment_ids: [ready.id],
      }),
    });
    expect(aside.statusCode).toBe(200);
    expect(aside.json().mode).toBe("aside");
    expect(aside.json().aside_id).toBeTruthy();
    expect(control.calls).toHaveLength(0);
    const fileOnly = await messages.submit(
      "wf1",
      payload(roots, "wf1", {
        request_id: "file-only",
        text: "   ",
        attachment_ids: [ready.id],
      }),
    );
    expect(fileOnly.mode).toBe("formal");
    const stored = s.store.list<ConversationMessage>(
      CONVERSATION_ENTITY.message,
      "wf1",
    );
    const fileMessage = stored.find((item) => item.request_id === "file-only");
    expect(fileMessage?.text).toBe(DEFAULT_ATTACHMENT_PROMPT);
    expect(control.calls).toHaveLength(1);
  });

  it("rejects unknown file_input before pausing and keeps a single idempotent message", async () => {
    const f = fixture();
    const ready = await upload(
      f.files,
      "wf1",
      "file-ok",
      "note.txt",
      "text/plain",
      TEXT_BODY,
    );
    f.conversations.setCapabilities(
      "wf1",
      SubagentCapabilitiesSchema.parse({
        file_input: { text: false, image: false, binary: false },
      }),
    );
    await expect(
      f.messages.submit(
        "wf1",
        payload(f.roots, "wf1", { attachment_ids: [ready.id] }),
      ),
    ).rejects.toMatchObject({
      code: CONVERSATION_ERROR.INPUT_UNSUPPORTED,
    });
    expect(f.control.calls).toHaveLength(0);
    expect(
      f.s.store.list<ConversationMessage>(CONVERSATION_ENTITY.message, "wf1"),
    ).toHaveLength(0);
    f.conversations.setCapabilities("wf1", ALL_INPUT);
    const first = await f.messages.submit(
      "wf1",
      payload(f.roots, "wf1", { request_id: "dup-1", attachment_ids: [ready.id] }),
    );
    const second = await f.messages.submit(
      "wf1",
      payload(f.roots, "wf1", { request_id: "dup-1", attachment_ids: [ready.id] }),
    );
    expect(second.message_id).toBe(first.message_id);
    expect(
      f.s.store.list<ConversationMessage>(CONVERSATION_ENTITY.message, "wf1"),
    ).toHaveLength(1);
    await expect(
      f.messages.submit(
        "wf1",
        payload(f.roots, "wf1", {
          request_id: "dup-1",
          text: "另一份内容",
          attachment_ids: [ready.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("does not pause the root when validation fails or mode is forged", async () => {
    const { app, control, files, roots, s } = await startApp();
    const pending = files.createMetadata("wf1", {
      request_id: "pending-1",
      display_name: "late.txt",
      size: 4,
      declared_mime: "text/plain",
    });
    const notReady = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-messages",
      headers: jsonHeaders(),
      payload: payload(roots, "wf1", {
        request_id: "not-ready",
        attachment_ids: [pending.file_id],
      }),
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error.code).toBe(CONVERSATION_ERROR.FILE_NOT_READY);
    expect(control.calls).toHaveLength(0);
    const forged = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-messages",
      headers: jsonHeaders(),
      payload: payload(roots, "wf1", {
        request_id: "forged",
        text: "这是正式指导",
        client_mode: "aside",
      }),
    });
    expect(forged.statusCode).toBe(409);
    expect(forged.json().error.code).toBe(
      CONVERSATION_MESSAGE_ERROR.CLIENT_MODE_MISMATCH,
    );
    expect(control.calls).toHaveLength(0);
    expect(
      s.store.list<ConversationMessage>(CONVERSATION_ENTITY.message, "wf1"),
    ).toHaveLength(0);
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-messages",
      headers: {
        ...jsonHeaders(),
        authorization: "Bearer model-token",
      },
      payload: payload(roots, "wf1", { request_id: "auth" }),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(control.calls).toHaveLength(0);
  });
});

describe("SA-I20 aside isolation and send rules", () => {
  it("does not advance the main feedback cursor for readonly aside", async () => {
    const f = fixture();
    const prior = new FeedbackService(f.s.store).submitFeedback({
      request_id: "prior-fb",
      workflow_id: "wf1",
      kind: "execution",
      text: "已有正式反馈",
    });
    const aside = await f.messages.submit(
      "wf1",
      payload(f.roots, "wf1", {
        request_id: "aside-iso",
        text: "/side 只问一句",
      }),
    );
    expect(aside.mode).toBe("aside");
    const page = new FeedbackService(f.s.store).listMessages("wf1", 0, 50);
    expect(page.messages.map((item) => item.message_id)).toEqual([
      prior.message_id,
    ]);
    expect(page.nextCursor).toBe(prior.seq);
    expect(f.control.calls).toHaveLength(0);
    const session = f.s.store.get<AsideSession>("aside_session", aside.aside_id!);
    expect(session?.attachment_ids).toEqual([]);
  });

  it("records WAITING_AUTHORIZATION as supplement and disables ended formal send", async () => {
    const waiting = fixture({ wf1: "WAITING_AUTHORIZATION" });
    const extra = await waiting.messages.submit(
      "wf1",
      payload(waiting.roots, "wf1", {
        request_id: "auth-note",
        text: "补充意见，先不要批准",
      }),
    );
    expect(extra.accepted).toBe(true);
    expect(waiting.control.calls).toHaveLength(0);
    expect(waiting.s.store.must<Workflow>("workflow", "wf1").state).toBe(
      "WAITING_AUTHORIZATION",
    );
    const ended = fixture({ wf1: "COMPLETED" });
    await expect(
      ended.messages.submit(
        "wf1",
        payload(ended.roots, "wf1", { request_id: "ended", text: "再改一版" }),
      ),
    ).rejects.toMatchObject({
      code: CONVERSATION_MESSAGE_ERROR.SEND_DISABLED,
    });
    expect(ended.control.calls).toHaveLength(0);
    const aside = await ended.messages.submit(
      "wf1",
      payload(ended.roots, "wf1", {
        request_id: "ended-aside",
        text: "/btw 结束后还能问吗？",
      }),
    );
    expect(aside.mode).toBe("aside");
  });

  it("old feedback/aside/functional entries share attachment ownership", async () => {
    const f = fixture({
      wf1: "EXECUTING",
      "wf-human": "HUMAN_PENDING",
    });
    const file = await upload(
      f.files,
      "wf1",
      "old-file",
      "note.txt",
      "text/plain",
      TEXT_BODY,
    );
    const humanFile = await upload(
      f.files,
      "wf-human",
      "old-human-file",
      "bug.txt",
      "text/plain",
      TEXT_BODY,
    );
    const formal = await f.messages.submitFormal("wf1", {
      request_id: "old-fb",
      text: "旧反馈入口",
      attachment_ids: [file.id],
      root_conversation_id: f.roots.get("wf1")!.id,
      expected_generation: 0,
    });
    expect(formal.mode).toBe("formal");
    const aside = await f.messages.submitAside("wf1", {
      request_id: "old-aside",
      text: "旧提问入口",
      attachment_ids: [file.id],
      root_conversation_id: f.roots.get("wf1")!.id,
      expected_generation: 0,
    });
    expect(aside.aside_id).toBeTruthy();
    const functional = await f.messages.submitFunctional("wf-human", {
      request_id: "old-issue",
      text: "旧功能问题",
      attachment_ids: [humanFile.id],
      root_conversation_id: f.roots.get("wf-human")!.id,
      expected_generation: 0,
    });
    expect(functional.accepted).toBe(true);
    const fb = f.s.store.list<FeedbackMessage>("feedback_message", "wf1")[0];
    expect(fb?.attachment_ids).toEqual([file.id]);
    const session = f.s.store.get<AsideSession>("aside_session", aside.aside_id!);
    expect(session?.attachment_ids).toEqual([file.id]);
    const issue = f.s.store.list<FunctionalIssue>(
      "functional_issue",
      "wf-human",
    )[0];
    expect(issue?.attachment_ids).toEqual([humanFile.id]);
    const bound = f.s.store.must<ConversationFile>(
      CONVERSATION_ENTITY.file,
      file.id,
    );
    expect(bound.referenced_message_ids.length).toBeGreaterThan(0);
  });
});
