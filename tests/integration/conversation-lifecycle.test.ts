import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, prepared, plan } from "../helpers.js";
import { createIsolatedTestEnv } from "../fixtures/isolation.js";
import {
  type Run,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import {
  ConversationControlService,
  type StopPort,
  type StopPortResult,
  type StopPortTarget,
} from "../../packages/core/src/conversation-control.js";
import { ConversationObserver } from "../../packages/runtime/src/conversation-observer.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import { saveWaitingContext } from "../../packages/core/src/waiting-context.js";
import { objectHash, now } from "../../packages/core/src/util.js";

const opened: Array<{ close: () => Promise<void> | void }> = [];

afterEach(async () => {
  for (const item of opened.splice(0)) await item.close();
});

class RecordingStopPort implements StopPort {
  calls: StopPortTarget[] = [];
  async stopConversation(target: StopPortTarget): Promise<StopPortResult> {
    this.calls.push({ ...target });
    return { accepted: true, confirmation: "exited" };
  }
}

function ctx(
  extra: Partial<ConversationApplyContext> = {},
): ConversationApplyContext {
  return {
    project_id: extra.project_id ?? "p1",
    workflow_id: extra.workflow_id ?? "wf1",
    run_id: extra.run_id ?? "run1",
    adapter_id: extra.adapter_id ?? "codex",
    scope: extra.scope ?? "profile-codex",
    lineage_id: extra.lineage_id ?? "lineage-implement",
    purpose: extra.purpose ?? "implement",
    root_native_id: extra.root_native_id ?? "root-native",
    ...extra,
  };
}

function event(
  extra: Partial<NativeConversationEvent> & { payload?: Record<string, unknown> },
): NativeConversationEvent {
  return {
    source_id: extra.source_id ?? "src-1",
    source_seq: extra.source_seq ?? "1",
    root_native_id: extra.root_native_id ?? "root-native",
    session_native_id: extra.session_native_id,
    parent_native_id: extra.parent_native_id,
    kind: extra.kind ?? "discovered",
    payload: extra.payload ?? {},
  };
}

function seedTree(
  conversations: ConversationService,
  context: ConversationApplyContext,
) {
  const root = conversations.applyEvent(
    context,
    event({
      source_id: `src-${context.run_id}`,
      session_native_id: context.root_native_id,
      payload: { title: "主会话", status: "running" },
    }),
  ).node!;
  const child = conversations.applyEvent(
    context,
    event({
      source_id: `src-${context.run_id}`,
      source_seq: "2",
      session_native_id: "child-native",
      parent_native_id: context.root_native_id,
      payload: { title: "后台子", status: "running" },
    }),
  ).node!;
  return { root, child };
}

describe("SA-I24 conversation lifecycle", () => {
  it("recovers an unapproved plan into planning instead of execute", async () => {
    const s = setup();
    opened.push({ close: () => s.store.close() });
    const r = await import("../helpers.js").then((mod) =>
      mod.repository(s.root),
    );
    const p = (await import("../helpers.js")).project(r.repo);
    await s.engine.registerProject(p);
    const w = s.engine.create(
      {
        project_id: p.id,
        title: "未批准规划",
        request: "规划",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "plan-unapproved",
    );
    s.engine.submitPlan(w.id, plan(objectHash(p), r.baseline), w.version, "plan1");
    expect(s.engine.get(w.id).state).toBe("PLAN_PENDING");
    await s.engine.stop(w.id, "local_console");
    expect(s.engine.get(w.id).state).toBe("STOPPED");
    const next = resumeApproved(s.engine, w.id);
    expect(next.state).toBe("PLANNING");
    expect(next.state).not.toBe("QUEUED");
    expect(next.state).not.toBe("EXECUTING");
  });

  it("keeps the review phase when resuming", async () => {
    const s = await prepared();
    opened.push({ close: () => s.store.close() });
    saveWaitingContext(s.store, s.workflow.id, {
      purpose: "review",
      role: "planner",
      phase: "before_human",
      run_id: s.workflow.run_id,
      intent: "completed",
    });
    await s.engine.stop(s.workflow.id, "local_console");
    const next = resumeApproved(s.engine, s.workflow.id);
    expect(next.state).toBe("REVIEW_QUEUED");
    expect(next.stage).toBe("quality_before_human");
  });

  it("keeps a background child alive after the root is terminal", async () => {
    const s = setup();
    opened.push({ close: () => s.store.close() });
    const workflow: Workflow = {
      id: "wf1",
      project_id: "p1",
      title: "bg",
      request: "fixture",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "EXECUTING",
      stage: "exec",
      version: 1,
      plan_revision: 0,
      environment_revision: 0,
      run_id: "run1",
      created_at: now(),
      updated_at: now(),
      feedback: [],
    };
    const run: Run = {
      id: "run1",
      workflow_id: "wf1",
      plan_revision: 0,
      adapter: "codex",
      purpose: "implement",
      stage: "exec",
      status: "running",
      started_at: "2026-09-20T00:00:00.000Z",
      package_hash: "pkg",
    };
    s.store.put("workflow", "wf1", "p1", workflow);
    s.store.put("run", "run1", "wf1", run);
    const conversations = new ConversationService(s.store);
    const { root, child } = seedTree(conversations, ctx());
    conversations.applyEvent(
      ctx(),
      event({
        kind: "state",
        source_seq: "3",
        session_native_id: "root-native",
        payload: { status: "completed" },
      }),
    );
    const dir = join(s.root, "obs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "child.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        kind: "activity",
        source_id: "file-child",
        source_seq: "4",
        root_native_id: "root-native",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { activity_id: "bg-1", public_text: "后台仍在工作" },
      }) + "\n",
    );
    const observer = new ConversationObserver({
      service: conversations,
      context: ctx(),
    });
    observer.addSource({
      source_id: "file-child",
      adapter_id: "codex",
      file_path: file,
      trusted_root: dir,
      conversation_id: child.id,
    });
    await observer.poll();
    const childPage = conversations.listActivities("wf1", child.id);
    expect(childPage.items).toHaveLength(1);
    expect(
      (childPage.items[0]!.payload as { public_text: string }).public_text,
    ).toBe("后台仍在工作");
    const rootAttempt = conversations
      .getTree("wf1")
      .attempts.filter((item) => item.conversation_id === root.id)
      .at(-1);
    expect(rootAttempt?.status).toBe("completed");
    const childAttempt = conversations
      .getTree("wf1")
      .attempts.filter((item) => item.conversation_id === child.id)
      .at(-1);
    expect(childAttempt?.status).toBe("running");
    await observer.stop();
  });

  it("does not gate main delivery on conversation observation", async () => {
    const s = await prepared();
    opened.push({ close: () => s.store.close() });
    const conversations = new ConversationService(s.store);
    conversations.applyEvent(
      ctx({
        workflow_id: s.workflow.id,
        run_id: s.workflow.run_id ?? "run-test",
      }),
      event({
        source_seq: "1",
        session_native_id: "grand",
        parent_native_id: "missing-parent",
        payload: { title: "观察不完整", status: "running" },
      }),
    );
    expect(
      conversations.getDiagnostics().some((item) => item.code === "pending_parent"),
    ).toBe(true);
    s.engine.claimTask(
      s.principal,
      s.workflow.id,
      "T01",
      "已经将文本修改为 after 并保留换行",
    );
    await s.engine.freeze(s.workflow.id, s.principal);
    const wf = s.engine.get(s.workflow.id);
    expect(wf.state).not.toBe("EXECUTING");
    expect(wf.state).not.toBe("FAILED");
  });

  it("does not stop another isolated test instance", async () => {
    const a = createIsolatedTestEnv();
    const b = createIsolatedTestEnv();
    opened.push({ close: () => a.cleanup() });
    opened.push({ close: () => b.cleanup() });
    const workflow = (id: string, projectId: string): Workflow => ({
      id,
      project_id: projectId,
      title: id,
      request: "fixture",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "EXECUTING",
      stage: "exec",
      version: 1,
      plan_revision: 0,
      environment_revision: 0,
      run_id: `${id}-run`,
      created_at: now(),
      updated_at: now(),
      feedback: [],
    });
    const run = (id: string, workflowId: string): Run => ({
      id,
      workflow_id: workflowId,
      plan_revision: 0,
      adapter: "codex",
      purpose: "implement",
      stage: "exec",
      status: "running",
      started_at: "2026-09-20T00:00:00.000Z",
      package_hash: "pkg",
    });
    a.store.put("workflow", "wf-a", "proj-a", workflow("wf-a", "proj-a"));
    a.store.put("run", "wf-a-run", "wf-a", run("wf-a-run", "wf-a"));
    b.store.put("workflow", "wf-b", "proj-b", workflow("wf-b", "proj-b"));
    b.store.put("run", "wf-b-run", "wf-b", run("wf-b-run", "wf-b"));
    const convA = new ConversationService(a.store);
    const convB = new ConversationService(b.store);
    const rootA = seedTree(
      convA,
      ctx({ project_id: "proj-a", workflow_id: "wf-a", run_id: "wf-a-run" }),
    ).root;
    seedTree(
      convB,
      ctx({ project_id: "proj-b", workflow_id: "wf-b", run_id: "wf-b-run" }),
    );
    const stopA = new RecordingStopPort();
    const stopB = new RecordingStopPort();
    const controlsA = new ConversationControlService(a.store, convA, stopA);
    const controlsB = new ConversationControlService(b.store, convB, stopB);
    await controlsA.submit("wf-a", {
      request_id: "pause-a",
      action: "pause",
      root_id: rootA.id,
      expected_generation: 0,
    });
    expect(stopA.calls.length).toBeGreaterThan(0);
    expect(stopB.calls).toHaveLength(0);
    expect(convB.getTree("wf-b").attempts.every((item) => item.status !== "paused")).toBe(
      true,
    );
  });
});
