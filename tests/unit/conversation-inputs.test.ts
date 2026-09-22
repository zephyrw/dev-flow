import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../helpers.js";
import {
  CONVERSATION_FILE_LIMITS,
  type ConversationFile,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { now } from "../../packages/core/src/util.js";
import {
  ConversationFileService,
  conversationFileContentPath,
  conversationFilesRoot,
} from "../../packages/core/src/conversation-files.js";
import {
  CONVERSATION_INPUT_ERROR,
  attachmentDeliveryStrategy,
  classifyAttachmentReadMode,
  conversationInputIdentity,
  isOfficeMime,
  isPdfMime,
  markConversationInputsDelivered,
  resolveConversationInputAttachments,
  resolveEffectiveMime,
  resumeConversationInputAttachments,
  validateConversationInputReadScope,
  type FileInputCapability,
} from "../../packages/runtime/src/conversation-inputs.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const PDF_BODY = Buffer.from("%PDF-1.4 fixture");
const OFFICE_ZIP = Buffer.from("PK\u0003\u0004office-bytes");
const TEXT_BODY = Buffer.from("hello attachment");
const SVG_BODY = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

const ALL_INPUT: FileInputCapability = {
  text: true,
  image: true,
  binary: true,
};
const IMAGE_ONLY: FileInputCapability = {
  text: false,
  image: true,
  binary: false,
};
const TEXT_ONLY: FileInputCapability = {
  text: true,
  image: false,
  binary: false,
};
const PROFILE: ToolProfile = {
  id: "profile-codex",
  revision: 1,
  adapterId: "codex",
  modelSelection: "native-config",
  options: {},
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
    title: "会话输入",
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
  s.store.put("workflow", "wf2", "p1", { ...workflow, id: "wf2" });
  const files = new ConversationFileService(s.store, s.config.storage_root);
  return { s, files, workflow };
}

async function readyFile(
  files: ConversationFileService,
  extra: {
    request_id: string;
    display_name: string;
    declared_mime: string;
    content: Buffer;
    workflow_id?: string;
  },
) {
  const created = files.createMetadata(extra.workflow_id ?? "wf1", {
    request_id: extra.request_id,
    display_name: extra.display_name,
    size: extra.content.length,
    declared_mime: extra.declared_mime,
  });
  return files.writeContent(
    created.file.workflow_id,
    created.file_id,
    extra.content,
  );
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("SA-D12 conversation input classification", () => {
  it("maps image, text, pdf, office and generic files without converting", () => {
    expect(classifyAttachmentReadMode("image/png")).toBe("image");
    expect(classifyAttachmentReadMode("image/webp")).toBe("image");
    expect(classifyAttachmentReadMode("image/gif")).toBe("image");
    expect(classifyAttachmentReadMode("text/plain")).toBe("text");
    expect(classifyAttachmentReadMode("application/json")).toBe("text");
    expect(classifyAttachmentReadMode("image/svg+xml")).toBe("text");
    expect(classifyAttachmentReadMode("text/html")).toBe("text");
    expect(classifyAttachmentReadMode("application/pdf")).toBe("binary");
    expect(
      classifyAttachmentReadMode(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("binary");
    expect(classifyAttachmentReadMode("application/octet-stream")).toBe("binary");
    expect(attachmentDeliveryStrategy("image")).toBe("inline");
    expect(attachmentDeliveryStrategy("text")).toBe("file");
    expect(attachmentDeliveryStrategy("binary")).toBe("file");
    expect(isPdfMime("application/pdf")).toBe(true);
    expect(
      isOfficeMime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe(true);
  });

  it("keeps declared office type when detection only sees zip", () => {
    const mime = resolveEffectiveMime({
      id: "cfile_office",
      workflow_id: "wf1",
      project_id: "p1",
      request_id: "office",
      display_name: "spec.docx",
      declared_mime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      detected_mime: "application/zip",
      size: 12,
      sha256: "a".repeat(64),
      status: "ready",
      created_at: now(),
      referenced_message_ids: [],
    });
    expect(mime).toContain("wordprocessingml");
    expect(classifyAttachmentReadMode(mime)).toBe("binary");
  });
});

describe("SA-D12 conversation input resolve", () => {
  it("builds a read-only list with id, hash, managed path and mime", async () => {
    const { s, files, workflow } = fixture();
    const png = await readyFile(files, {
      request_id: "png-1",
      display_name: "shot.png",
      declared_mime: "image/png",
      content: PNG_1X1,
    });
    const note = await readyFile(files, {
      request_id: "txt-1",
      display_name: "note.txt",
      declared_mime: "text/plain",
      content: TEXT_BODY,
    });
    const resolved = resolveConversationInputAttachments({
      files: [png, note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.attachments).toHaveLength(2);
    expect(resolved.attachments[0]).toMatchObject({
      id: png.id,
      sha256: sha256(PNG_1X1),
      mime: "image/png",
      read_mode: "image",
      size: PNG_1X1.length,
    });
    expect(resolved.attachments[1]).toMatchObject({
      id: note.id,
      sha256: sha256(TEXT_BODY),
      mime: "text/plain",
      read_mode: "text",
    });
    expect(resolved.attachments[0]!.absolute_path).toContain(
      `${sep}conversation-files${sep}`,
    );
    expect(resolved.extraReadRoots).toHaveLength(2);
    expect(
      resolved.extraReadRoots.every((root) =>
        root.includes(`${sep}conversation-files${sep}`),
      ),
    ).toBe(true);
    expect(resolved.extraReadRoots).not.toContain(s.config.storage_root);
    expect(resolved.extraReadRoots).not.toContain(
      conversationFilesRoot(s.config.storage_root),
    );
    expect(resolved.delivery).toEqual({
      stage: "prepared",
      delivered: false,
      observed: false,
    });
  });

  it("fails unsupported types instead of dropping them", async () => {
    const { s, files, workflow } = fixture();
    const png = await readyFile(files, {
      request_id: "png-2",
      display_name: "shot.png",
      declared_mime: "image/png",
      content: PNG_1X1,
    });
    const pdf = await readyFile(files, {
      request_id: "pdf-1",
      display_name: "spec.pdf",
      declared_mime: "application/pdf",
      content: PDF_BODY,
    });
    const mixed = resolveConversationInputAttachments({
      files: [png, pdf],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: IMAGE_ONLY,
    });
    expect(mixed).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_UNSUPPORTED,
      file_id: pdf.id,
    });
    const textPdf = resolveConversationInputAttachments({
      files: [pdf],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: TEXT_ONLY,
    });
    expect(textPdf).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_UNSUPPORTED,
    });
    expect(s.store.must<Workflow>("workflow", workflow.id).state).toBe(
      "EXECUTING",
    );
  });

  it("accepts pdf, office and generic files only with binary capability", async () => {
    const { s, files, workflow } = fixture();
    const pdf = await readyFile(files, {
      request_id: "pdf-2",
      display_name: "spec.pdf",
      declared_mime: "application/pdf",
      content: PDF_BODY,
    });
    const office = await readyFile(files, {
      request_id: "docx-1",
      display_name: "spec.docx",
      declared_mime:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      content: OFFICE_ZIP,
    });
    const blob = await readyFile(files, {
      request_id: "bin-1",
      display_name: "data.bin",
      declared_mime: "application/octet-stream",
      content: Buffer.from("raw-bytes"),
    });
    const resolved = resolveConversationInputAttachments({
      files: [pdf, office, blob],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.attachments.map((item) => item.read_mode)).toEqual([
      "binary",
      "binary",
      "binary",
    ]);
    expect(resolved.attachments[1]?.mime).toContain("wordprocessingml");
  });

  it("keeps the same id and hash on resume", async () => {
    const { s, files, workflow } = fixture();
    const note = await readyFile(files, {
      request_id: "txt-resume",
      display_name: "note.txt",
      declared_mime: "text/plain",
      content: TEXT_BODY,
    });
    const first = resolveConversationInputAttachments({
      files: [note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    const again = resumeConversationInputAttachments({
      files: [note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(conversationInputIdentity(again.attachments[0]!)).toEqual(
      conversationInputIdentity(first.attachments[0]!),
    );
    expect(again.attachments[0]?.sha256).toBe(sha256(TEXT_BODY));
    expect(again.attachments[0]?.id).toBe(note.id);
  });

  it("rejects unmanaged paths, missing files and workflow mismatch", async () => {
    const { s, files, workflow } = fixture();
    const pending = files.createMetadata("wf1", {
      request_id: "pending-1",
      display_name: "later.txt",
      size: 4,
      declared_mime: "text/plain",
    }).file;
    const notReady = resolveConversationInputAttachments({
      files: [pending],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(notReady).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
    });
    const note = await readyFile(files, {
      request_id: "txt-scope",
      display_name: "note.txt",
      declared_mime: "text/plain",
      content: TEXT_BODY,
    });
    const mismatch = resolveConversationInputAttachments({
      files: [note],
      storageRoot: s.config.storage_root,
      workflowId: "wf2",
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(mismatch).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.FILE_SCOPE_MISMATCH,
    });
    const userDir = join(tmpdir(), `user-input-${Date.now()}`);
    mkdirSync(userDir, { recursive: true });
    const userFile = join(userDir, "secret.txt");
    writeFileSync(userFile, "no");
    expect(
      validateConversationInputReadScope(s.config.storage_root, [userDir]).ok,
    ).toBe(false);
    expect(
      validateConversationInputReadScope(s.config.storage_root, [
        s.config.storage_root,
      ]),
    ).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
    });
    expect(
      validateConversationInputReadScope(s.config.storage_root, [
        conversationFilesRoot(s.config.storage_root),
      ]),
    ).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
    });
  });

  it("marks delivered as passed-in only, never observed", async () => {
    const { s, files, workflow } = fixture();
    const note = await readyFile(files, {
      request_id: "txt-delivered",
      display_name: "note.txt",
      declared_mime: "text/plain",
      content: TEXT_BODY,
    });
    const resolved = resolveConversationInputAttachments({
      files: [note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const delivered = markConversationInputsDelivered(resolved);
    expect(delivered.delivery).toEqual({
      stage: "delivered",
      delivered: true,
      observed: false,
    });
    expect(delivered.attachments[0]?.id).toBe(note.id);
  });

  it("rejects invalid frozen profile and over-limit sets", () => {
    const tooMany = Array.from({ length: 11 }, (_, index) => ({
      id: `cfile_${index}`,
      workflow_id: "wf1",
      project_id: "p1",
      request_id: `n-${index}`,
      display_name: `n${index}.txt`,
      declared_mime: "text/plain",
      size: 1,
      sha256: "a".repeat(64),
      status: "ready" as const,
      created_at: now(),
      referenced_message_ids: [],
    }));
    const counted = resolveConversationInputAttachments({
      files: tooMany as ConversationFile[],
      storageRoot: tmpdir(),
      workflowId: "wf1",
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(counted).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.TOO_MANY_FILES,
    });
    const huge = resolveConversationInputAttachments({
      files: [
        {
          ...tooMany[0]!,
          size: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
        },
      ] as ConversationFile[],
      storageRoot: tmpdir(),
      workflowId: "wf1",
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(huge).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.FILE_TOO_LARGE,
    });
    const noProfile = resolveConversationInputAttachments({
      files: [],
      storageRoot: tmpdir(),
      workflowId: "wf1",
      profile: { id: "bad" } as ToolProfile,
      fileInput: ALL_INPUT,
    });
    expect(noProfile).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.PROFILE_NOT_FOUND,
    });
  });

  it("does not treat svg as native image input", async () => {
    const { s, files, workflow } = fixture();
    const svg = await readyFile(files, {
      request_id: "svg-1",
      display_name: "icon.svg",
      declared_mime: "image/svg+xml",
      content: SVG_BODY,
    });
    const asImage = resolveConversationInputAttachments({
      files: [svg],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: IMAGE_ONLY,
    });
    expect(asImage).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.INPUT_UNSUPPORTED,
    });
    const asText = resolveConversationInputAttachments({
      files: [svg],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: TEXT_ONLY,
    });
    expect(asText.ok).toBe(true);
    if (!asText.ok) return;
    expect(asText.attachments[0]?.read_mode).toBe("text");
    expect(attachmentDeliveryStrategy(asText.attachments[0]!.read_mode)).toBe(
      "file",
    );
    expect(
      relative(
        conversationFilesRoot(s.config.storage_root),
        asText.extraReadRoots[0]!,
      ).split(sep),
    ).toHaveLength(2);
  });

  it("fails before any workflow change when disk content is missing or altered", async () => {
    const { s, files, workflow } = fixture();
    const note = await readyFile(files, {
      request_id: "txt-missing",
      display_name: "note.txt",
      declared_mime: "text/plain",
      content: TEXT_BODY,
    });
    const path = conversationFileContentPath(
      s.config.storage_root,
      note.workflow_id,
      note.id,
    );
    writeFileSync(path, "tampered");
    const altered = resolveConversationInputAttachments({
      files: [note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(altered).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
    });
    unlinkSync(path);
    const missing = resolveConversationInputAttachments({
      files: [note],
      storageRoot: s.config.storage_root,
      workflowId: workflow.id,
      profile: PROFILE,
      fileInput: ALL_INPUT,
    });
    expect(missing).toMatchObject({
      ok: false,
      code: CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
    });
    expect(s.store.must<Workflow>("workflow", workflow.id).state).toBe(
      "EXECUTING",
    );
  });
});
