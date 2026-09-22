import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setup } from "../helpers.js";
import {
  CONVERSATION_ERROR,
  CONVERSATION_FILE_LIMITS,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { now } from "../../packages/core/src/util.js";
import {
  ConversationFileService,
  assertConversationAttachmentSet,
  conversationFileContentPath,
} from "../../packages/core/src/conversation-files.js";
import {
  conversationFilePlugin,
  consoleHumanGuard,
} from "../../apps/api/src/routes/conversation-files.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

const opened: Array<{
  app: Awaited<ReturnType<typeof Fastify>>;
  store: ReturnType<typeof setup>["store"];
}> = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.app.close();
    item.store.close();
  }
});

function workflow(id: string): Workflow {
  return {
    id,
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
}

async function startApp(prepare?: (files: ConversationFileService, storageRoot: string) => void) {
  const s = setup();
  s.store.put("workflow", "wf1", "p1", workflow("wf1"));
  s.store.put("workflow", "wf2", "p1", workflow("wf2"));
  const files = new ConversationFileService(s.store, s.config.storage_root);
  prepare?.(files, s.config.storage_root);
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(conversationFilePlugin, {
    files,
    human: consoleHumanGuard,
  });
  await app.ready();
  opened.push({ app, store: s.store });
  return { s, app, files };
}

function jsonHeaders() {
  return { "content-type": "application/json" };
}

describe("SA-I14 conversation file HTTP upload", () => {
  it("uploads real bytes atomically, returns hash, and downloads the same content", async () => {
    const { app } = await startApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "bin-1",
        display_name: "ok.png",
        size: PNG_1X1.length,
        declared_mime: "image/png",
      },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(body.file_id).toBeTruthy();
    expect(body.upload_path).toContain(body.file_id);
    expect(body.limits.maxFileBytes).toBe(CONVERSATION_FILE_LIMITS.maxFileBytes);
    const put = await app.inject({
      method: "PUT",
      url: body.upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: PNG_1X1,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().status).toBe("ready");
    expect(put.json().sha256).toBe(createHash("sha256").update(PNG_1X1).digest("hex"));
    const meta = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${body.file_id}`,
    });
    expect(meta.json().status).toBe("ready");
    expect(meta.json().absolute_path).toBeUndefined();
    const download = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${body.file_id}/content`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toContain("image/png");
    expect(String(download.headers["content-disposition"])).toContain("inline");
    expect(download.rawPayload).toEqual(PNG_1X1);
  });

  it("keeps JSON bodyLimit at 8 MiB while enforcing 20 MiB and 100 MiB file limits", async () => {
    const { app } = await startApp();
    const hugeJson = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "json-too-big",
        display_name: "n".repeat(9 * 1024 * 1024),
        size: 1,
        declared_mime: "text/plain",
      },
    });
    expect(hugeJson.statusCode).toBe(413);
    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "file-too-big",
        display_name: "huge.bin",
        size: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
        declared_mime: "application/octet-stream",
      },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe(CONVERSATION_ERROR.FILE_TOO_LARGE);
    const max = CONVERSATION_FILE_LIMITS.maxFileBytes;
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "max-file",
        display_name: "max.bin",
        size: max,
        declared_mime: "application/octet-stream",
      },
    });
    const overflow = await app.inject({
      method: "PUT",
      url: created.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.alloc(max + 1, 1),
    });
    expect(overflow.statusCode).toBe(413);
    expect(overflow.json().error.code).toBe(CONVERSATION_ERROR.FILE_TOO_LARGE);
    expect(() =>
      assertConversationAttachmentSet([
        { size: 20 * 1024 * 1024 },
        { size: 20 * 1024 * 1024 },
        { size: 20 * 1024 * 1024 },
        { size: 20 * 1024 * 1024 },
        { size: 20 * 1024 * 1024 },
        { size: 1 },
      ]),
    ).toThrow(/总量超过/);
  });
});

describe("SA-I15 conversation file isolation", () => {
  it("rejects cross-workflow access, fake ids, path traversal, and active content inline", async () => {
    const { app } = await startApp();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "svg-1",
        display_name: "../etc/passwd.svg",
        size: svg.length,
        declared_mime: "image/svg+xml",
      },
    });
    await app.inject({
      method: "PUT",
      url: created.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: svg,
    });
    const other = await app.inject({
      method: "GET",
      url: `/api/workflows/wf2/conversation-files/${created.json().file_id}/content`,
    });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe(CONVERSATION_ERROR.FILE_SCOPE_MISMATCH);
    const fake = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversation-files/missing-file/content",
    });
    expect(fake.statusCode).toBe(404);
    const traversal = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversation-files/..%2F..%2Fsecret/content",
    });
    expect(traversal.statusCode).toBeGreaterThanOrEqual(400);
    const download = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${created.json().file_id}/content`,
    });
    expect(String(download.headers["content-disposition"])).toContain("attachment");
    expect(download.headers["content-type"]).toContain("application/octet-stream");
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    const htmlCreated = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "html-1",
        display_name: "x.html",
        size: html.length,
        declared_mime: "text/html",
      },
    });
    await app.inject({
      method: "PUT",
      url: htmlCreated.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: html,
    });
    const htmlDownload = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${htmlCreated.json().file_id}/content`,
    });
    expect(String(htmlDownload.headers["content-disposition"])).toContain("attachment");
    expect(htmlDownload.headers["content-type"]).not.toContain("text/html");
  });

  it("does not mark interrupted uploads as ready", async () => {
    const { app, s } = await startApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "short",
        display_name: "a.bin",
        size: 8,
        declared_mime: "application/octet-stream",
      },
    });
    const put = await app.inject({
      method: "PUT",
      url: created.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("short"),
    });
    expect(put.statusCode).toBe(422);
    const meta = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${created.json().file_id}`,
    });
    expect(meta.json().status).toBe("failed");
    expect(
      existsSync(
        conversationFileContentPath(s.config.storage_root, "wf1", created.json().file_id),
      ),
    ).toBe(false);
  });
});

describe("SA-I16 conversation file idempotency and cleanup", () => {
  it("returns the same file for repeated metadata and does not overwrite ready content", async () => {
    const { app } = await startApp();
    const payload = {
      request_id: "same",
      display_name: "a.txt",
      size: 4,
      declared_mime: "text/plain",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload,
    });
    expect(second.json().file_id).toBe(first.json().file_id);
    await app.inject({
      method: "PUT",
      url: first.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("aaaa"),
    });
    const again = await app.inject({
      method: "PUT",
      url: first.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("bbbb"),
    });
    expect(again.json().sha256).toBe(
      createHash("sha256").update("aaaa").digest("hex"),
    );
    const download = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${first.json().file_id}/content`,
    });
    expect(download.payload).toBe("aaaa");
  });

  it("blocks deleting referenced files and fails leftover part files on startup", async () => {
    let leftoverId = "";
    const { app, files, s } = await startApp((service, storageRoot) => {
      const created = service.createMetadata("wf1", {
        request_id: "part-left",
        display_name: "left.bin",
        size: 3,
        declared_mime: "application/octet-stream",
      });
      leftoverId = created.file_id;
      const path = conversationFileContentPath(storageRoot, "wf1", leftoverId);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path + ".part", "abc");
    });
    expect(files.getMetadata("wf1", leftoverId).status).toBe("failed");
    expect(
      existsSync(conversationFileContentPath(s.config.storage_root, "wf1", leftoverId) + ".part"),
    ).toBe(false);
    const created = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-files",
      headers: jsonHeaders(),
      payload: {
        request_id: "keep",
        display_name: "keep.txt",
        size: 4,
        declared_mime: "text/plain",
      },
    });
    await app.inject({
      method: "PUT",
      url: created.json().upload_path,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("keep"),
    });
    files.referenceMessage("wf1", created.json().file_id, "msg1");
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workflows/wf1/conversation-files/${created.json().file_id}`,
    });
    expect(removed.statusCode).toBe(409);
    expect(removed.json().error.code).toBe(CONVERSATION_ERROR.FILE_IN_USE);
    const tokenDenied = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-files/${created.json().file_id}`,
      headers: { authorization: "Bearer model-token" },
    });
    expect(tokenDenied.statusCode).toBe(403);
  });
});
