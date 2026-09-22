import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../helpers.js";
import type { ToolProfile, Workflow } from "../../packages/contracts/src/index.js";
import { now } from "../../packages/core/src/util.js";
import { ConversationFileService } from "../../packages/core/src/conversation-files.js";
import {
  CONVERSATION_INPUT_ERROR,
  conversationInputIdentity,
  markConversationInputsDelivered,
  resolveConversationInputAttachments,
  resumeConversationInputAttachments,
  validateConversationInputReadScope,
  type FileInputCapability,
} from "../../packages/runtime/src/conversation-inputs.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const TEXT_BODY = Buffer.from("resume-same-hash");
const PDF_BODY = Buffer.from("%PDF-1.4 native-read");

const PROFILE: ToolProfile = {
  id: "profile-codex",
  revision: 1,
  adapterId: "codex",
  modelSelection: "native-config",
  options: {},
};
const ALL_INPUT: FileInputCapability = {
  text: true,
  image: true,
  binary: true,
};
const TEXT_ONLY: FileInputCapability = {
  text: true,
  image: false,
  binary: false,
};

const opened: Array<ReturnType<typeof setup>> = [];

afterEach(() => {
  for (const item of opened.splice(0)) item.store.close();
});

function fixture() {
  const s = setup();
  opened.push(s);
  const workflow: Workflow = {
    id: "wf1",
    project_id: "p1",
    title: "会话输入集成",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "new_worktree",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 0,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  s.store.put("workflow", workflow.id, workflow.project_id, workflow);
  const files = new ConversationFileService(s.store, s.config.storage_root);
  return { s, files, workflow };
}

async function upload(
  files: ConversationFileService,
  requestId: string,
  displayName: string,
  mime: string,
  content: Buffer,
) {
  const created = files.createMetadata("wf1", {
    request_id: requestId,
    display_name: displayName,
    size: content.length,
    declared_mime: mime,
  });
  return files.writeContent("wf1", created.file_id, content);
}

function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("SA-I16 conversation input managed files", () => {
  it("reads ready conversation-files bytes from the managed path only", async () => {
    const { s, files, workflow } = fixture();
    const png = await upload(files, "i16-png", "shot.png", "image/png", PNG_1X1);
    const note = await upload(
      files,
      "i16-txt",
      "note.txt",
      "text/plain",
      TEXT_BODY,
    );
    const resolved = resolveConversationInputAttachments({
      files: [png, note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(readFileSync(resolved.attachments[0]!.absolute_path)).toEqual(PNG_1X1);
    expect(readFileSync(resolved.attachments[1]!.absolute_path)).toEqual(
      TEXT_BODY,
    );
    expect(resolved.attachments[0]?.sha256).toBe(digest(PNG_1X1));
    const userDir = join(tmpdir(), `conversation-input-user-${Date.now()}`);
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "escape.txt"), "outside");
    const escaped = validateConversationInputReadScope(s.config.storage_root, [
      userDir,
    ]);
    expect(escaped).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
    });
    expect(s.store.must<Workflow>("workflow", workflow.id).state).toBe(
      "EXECUTING",
    );
  });
});

describe("SA-I17 conversation input resume identity", () => {
  it("reuses the same file id and hash after a storage reopen", async () => {
    const { s, files, workflow } = fixture();
    const note = await upload(
      files,
      "i17-txt",
      "note.txt",
      "text/plain",
      TEXT_BODY,
    );
    const pdf = await upload(files, "i17-pdf", "spec.pdf", "application/pdf", PDF_BODY);
    const first = resolveConversationInputAttachments({
      files: [note, pdf],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const reopened = new ConversationFileService(s.store, s.config.storage_root);
    const againFiles = [
      reopened.getMetadata("wf1", note.id),
      reopened.getMetadata("wf1", pdf.id),
    ];
    const resumed = resumeConversationInputAttachments({
      files: againFiles,
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(conversationInputIdentity(resumed.attachments[0]!)).toEqual(
      conversationInputIdentity(first.attachments[0]!),
    );
    expect(conversationInputIdentity(resumed.attachments[1]!)).toEqual(
      conversationInputIdentity(first.attachments[1]!),
    );
    expect(readFileSync(resumed.attachments[0]!.absolute_path)).toEqual(
      TEXT_BODY,
    );
    expect(readFileSync(resumed.attachments[1]!.absolute_path)).toEqual(
      PDF_BODY,
    );
    const delivered = markConversationInputsDelivered(resumed);
    expect(delivered.delivery.delivered).toBe(true);
    expect(delivered.delivery.observed).toBe(false);
    const rejected = resolveConversationInputAttachments({
      files: againFiles,
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: TEXT_ONLY,
    });
    expect(rejected).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_UNSUPPORTED,
      file_id: pdf.id,
    });
    expect(s.store.must<Workflow>("workflow", workflow.id).state).toBe(
      "EXECUTING",
    );
  });
});
