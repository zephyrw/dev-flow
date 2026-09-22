import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  CONVERSATION_ERROR,
  FileInputCapabilitySchema,
  FlowError,
  Id,
  ResolvedInputAttachmentSchema,
  ToolProfileSchema,
  type ConversationFile,
  type ResolvedInputAttachment,
  type ToolProfile,
} from "../../contracts/src/index.js";
import {
  CONVERSATION_FILE_CONTENT,
  assertConversationAttachmentSet,
  conversationFileContentPath,
  conversationFilesRoot,
  isPathInside,
} from "../../core/src/conversation-files.js";

export const CONVERSATION_INPUT_ERROR = {
  INPUT_UNSUPPORTED: CONVERSATION_ERROR.INPUT_UNSUPPORTED,
  INPUT_READ_SCOPE_UNSUPPORTED: CONVERSATION_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
  FILE_NOT_READY: CONVERSATION_ERROR.FILE_NOT_READY,
  FILE_SCOPE_MISMATCH: CONVERSATION_ERROR.FILE_SCOPE_MISMATCH,
  FILE_TOO_LARGE: CONVERSATION_ERROR.FILE_TOO_LARGE,
  TOO_MANY_FILES: "TOO_MANY_FILES",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
} as const;

export type ConversationInputErrorCode =
  (typeof CONVERSATION_INPUT_ERROR)[keyof typeof CONVERSATION_INPUT_ERROR];

export type FileInputCapability = {
  text: boolean;
  image: boolean;
  binary: boolean;
};

export type AttachmentReadMode = ResolvedInputAttachment["read_mode"];
export type AttachmentDeliveryStrategy = "inline" | "file";

export type ConversationInputFailure = {
  ok: false;
  code: ConversationInputErrorCode;
  message: string;
  file_id?: string;
};

export type ConversationInputDelivery = {
  stage: "prepared" | "delivered";
  delivered: boolean;
  observed: false;
};

export type ConversationInputSuccess = {
  ok: true;
  attachments: ResolvedInputAttachment[];
  extraReadRoots: string[];
  delivery: ConversationInputDelivery;
};

export type ConversationInputResolveResult =
  | ConversationInputSuccess
  | ConversationInputFailure;

export interface ResolveConversationInputsParams {
  files: ConversationFile[];
  storageRoot: string;
  workflowId: string;
  profile: ToolProfile;
  fileInput: FileInputCapability;
}

const INLINE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

const TEXT_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/x-sh",
  "application/x-httpd-php",
]);

export function normalizeAttachmentMime(mime: string | undefined): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

export function isOfficeMime(mime: string): boolean {
  const value = normalizeAttachmentMime(mime);
  return (
    value === "application/msword" ||
    value === "application/rtf" ||
    value.startsWith("application/vnd.ms-") ||
    value.startsWith("application/vnd.openxmlformats-officedocument.") ||
    value.startsWith("application/vnd.oasis.opendocument.")
  );
}

export function isPdfMime(mime: string): boolean {
  return normalizeAttachmentMime(mime) === "application/pdf";
}

export function resolveEffectiveMime(file: ConversationFile): string {
  const detected = normalizeAttachmentMime(file.detected_mime);
  const declared = normalizeAttachmentMime(file.declared_mime);
  if (detected === "application/zip" && isOfficeMime(declared)) return declared;
  if (detected && detected !== "application/octet-stream") return detected;
  return declared || detected || "application/octet-stream";
}

export function classifyAttachmentReadMode(mime: string): AttachmentReadMode {
  const value = normalizeAttachmentMime(mime);
  if (INLINE_IMAGE_MIMES.has(value)) return "image";
  if (isTextMime(value)) return "text";
  return "binary";
}

export function attachmentDeliveryStrategy(
  readMode: AttachmentReadMode,
): AttachmentDeliveryStrategy {
  return readMode === "image" ? "inline" : "file";
}

export function isFileInputSupported(
  readMode: AttachmentReadMode,
  fileInput: FileInputCapability,
): boolean {
  if (readMode === "image") return fileInput.image;
  if (readMode === "text") return fileInput.text;
  return fileInput.binary;
}

export function resolveConversationInputAttachments(
  params: ResolveConversationInputsParams,
): ConversationInputResolveResult {
  const profile = parseFrozenProfile(params.profile);
  if (!profile.ok) return profile;
  const fileInput = parseFileInput(params.fileInput);
  if (!fileInput.ok) return fileInput;
  const limit = checkAttachmentLimits(params.files);
  if (limit) return limit;
  const attachments: ResolvedInputAttachment[] = [];
  for (const file of params.files) {
    const resolved = resolveOneAttachment(file, params, fileInput.value);
    if (!resolved.ok) return resolved;
    attachments.push(resolved.attachment);
  }
  const extraReadRoots = uniqueReadRoots(attachments);
  const scope = validateConversationInputReadScope(
    params.storageRoot,
    extraReadRoots,
  );
  if (!scope.ok) return scope;
  return preparedInputs(attachments, extraReadRoots);
}

export function resumeConversationInputAttachments(
  params: ResolveConversationInputsParams,
): ConversationInputResolveResult {
  return resolveConversationInputAttachments(params);
}

export function markConversationInputsDelivered(
  resolved: ConversationInputSuccess,
): ConversationInputSuccess {
  return {
    ...resolved,
    delivery: {
      stage: "delivered",
      delivered: true,
      observed: false,
    },
  };
}

export function conversationInputIdentity(
  attachment: Pick<ResolvedInputAttachment, "id" | "sha256">,
): { id: string; sha256: string } {
  return { id: attachment.id, sha256: attachment.sha256 };
}

export function validateConversationInputReadScope(
  storageRoot: string,
  roots: string[],
): ConversationInputResolveResult | { ok: true } {
  for (const root of roots) {
    const allowed = isManagedFileReadRoot(storageRoot, root);
    if (!allowed.ok) return allowed;
  }
  return { ok: true };
}

function parseFrozenProfile(
  profile: ToolProfile,
): ConversationInputFailure | { ok: true; value: ToolProfile } {
  const parsed = ToolProfileSchema.safeParse(profile);
  if (!parsed.success) {
    return fail(
      CONVERSATION_INPUT_ERROR.PROFILE_NOT_FOUND,
      "缺少可用的冻结工具配置",
    );
  }
  return { ok: true, value: parsed.data };
}

function parseFileInput(
  fileInput: FileInputCapability,
): ConversationInputFailure | { ok: true; value: FileInputCapability } {
  const parsed = FileInputCapabilitySchema.safeParse(fileInput);
  if (!parsed.success) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_UNSUPPORTED,
      "当前工具无法读取此附件类型",
    );
  }
  return { ok: true, value: parsed.data };
}

function checkAttachmentLimits(
  files: ConversationFile[],
): ConversationInputFailure | undefined {
  try {
    assertConversationAttachmentSet(files);
    return undefined;
  } catch (error) {
    if (error instanceof FlowError) {
      return fail(
        error.code as ConversationInputErrorCode,
        error.message,
      );
    }
    throw error;
  }
}

function resolveOneAttachment(
  file: ConversationFile,
  params: ResolveConversationInputsParams,
  fileInput: FileInputCapability,
): ConversationInputFailure | { ok: true; attachment: ResolvedInputAttachment } {
  const scoped = assertFileInWorkflow(file, params.workflowId);
  if (!scoped.ok) return scoped;
  const ready = assertReadyFile(file);
  if (!ready.ok) return ready;
  const mime = resolveEffectiveMime(file);
  const readMode = classifyAttachmentReadMode(mime);
  if (!isFileInputSupported(readMode, fileInput)) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_UNSUPPORTED,
      "当前工具无法读取此附件类型",
      file.id,
    );
  }
  const path = resolveManagedContentPath(params.storageRoot, file);
  if (!path.ok) return path;
  const hash = verifyStoredHash(path.absolutePath, file.sha256, file.id);
  if (!hash.ok) return hash;
  return {
    ok: true,
    attachment: ResolvedInputAttachmentSchema.parse({
      id: file.id,
      display_name: file.display_name,
      sha256: file.sha256,
      absolute_path: path.absolutePath,
      mime,
      read_mode: readMode,
      size: file.size,
    }),
  };
}

function assertFileInWorkflow(
  file: ConversationFile,
  workflowId: string,
): ConversationInputFailure | { ok: true } {
  const parsed = Id.safeParse(workflowId);
  if (!parsed.success || file.workflow_id !== parsed.data) {
    return fail(
      CONVERSATION_INPUT_ERROR.FILE_SCOPE_MISMATCH,
      "文件不属于当前工作流",
      file.id,
    );
  }
  return { ok: true };
}

function assertReadyFile(
  file: ConversationFile,
): ConversationInputFailure | { ok: true } {
  if (file.status !== "ready" || !file.sha256) {
    return fail(
      CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
      "文件尚未上传完成",
      file.id,
    );
  }
  return { ok: true };
}

function resolveManagedContentPath(
  storageRoot: string,
  file: ConversationFile,
): ConversationInputFailure | { ok: true; absolutePath: string } {
  const expected = conversationFileContentPath(
    storageRoot,
    file.workflow_id,
    file.id,
  );
  if (!existsSync(expected)) {
    return fail(
      CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
      "文件内容不存在",
      file.id,
    );
  }
  const actual = realpathSync(expected);
  const bounded = assertManagedContentPath(storageRoot, actual, file.id);
  if (!bounded.ok) return bounded;
  return { ok: true, absolutePath: actual };
}

function assertManagedContentPath(
  storageRoot: string,
  actual: string,
  fileId: string,
): ConversationInputFailure | { ok: true } {
  if (!isPathInside(realFilesRoot(storageRoot), actual)) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
      "附件读取目录越界",
      fileId,
    );
  }
  return { ok: true };
}

function verifyStoredHash(
  absolutePath: string,
  expected: string | undefined,
  fileId: string,
): ConversationInputFailure | { ok: true } {
  if (!expected) {
    return fail(
      CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
      "文件尚未上传完成",
      fileId,
    );
  }
  const actual = createHash("sha256")
    .update(readFileSync(absolutePath))
    .digest("hex");
  if (actual !== expected) {
    return fail(
      CONVERSATION_INPUT_ERROR.FILE_NOT_READY,
      "文件内容与记录不一致",
      fileId,
    );
  }
  return { ok: true };
}

function uniqueReadRoots(attachments: ResolvedInputAttachment[]): string[] {
  const roots = new Set<string>();
  for (const attachment of attachments) {
    roots.add(dirname(attachment.absolute_path));
  }
  return [...roots];
}

function isManagedFileReadRoot(
  storageRoot: string,
  candidate: string,
): ConversationInputFailure | { ok: true } {
  const filesRoot = realFilesRoot(storageRoot);
  const actual = existingRealPath(candidate);
  if (!isPathInside(filesRoot, actual) || actual === filesRoot) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
      "附件读取目录越界",
    );
  }
  const rel = relative(filesRoot, actual);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
      "不能授权整个会话文件目录",
    );
  }
  if (!Id.safeParse(parts[0]).success || !Id.safeParse(parts[1]).success) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
      "附件读取目录越界",
    );
  }
  if (parts.length > 3) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
      "附件读取目录越界",
    );
  }
  if (parts.length === 3 && parts[2] !== CONVERSATION_FILE_CONTENT) {
    return fail(
      CONVERSATION_INPUT_ERROR.INPUT_READ_SCOPE_UNSUPPORTED,
      "附件读取目录越界",
    );
  }
  return { ok: true };
}

function realFilesRoot(storageRoot: string): string {
  return existingRealPath(conversationFilesRoot(storageRoot));
}

function existingRealPath(candidate: string): string {
  const resolved = resolve(candidate);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function preparedInputs(
  attachments: ResolvedInputAttachment[],
  extraReadRoots: string[],
): ConversationInputSuccess {
  return {
    ok: true,
    attachments,
    extraReadRoots,
    delivery: {
      stage: "prepared",
      delivered: false,
      observed: false,
    },
  };
}

function fail(
  code: ConversationInputErrorCode,
  message: string,
  fileId?: string,
): ConversationInputFailure {
  return { ok: false, code, message, file_id: fileId };
}

function isTextMime(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (TEXT_MIMES.has(mime)) return true;
  return mime.endsWith("+json") || mime.endsWith("+xml");
}