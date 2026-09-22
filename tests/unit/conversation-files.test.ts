import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { Readable } from "node:stream";
import { setup } from "../helpers.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  CONVERSATION_FILE_LIMITS,
  FlowError,
  type ConversationFile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { now } from "../../packages/core/src/util.js";
import {
  ConversationFileService,
  assertConversationAttachmentSet,
  conversationFileContentPath,
  detectConversationMime,
  resolveDownloadHeaders,
} from "../../packages/core/src/conversation-files.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG_BODY = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HTML_BODY = Buffer.from("<!DOCTYPE html><html><body>hi</body></html>");

const opened: Array<ReturnType<typeof setup>> = [];

afterEach(() => {
  for (const s of opened.splice(0)) s.store.close();
});

function fixture() {
  const s = setup();
  opened.push(s);
  const workflow: Workflow = {
    id: "wf1",
    project_id: "p1",
    title: "会话文件",
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

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function createPending(
  files: ConversationFileService,
  extra: Partial<{
    request_id: string;
    display_name: string;
    size: number;
    declared_mime: string;
    workflow_id: string;
  }> = {},
) {
  const content = extra.size !== undefined ? Buffer.alloc(extra.size, 97) : Buffer.from("hello");
  return files.createMetadata(extra.workflow_id ?? "wf1", {
    request_id: extra.request_id ?? `req-${crypto.randomUUID()}`,
    display_name: extra.display_name ?? "note.txt",
    size: extra.size ?? content.length,
    declared_mime: extra.declared_mime ?? "text/plain",
  });
}

async function upload(
  files: ConversationFileService,
  created: ReturnType<ConversationFileService["createMetadata"]>,
  content: Buffer,
) {
  return files.writeContent(created.file.workflow_id, created.file_id, content);
}

function codeOf(error: unknown): string {
  return error instanceof FlowError ? error.code : "";
}

describe("SA-U10 conversation files", () => {
  it("rejects file count, per-file size and total size", () => {
    expect(() =>
      assertConversationAttachmentSet(Array.from({ length: 11 }, () => ({ size: 1 }))),
    ).toThrow(/最多 10 个附件/);
    expect(() =>
      assertConversationAttachmentSet(
        Array.from({ length: 10 }, () => ({ size: 1 })),
      ),
    ).not.toThrow();
    expect(() =>
      assertConversationAttachmentSet([
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes + 1 },
      ]),
    ).toThrow(FlowError);
    try {
      assertConversationAttachmentSet([
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes + 1 },
      ]);
    } catch (error) {
      expect(codeOf(error)).toBe(CONVERSATION_ERROR.FILE_TOO_LARGE);
    }
    expect(() =>
      assertConversationAttachmentSet([
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes },
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes },
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes },
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes },
        { size: CONVERSATION_FILE_LIMITS.maxFileBytes },
        { size: 1 },
      ]),
    ).toThrow(/总量超过/);
    const { files } = fixture();
    expect(() =>
      files.createMetadata("wf1", {
        request_id: "too-big",
        display_name: "huge.bin",
        size: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
        declared_mime: "application/octet-stream",
      }),
    ).toThrow(FlowError);
    try {
      files.createMetadata("wf1", {
        request_id: "too-big-2",
        display_name: "huge.bin",
        size: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
        declared_mime: "application/octet-stream",
      });
    } catch (error) {
      expect(codeOf(error)).toBe(CONVERSATION_ERROR.FILE_TOO_LARGE);
    }
  });

  it("stores display_name as metadata only and rejects invalid names", async () => {
    const { s, files } = fixture();
    expect(() =>
      files.createMetadata("wf1", {
        request_id: "empty-name",
        display_name: "",
        size: 1,
        declared_mime: "text/plain",
      }),
    ).toThrow();
    expect(() =>
      files.createMetadata("wf1", {
        request_id: "long-name",
        display_name: "n".repeat(256),
        size: 1,
        declared_mime: "text/plain",
      }),
    ).toThrow();
    const body = Buffer.from("payload");
    const created = createPending(files, {
      display_name: `CON${sep}..${sep}etc${sep}passwd.jpg.exe`,
      size: body.length,
    });
    const ready = await upload(files, created, body);
    expect(ready.display_name).toBe(`CON${sep}..${sep}etc${sep}passwd.jpg.exe`);
    const path = conversationFileContentPath(
      s.config.storage_root,
      ready.workflow_id,
      ready.id,
    );
    expect(basename(path)).toBe("content");
    expect(basename(dirname(path))).toBe(ready.id);
    expect(path).toContain(`${sep}conversation-files${sep}`);
    expect(path).not.toContain(`${sep}attachments${sep}`);
    expect(readFileSync(path)).toEqual(body);
  });

  it("detects MIME and only inlines matching PNG/JPEG", async () => {
    expect(detectConversationMime(PNG_1X1)).toBe("image/png");
    expect(detectConversationMime(JPEG_HEAD)).toBe("image/jpeg");
    expect(detectConversationMime(SVG_BODY)).toBe("image/svg+xml");
    expect(detectConversationMime(HTML_BODY)).toBe("text/html");
    const { files } = fixture();
    const png = createPending(files, {
      display_name: "ok.png",
      size: PNG_1X1.length,
      declared_mime: "image/png",
    });
    const pngReady = await upload(files, png, PNG_1X1);
    expect(pngReady.detected_mime).toBe("image/png");
    expect(resolveDownloadHeaders(pngReady)).toMatchObject({
      contentType: "image/png",
      disposition: "inline",
    });
    const mismatched = createPending(files, {
      display_name: "fake.jpg",
      size: PNG_1X1.length,
      declared_mime: "image/jpeg",
    });
    const mismatchedReady = await upload(files, mismatched, PNG_1X1);
    expect(mismatchedReady.detected_mime).toBe("image/png");
    expect(resolveDownloadHeaders(mismatchedReady).disposition).toBe("attachment");
    const svg = createPending(files, {
      display_name: "x.svg",
      size: SVG_BODY.length,
      declared_mime: "image/svg+xml",
    });
    const svgReady = await upload(files, svg, SVG_BODY);
    expect(resolveDownloadHeaders(svgReady)).toMatchObject({
      contentType: "application/octet-stream",
      disposition: "attachment",
    });
    const html = createPending(files, {
      display_name: "x.html",
      size: HTML_BODY.length,
      declared_mime: "text/html",
    });
    const htmlReady = await upload(files, html, HTML_BODY);
    expect(resolveDownloadHeaders(htmlReady).disposition).toBe("attachment");
    expect(resolveDownloadHeaders(htmlReady).contentType).toBe(
      "application/octet-stream",
    );
  });

  it("computes SHA-256 and requires ready content before opening", async () => {
    const { s, files } = fixture();
    const body = Buffer.from("hash-me");
    const created = createPending(files, { size: body.length });
    expect(created.file.status).toBe("pending");
    expect(created.upload_path).toBe(
      `/api/workflows/wf1/conversation-files/${created.file_id}/content`,
    );
    expect(created.limits).toEqual(CONVERSATION_FILE_LIMITS);
    try {
      files.openContent("wf1", created.file_id);
      throw new Error("expected not ready");
    } catch (error) {
      expect(codeOf(error)).toBe(CONVERSATION_ERROR.FILE_NOT_READY);
    }
    const ready = await files.writeContent(
      "wf1",
      created.file_id,
      Readable.from([body.subarray(0, 3), body.subarray(3)]),
    );
    expect(ready.status).toBe("ready");
    expect(ready.sha256).toBe(sha256(body));
    expect(existsSync(conversationFileContentPath(s.config.storage_root, "wf1", ready.id))).toBe(
      true,
    );
    expect(existsSync(join(dirname(conversationFileContentPath(s.config.storage_root, "wf1", ready.id)), "content.part"))).toBe(
      false,
    );
  });

  it("does not overwrite a ready file with different content", async () => {
    const { s, files } = fixture();
    const first = Buffer.from("aaaaa");
    const second = Buffer.from("bbbbb");
    const created = createPending(files, { size: first.length });
    const ready = await upload(files, created, first);
    const again = await files.writeContent("wf1", created.file_id, second);
    expect(again.status).toBe("ready");
    expect(again.sha256).toBe(sha256(first));
    expect(readFileSync(conversationFileContentPath(s.config.storage_root, "wf1", created.file_id)).toString()).toBe(
      "aaaaa",
    );
  });

  it("keeps failed uploads without a ready file and allows retry", async () => {
    const { s, files } = fixture();
    const created = createPending(files, { size: 5 });
    await expect(files.writeContent("wf1", created.file_id, Buffer.from("no"))).rejects.toThrow(
      /申报不一致/,
    );
    const failed = files.getMetadata("wf1", created.file_id);
    expect(failed.status).toBe("failed");
    expect(
      existsSync(conversationFileContentPath(s.config.storage_root, "wf1", created.file_id)),
    ).toBe(false);
    const ready = await files.writeContent("wf1", created.file_id, Buffer.from("abcde"));
    expect(ready.status).toBe("ready");
    expect(ready.sha256).toBe(sha256(Buffer.from("abcde")));
  });

  it("refuses to delete a referenced file", async () => {
    const { files } = fixture();
    const created = createPending(files, { size: 4 });
    await upload(files, created, Buffer.from("data"));
    files.referenceMessage("wf1", created.file_id, "msg1");
    files.referenceMessage("wf1", created.file_id, "msg1");
    try {
      files.deleteDraft("wf1", created.file_id);
      throw new Error("expected in use");
    } catch (error) {
      expect(codeOf(error)).toBe(CONVERSATION_ERROR.FILE_IN_USE);
    }
    expect(files.getMetadata("wf1", created.file_id).status).toBe("ready");
    expect(files.getMetadata("wf1", created.file_id).referenced_message_ids).toEqual([
      "msg1",
    ]);
  });

  it("TTL cleanup skips referenced files and removes unreferenced drafts", async () => {
    const { s, files } = fixture();
    const staleUnref = createPending(files, { request_id: "old-draft", size: 3 });
    await upload(files, staleUnref, Buffer.from("old"));
    const staleRef = createPending(files, { request_id: "old-ref", size: 3 });
    await upload(files, staleRef, Buffer.from("ref"));
    files.referenceMessage("wf1", staleRef.file_id, "msg-keep");
    const fresh = createPending(files, { request_id: "fresh", size: 3 });
    await upload(files, fresh, Buffer.from("new"));
    const staleAt = new Date(Date.now() - CONVERSATION_FILE_LIMITS.draftTtlMs - 1000).toISOString();
    for (const fileId of [staleUnref.file_id, staleRef.file_id]) {
      const record = s.store.must<ConversationFile>(CONVERSATION_ENTITY.file, fileId);
      s.store.put(CONVERSATION_ENTITY.file, fileId, "wf1", {
        ...record,
        created_at: staleAt,
      });
    }
    const removed = files.cleanupExpiredDrafts();
    expect(removed).toContain(staleUnref.file_id);
    expect(removed).not.toContain(staleRef.file_id);
    expect(removed).not.toContain(fresh.file_id);
    expect(files.getMetadata("wf1", staleUnref.file_id).status).toBe("deleted");
    expect(files.getMetadata("wf1", staleRef.file_id).status).toBe("ready");
    expect(files.getMetadata("wf1", fresh.file_id).status).toBe("ready");
    expect(
      existsSync(conversationFileContentPath(s.config.storage_root, "wf1", staleUnref.file_id)),
    ).toBe(false);
    expect(
      existsSync(conversationFileContentPath(s.config.storage_root, "wf1", staleRef.file_id)),
    ).toBe(true);
  });

  it("rechecks references immediately before TTL deletion", async () => {
    const { s, files } = fixture();
    const created = createPending(files, { size: 3 });
    await upload(files, created, Buffer.from("ttl"));
    const record = s.store.must<ConversationFile>(CONVERSATION_ENTITY.file, created.file_id);
    s.store.put(CONVERSATION_ENTITY.file, created.file_id, "wf1", {
      ...record,
      created_at: new Date(Date.now() - CONVERSATION_FILE_LIMITS.draftTtlMs - 1000).toISOString(),
    });
    files.referenceMessage("wf1", created.file_id, "late-ref");
    expect(files.cleanupExpiredDrafts()).toEqual([]);
    expect(files.getMetadata("wf1", created.file_id).status).toBe("ready");
  });

  it("marks leftover part files as failed without promoting them to ready", () => {
    const { s, files } = fixture();
    const created = createPending(files, { size: 5 });
    const contentPath = conversationFileContentPath(
      s.config.storage_root,
      "wf1",
      created.file_id,
    );
    mkdirSync(dirname(contentPath), { recursive: true });
    writeFileSync(contentPath + ".part", "abcde");
    const failed = files.failLeftoverParts();
    expect(failed).toContain(created.file_id);
    expect(files.getMetadata("wf1", created.file_id).status).toBe("failed");
    expect(existsSync(contentPath)).toBe(false);
    expect(existsSync(contentPath + ".part")).toBe(false);
  });

  it("rejects files from another workflow and returns the same file for identical requests", async () => {
    const { files } = fixture();
    const body = Buffer.from("same");
    const first = createPending(files, { request_id: "dup", size: body.length });
    const second = createPending(files, { request_id: "dup", size: body.length });
    expect(second.file_id).toBe(first.file_id);
    expect(() =>
      files.createMetadata("wf1", {
        request_id: "dup",
        display_name: "other.txt",
        size: body.length,
        declared_mime: "text/plain",
      }),
    ).toThrow(/元数据不同/);
    await upload(files, first, body);
    try {
      files.getMetadata("wf2", first.file_id);
      throw new Error("expected scope mismatch");
    } catch (error) {
      expect(codeOf(error)).toBe(CONVERSATION_ERROR.FILE_SCOPE_MISMATCH);
    }
    const deleted = files.deleteDraft("wf1", first.file_id);
    expect(deleted.status).toBe("deleted");
  });
});
