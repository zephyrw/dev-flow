import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import type { Store } from "../../store/src/store.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  CONVERSATION_FILE_LIMITS,
  ConversationFileSchema,
  CreateConversationFileRequestSchema,
  FlowError,
  Id,
  fileWithinConversationLimits,
  requireCondition,
  type ConversationFile,
  type CreateConversationFileRequest,
  type Workflow,
} from "../../contracts/src/index.js";
import { id, now, objectHash } from "./util.js";

export const CONVERSATION_FILES_DIR = "conversation-files";
export const CONVERSATION_FILE_CONTENT = "content";
export const CONVERSATION_FILE_PART = "content.part";

const INLINE_MIMES = new Set(["image/png", "image/jpeg"]);
const ACTIVE_MIMES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);
const HEAD_BYTES = 512;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ConversationFileSource =
  | Readable
  | AsyncIterable<Buffer | Uint8Array | string>
  | Buffer
  | Uint8Array;

export interface CreateConversationFileResult {
  file_id: string;
  upload_path: string;
  limits: typeof CONVERSATION_FILE_LIMITS;
  file: ConversationFile;
}

export interface ConversationDownloadHeaders {
  contentType: string;
  contentDisposition: string;
  disposition: "inline" | "attachment";
}

export interface ConversationContentOpen {
  file: ConversationFile;
  absolutePath: string;
  headers: ConversationDownloadHeaders;
}

interface PersistedUpload {
  bytes: number;
  sha256: string;
  head: Buffer;
  finalPath: string;
}

export function conversationFilesRoot(storageRoot: string): string {
  return resolve(storageRoot, CONVERSATION_FILES_DIR);
}

export function conversationFileDir(
  storageRoot: string,
  workflowId: string,
  fileId: string,
): string {
  return join(
    conversationFilesRoot(storageRoot),
    Id.parse(workflowId),
    Id.parse(fileId),
  );
}

export function conversationFileContentPath(
  storageRoot: string,
  workflowId: string,
  fileId: string,
): string {
  return join(
    conversationFileDir(storageRoot, workflowId, fileId),
    CONVERSATION_FILE_CONTENT,
  );
}

export function isPathInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  const actual = resolve(candidate);
  const rel = relative(base, actual);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../");
}

export function detectConversationMime(head: Buffer): string {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE))
    return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return "image/jpeg";
  if (head.length >= 6 && gifSignature(head)) return "image/gif";
  if (webpSignature(head)) return "image/webp";
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-")
    return "application/pdf";
  const text = head.subarray(0, HEAD_BYTES).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (looksLikeSvg(text)) return "image/svg+xml";
  if (looksLikeHtml(text)) return "text/html";
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return "application/zip";
  return "application/octet-stream";
}

export function resolveDownloadHeaders(
  file: ConversationFile,
): ConversationDownloadHeaders {
  const detected = file.detected_mime;
  const declared = file.declared_mime;
  if (isActiveContent(detected) || isActiveContent(declared)) {
    return downloadHeaders("application/octet-stream", "attachment", file.display_name);
  }
  if (detected && INLINE_MIMES.has(detected) && detected === declared) {
    return downloadHeaders(detected, "inline", file.display_name);
  }
  return downloadHeaders(
    detected || declared || "application/octet-stream",
    "attachment",
    file.display_name,
  );
}

export function assertConversationAttachmentSet(
  files: Array<Pick<ConversationFile, "size">>,
): void {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    const one = fileWithinConversationLimits({
      fileCount: 1,
      fileBytes: file.size,
      totalBytes: file.size,
    });
    requireCondition(
      one !== "file_too_large",
      CONVERSATION_ERROR.FILE_TOO_LARGE,
      "单个附件超过 20 MiB",
      413,
    );
  }
  const all = fileWithinConversationLimits({
    fileCount: files.length,
    fileBytes: files[0]?.size ?? 0,
    totalBytes,
  });
  requireCondition(all !== "too_many", "TOO_MANY_FILES", "每条消息最多 10 个附件", 422);
  requireCondition(
    all !== "total_too_large",
    CONVERSATION_ERROR.FILE_TOO_LARGE,
    "附件总量超过 100 MiB",
    413,
  );
}

export function publicConversationFile(file: ConversationFile): ConversationFile {
  return ConversationFileSchema.parse({
    id: file.id,
    workflow_id: file.workflow_id,
    project_id: file.project_id,
    request_id: file.request_id,
    display_name: file.display_name,
    declared_mime: file.declared_mime,
    detected_mime: file.detected_mime,
    size: file.size,
    sha256: file.sha256,
    status: file.status,
    created_at: file.created_at,
    ready_at: file.ready_at,
    referenced_message_ids: file.referenced_message_ids ?? [],
  });
}

export class ConversationFileService {
  constructor(
    private store: Store,
    private storageRoot: string,
  ) {}

  createMetadata(
    workflowId: string,
    input: CreateConversationFileRequest,
  ): CreateConversationFileResult {
    const workflow = this.store.must<Workflow>("workflow", Id.parse(workflowId));
    if (typeof input.size === "number") this.assertDeclaredSize(input.size);
    const request = CreateConversationFileRequestSchema.parse(input);
    assertDisplayName(request.display_name);
    const key = idempotencyKey(workflow.id, request.request_id);
    const payloadHash = objectHash({
      display_name: request.display_name,
      size: request.size,
      declared_mime: request.declared_mime,
    });
    return this.store.transaction(() => {
      const prior = this.store.get<{ file_id: string; payload_hash: string }>(
        "idempotency_record",
        key,
      );
      if (prior) {
        requireCondition(
          prior.payload_hash === payloadHash,
          "IDEMPOTENCY_CONFLICT",
          "相同请求 ID 的文件元数据不同",
          409,
        );
        return this.toCreateResult(
          this.requireFileInWorkflow(workflow.id, prior.file_id),
        );
      }
      const file = this.insertPending(workflow, request);
      this.store.put("idempotency_record", key, workflow.id, {
        file_id: file.id,
        payload_hash: payloadHash,
        created_at: now(),
      });
      return this.toCreateResult(file);
    });
  }

  async writeContent(
    workflowId: string,
    fileId: string,
    source: ConversationFileSource,
    contentLength?: number,
  ): Promise<ConversationFile> {
    const file = this.requireFileInWorkflow(workflowId, fileId);
    if (file.status === "ready") {
      await discardSource(source);
      return publicConversationFile(file);
    }
    this.assertCanUpload(file);
    this.precheckContentLength(file, contentLength);
    const uploading = this.saveFile({ ...file, status: "uploading" });
    try {
      const saved = await this.persistUpload(uploading, source);
      return this.completeReady(uploading, saved);
    } catch (error) {
      await discardSource(source);
      this.failUpload(uploading);
      throw mapWriteError(error);
    }
  }

  getMetadata(workflowId: string, fileId: string): ConversationFile {
    return publicConversationFile(this.requireFileInWorkflow(workflowId, fileId));
  }

  openContent(workflowId: string, fileId: string): ConversationContentOpen {
    const file = this.requireFileInWorkflow(workflowId, fileId);
    requireCondition(
      file.status === "ready",
      CONVERSATION_ERROR.FILE_NOT_READY,
      "文件尚未上传完成",
      409,
    );
    const absolutePath = this.readyAbsolutePath(file);
    return {
      file: publicConversationFile(file),
      absolutePath,
      headers: resolveDownloadHeaders(file),
    };
  }

  deleteDraft(workflowId: string, fileId: string): ConversationFile {
    const file = this.requireFileInWorkflow(workflowId, fileId);
    requireCondition(
      (file.referenced_message_ids ?? []).length === 0,
      CONVERSATION_ERROR.FILE_IN_USE,
      "已被消息引用的文件不能删除",
      409,
    );
    this.removeDisk(file.workflow_id, file.id);
    return this.saveFile({ ...file, status: "deleted" });
  }

  referenceMessage(
    workflowId: string,
    fileId: string,
    messageId: string,
  ): ConversationFile {
    const file = this.requireFileInWorkflow(workflowId, fileId);
    requireCondition(
      file.status === "ready",
      CONVERSATION_ERROR.FILE_NOT_READY,
      "只有已就绪的文件才能绑定消息",
      409,
    );
    const refs = file.referenced_message_ids ?? [];
    if (refs.includes(messageId)) return publicConversationFile(file);
    return this.saveFile({
      ...file,
      referenced_message_ids: [...refs, Id.parse(messageId)],
    });
  }

  cleanupExpiredDrafts(nowMs = Date.now()): string[] {
    const cutoff = nowMs - CONVERSATION_FILE_LIMITS.draftTtlMs;
    const removed: string[] = [];
    for (const file of this.store.list<ConversationFile>(CONVERSATION_ENTITY.file)) {
      if (!this.shouldExpire(file, cutoff)) continue;
      const latest = this.store.get<ConversationFile>(CONVERSATION_ENTITY.file, file.id);
      if (!latest || !this.shouldExpire(latest, cutoff)) continue;
      this.removeDisk(latest.workflow_id, latest.id);
      this.saveFile({ ...latest, status: "deleted" });
      removed.push(latest.id);
    }
    return removed;
  }

  failLeftoverParts(): string[] {
    const failed: string[] = [];
    const root = this.ensureFilesRoot();
    for (const workflowId of readDirNames(root)) {
      if (!Id.safeParse(workflowId).success) continue;
      const workflowDir = join(root, workflowId);
      for (const fileId of readDirNames(workflowDir)) {
        if (!Id.safeParse(fileId).success) continue;
        const marked = this.failLeftoverInDir(workflowId, fileId);
        if (marked) failed.push(fileId);
      }
    }
    return failed;
  }

  requireFileInWorkflow(workflowId: string, fileId: string): ConversationFile {
    const file = this.store.get<ConversationFile>(
      CONVERSATION_ENTITY.file,
      Id.parse(fileId),
    );
    requireCondition(file, CONVERSATION_ERROR.NOT_FOUND, "会话文件不存在", 404);
    requireCondition(
      file.workflow_id === Id.parse(workflowId),
      CONVERSATION_ERROR.FILE_SCOPE_MISMATCH,
      "文件不属于当前工作流",
      409,
    );
    return file;
  }

  private insertPending(
    workflow: Workflow,
    request: CreateConversationFileRequest,
  ): ConversationFile {
    const file = publicConversationFile({
      id: id("cfile"),
      workflow_id: workflow.id,
      project_id: workflow.project_id,
      request_id: request.request_id,
      display_name: request.display_name,
      declared_mime: request.declared_mime,
      size: request.size,
      status: "pending",
      created_at: now(),
      referenced_message_ids: [],
    });
    this.store.put(CONVERSATION_ENTITY.file, file.id, workflow.id, file);
    return file;
  }

  private toCreateResult(file: ConversationFile): CreateConversationFileResult {
    const publicFile = publicConversationFile(file);
    return {
      file_id: publicFile.id,
      upload_path: `/api/workflows/${publicFile.workflow_id}/conversation-files/${publicFile.id}/content`,
      limits: CONVERSATION_FILE_LIMITS,
      file: publicFile,
    };
  }

  private assertDeclaredSize(size: number) {
    requireCondition(
      size <= CONVERSATION_FILE_LIMITS.maxFileBytes,
      CONVERSATION_ERROR.FILE_TOO_LARGE,
      "单个附件超过 20 MiB",
      413,
    );
  }

  private assertCanUpload(file: ConversationFile) {
    requireCondition(
      file.status !== "deleted",
      CONVERSATION_ERROR.NOT_FOUND,
      "会话文件不存在",
      404,
    );
    requireCondition(
      file.status === "pending" || file.status === "failed",
      "VERSION_CONFLICT",
      "文件正在上传或已就绪",
      409,
    );
  }

  private precheckContentLength(file: ConversationFile, contentLength?: number) {
    if (contentLength === undefined || Number.isNaN(contentLength)) return;
    requireCondition(
      contentLength <= CONVERSATION_FILE_LIMITS.maxFileBytes &&
        contentLength <= file.size,
      CONVERSATION_ERROR.FILE_TOO_LARGE,
      "单个附件超过 20 MiB",
      413,
    );
  }

  private async persistUpload(
    file: ConversationFile,
    source: ConversationFileSource,
  ): Promise<PersistedUpload> {
    const dir = this.ensureFileDir(file.workflow_id, file.id);
    const partPath = join(dir, CONVERSATION_FILE_PART);
    const finalPath = join(dir, CONVERSATION_FILE_CONTENT);
    removeIfExists(partPath);
    removeIfExists(finalPath);
    const written = await writePartFile(source, partPath, {
      maxBytes: CONVERSATION_FILE_LIMITS.maxFileBytes,
      expectedBytes: file.size,
    });
    this.assertStoredPath(partPath);
    renameSync(partPath, finalPath);
    this.assertStoredPath(finalPath);
    return { ...written, finalPath };
  }

  private completeReady(
    file: ConversationFile,
    saved: PersistedUpload,
  ): ConversationFile {
    return this.saveFile({
      ...file,
      status: "ready",
      size: saved.bytes,
      sha256: saved.sha256,
      detected_mime: detectConversationMime(saved.head),
      ready_at: now(),
    });
  }

  private failUpload(file: ConversationFile) {
    this.removeDisk(file.workflow_id, file.id);
    const latest = this.store.get<ConversationFile>(CONVERSATION_ENTITY.file, file.id);
    if (!latest || latest.status === "ready" || latest.status === "deleted") return;
    this.saveFile({
      ...latest,
      status: "failed",
      sha256: undefined,
      detected_mime: undefined,
      ready_at: undefined,
    });
  }

  private failLeftoverInDir(workflowId: string, fileId: string): boolean {
    const dir = join(this.ensureFilesRoot(), workflowId, fileId);
    const partPath = join(dir, CONVERSATION_FILE_PART);
    const contentPath = join(dir, CONVERSATION_FILE_CONTENT);
    const file = this.store.get<ConversationFile>(CONVERSATION_ENTITY.file, fileId);
    const leftoverPart = existsSync(partPath);
    const strayContent = existsSync(contentPath) && file?.status !== "ready";
    if (!leftoverPart && !strayContent) return false;
    removeIfExists(partPath);
    if (strayContent) removeIfExists(contentPath);
    if (!file || file.workflow_id !== workflowId) return leftoverPart || strayContent;
    if (file.status === "ready" || file.status === "deleted") return leftoverPart;
    this.saveFile({
      ...file,
      status: "failed",
      sha256: undefined,
      detected_mime: undefined,
      ready_at: undefined,
    });
    return true;
  }

  private shouldExpire(file: ConversationFile, cutoff: number): boolean {
    if (file.status === "deleted") return false;
    if ((file.referenced_message_ids ?? []).length > 0) return false;
    if (file.status !== "pending" && file.status !== "failed" && file.status !== "ready")
      return false;
    return Date.parse(file.created_at) <= cutoff;
  }

  private readyAbsolutePath(file: ConversationFile): string {
    const path = conversationFileContentPath(
      this.storageRoot,
      file.workflow_id,
      file.id,
    );
    requireCondition(existsSync(path), CONVERSATION_ERROR.FILE_NOT_READY, "文件内容不存在", 409);
    const actual = realpathSync(path);
    this.assertStoredPath(actual);
    return actual;
  }

  private ensureFilesRoot(): string {
    const root = conversationFilesRoot(this.storageRoot);
    mkdirSync(root, { recursive: true });
    return realpathSync(root);
  }

  private ensureFileDir(workflowId: string, fileId: string): string {
    const dir = conversationFileDir(this.storageRoot, workflowId, fileId);
    mkdirSync(dir, { recursive: true });
    this.assertStoredPath(dir);
    return dir;
  }

  private assertStoredPath(candidate: string) {
    const root = this.ensureFilesRoot();
    const actual = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
    requireCondition(
      isPathInside(root, actual),
      "PATH_ESCAPE",
      "实际路径越界",
      403,
    );
  }

  private removeDisk(workflowId: string, fileId: string) {
    const dir = conversationFileDir(this.storageRoot, workflowId, fileId);
    if (!existsSync(dir)) return;
    this.assertStoredPath(dir);
    rmSync(dir, { recursive: true, force: true });
  }

  private saveFile(file: ConversationFile): ConversationFile {
    const publicFile = publicConversationFile(file);
    this.store.put(CONVERSATION_ENTITY.file, publicFile.id, publicFile.workflow_id, publicFile);
    return publicFile;
  }
}

function idempotencyKey(workflowId: string, requestId: string): string {
  return `conversation-file:${workflowId}:${requestId}`;
}

function assertDisplayName(name: string) {
  requireCondition(name.length > 0 && name.length <= 255, "VALIDATION_ERROR", "文件名无效", 422);
  requireCondition(!name.includes("\0"), "VALIDATION_ERROR", "文件名无效", 422);
}

function gifSignature(head: Buffer): boolean {
  const tag = head.subarray(0, 6).toString("latin1");
  return tag === "GIF87a" || tag === "GIF89a";
}

function webpSignature(head: Buffer): boolean {
  return (
    head.length >= 12 &&
    head.subarray(0, 4).toString("latin1") === "RIFF" &&
    head.subarray(8, 12).toString("latin1") === "WEBP"
  );
}

function looksLikeSvg(text: string): boolean {
  const lower = text.slice(0, HEAD_BYTES).toLowerCase();
  return lower.startsWith("<svg") || (lower.startsWith("<?xml") && lower.includes("<svg"));
}

function looksLikeHtml(text: string): boolean {
  const lower = text.slice(0, HEAD_BYTES).toLowerCase();
  return lower.startsWith("<!doctype html") || lower.startsWith("<html");
}

function isActiveContent(mime: string | undefined): boolean {
  return !!mime && ACTIVE_MIMES.has(mime.split(";")[0]!.trim().toLowerCase());
}

function downloadHeaders(
  contentType: string,
  disposition: "inline" | "attachment",
  displayName: string,
): ConversationDownloadHeaders {
  return {
    contentType,
    disposition,
    contentDisposition: formatContentDisposition(disposition, displayName),
  };
}

export function formatContentDisposition(
  disposition: "inline" | "attachment",
  displayName: string,
): string {
  const fallback =
    displayName.replace(/[\r\n"]/g, "_").replace(/[^\x20-\x7E]/g, "_") || "file";
  const encoded = encodeURIComponent(displayName);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function mapWriteError(error: unknown): FlowError {
  if (error instanceof FlowError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOSPC")
    return new FlowError("STORAGE_FULL", "磁盘空间不足", 500);
  if (code === "EACCES" || code === "EPERM")
    return new FlowError("STORAGE_DENIED", "没有写入存储目录的权限", 403);
  return new FlowError("UPLOAD_FAILED", "上传失败", 500);
}

async function writePartFile(
  source: ConversationFileSource,
  partPath: string,
  limits: { maxBytes: number; expectedBytes: number },
): Promise<{ bytes: number; sha256: string; head: Buffer }> {
  mkdirSync(dirname(partPath), { recursive: true });
  const digest = createHash("sha256");
  const handle = openSync(partPath, "wx", 0o600);
  let bytes = 0;
  const headChunks: Buffer[] = [];
  let headSize = 0;
  try {
    for await (const chunk of iterateSource(source)) {
      bytes += chunk.length;
      requireCondition(
        bytes <= limits.maxBytes,
        CONVERSATION_ERROR.FILE_TOO_LARGE,
        "单个附件超过 20 MiB",
        413,
      );
      digest.update(chunk);
      if (headSize < HEAD_BYTES) {
        headChunks.push(chunk);
        headSize += chunk.length;
      }
      writeFileSync(handle, chunk);
    }
    requireCondition(
      bytes === limits.expectedBytes,
      "VALIDATION_ERROR",
      "实际上传大小与申报不一致",
      422,
    );
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  return {
    bytes,
    sha256: digest.digest("hex"),
    head: Buffer.concat(headChunks).subarray(0, HEAD_BYTES),
  };
}

async function* iterateSource(
  source: ConversationFileSource,
): AsyncGenerator<Buffer> {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    yield Buffer.from(source);
    return;
  }
  for await (const chunk of source) {
    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  }
}

async function discardSource(source: ConversationFileSource): Promise<void> {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) return;
  const stream = source as Readable;
  let bytes = 0;
  try {
    for await (const chunk of iterateSource(source)) {
      bytes += chunk.length;
      if (bytes > CONVERSATION_FILE_LIMITS.maxFileBytes) break;
    }
  } catch {
  } finally {
    if (typeof stream.destroy === "function" && !stream.destroyed) stream.destroy();
  }
}

function readDirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function removeIfExists(path: string) {
  if (existsSync(path)) unlinkSync(path);
}
