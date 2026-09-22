import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type RefObject,
} from "react";
import { fileWithinConversationLimits } from "../../../../packages/contracts/src/conversation-input.js";
import type { ConversationDraftAttachment } from "../use-conversation-draft.js";

export const UNSUPPORTED_ATTACHMENT_TYPE = "当前工具无法读取此附件类型";
export const INTERRUPTED_ATTACHMENT_UPLOAD = "上传中断，请重新选择";
export const ATTACHMENT_LIMIT_TOO_MANY = "每条消息最多 10 个附件";
export const ATTACHMENT_LIMIT_FILE_TOO_LARGE = "单个附件超过 20 MiB";
export const ATTACHMENT_LIMIT_TOTAL_TOO_LARGE = "附件总量超过 100 MiB";

export type AttachmentKind = "image" | "text" | "binary";
export type AttachmentQueueStatus =
  | "pending"
  | "uploading"
  | "ready"
  | "failed";

export type FileInputCapability = {
  text: boolean;
  image: boolean;
  binary: boolean;
};

export type AttachmentRecord = {
  clientId: string;
  workflowId: string;
  requestId: string;
  fileId?: string;
  uploadPath?: string;
  file?: File;
  displayName: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  status: AttachmentQueueStatus;
  supported: boolean;
  interrupted: boolean;
  error?: string;
  previewUrl?: string;
};

type PersistedAttachment = {
  clientId: string;
  requestId: string;
  fileId?: string;
  displayName: string;
  size: number;
  mime: string;
  kind: AttachmentKind;
  status: AttachmentQueueStatus;
  supported: boolean;
  interrupted: boolean;
  error?: string;
};

const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);
const TEXT_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
]);
const TEXT_EXT = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rs",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "sql",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "vue",
  "svelte",
  "csv",
  "log",
]);

const queues = new Map<string, AttachmentRecord[]>();
const listeners = new Map<string, Set<() => void>>();
const restores = new Set<string>();
const uploads = new Map<string, AbortController>();
const EMPTY_ITEMS: AttachmentRecord[] = [];

function draftSignature(items: AttachmentRecord[]): string {
  return items
    .map(
      (item) =>
        `${item.clientId}:${item.fileId ?? ""}:${item.status}:${item.supported}:${item.interrupted}`,
    )
    .join("|");
}

export function resetConversationAttachments(): void {
  for (const item of [...queues.values()].flat()) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  queues.clear();
  restores.clear();
  for (const controller of uploads.values()) controller.abort();
  uploads.clear();
}

export function conversationAttachmentsStorageKey(workflowId: string): string {
  return `devflow.conversation-draft-files.${workflowId}`;
}

export function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function classifyConversationAttachmentKind(
  mime: string,
  name: string,
): AttachmentKind {
  const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = fileExtension(name);
  if (IMAGE_MIMES.has(normalized) || IMAGE_EXT.has(ext)) return "image";
  if (normalized.startsWith("text/")) return "text";
  if (TEXT_MIMES.has(normalized) || TEXT_EXT.has(ext)) return "text";
  return "binary";
}

export function declaredAttachmentMime(file: File): string {
  if (file.type) return file.type;
  const ext = fileExtension(file.name);
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (IMAGE_EXT.has(ext)) return `image/${ext}`;
  if (ext === "pdf") return "application/pdf";
  if (TEXT_EXT.has(ext)) return "text/plain";
  return "application/octet-stream";
}

export function isPreviewableImage(kind: AttachmentKind, mime: string): boolean {
  const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  return kind === "image" && IMAGE_MIMES.has(normalized);
}

export function attachmentTypeSupported(
  kind: AttachmentKind,
  capability?: FileInputCapability,
): boolean {
  if (!capability) return true;
  return capability[kind];
}

export function conversationAttachmentLimitReason(params: {
  fileCount: number;
  fileBytes: number;
  totalBytes: number;
}): string | undefined {
  const result = fileWithinConversationLimits(params);
  if (result === "ok") return undefined;
  if (result === "too_many") return ATTACHMENT_LIMIT_TOO_MANY;
  if (result === "file_too_large") return ATTACHMENT_LIMIT_FILE_TOO_LARGE;
  return ATTACHMENT_LIMIT_TOTAL_TOO_LARGE;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function attachmentStatusLabel(item: AttachmentRecord): string {
  if (item.interrupted) return INTERRUPTED_ATTACHMENT_UPLOAD;
  if (!item.supported) return UNSUPPORTED_ATTACHMENT_TYPE;
  if (item.status === "failed") return item.error || "上传失败";
  if (item.status === "ready") return "已就绪";
  return "上传中";
}

export function toDraftAttachment(
  item: AttachmentRecord,
): ConversationDraftAttachment {
  return {
    id: item.fileId ?? item.clientId,
    status: item.interrupted ? "failed" : item.status,
    supported: item.supported,
  };
}

export function conversationPasteImageFiles(
  clipboardData: DataTransfer | null,
): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== "file") continue;
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export function conversationPasteText(
  clipboardData: DataTransfer | null,
): string {
  return clipboardData?.getData("text/plain") ?? "";
}

export function isConversationFileDrag(
  dataTransfer: DataTransfer | null,
): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

export function conversationDropFiles(
  dataTransfer: DataTransfer | null,
): File[] {
  if (!dataTransfer || !isConversationFileDrag(dataTransfer)) return [];
  return Array.from(dataTransfer.files);
}

function readStorage(): Storage | undefined {
  try {
    if (typeof localStorage === "undefined") return undefined;
    return localStorage;
  } catch {
    return undefined;
  }
}

function persistQueue(workflowId: string): void {
  const storage = readStorage();
  if (!storage) return;
  const items: PersistedAttachment[] = (queues.get(workflowId) ?? []).map(
    (item) => ({
      clientId: item.clientId,
      requestId: item.requestId,
      fileId: item.fileId,
      displayName: item.displayName,
      size: item.size,
      mime: item.mime,
      kind: item.kind,
      status: item.status,
      supported: item.supported,
      interrupted: item.interrupted || (!item.file && item.status !== "ready"),
      error: item.error,
    }),
  );
  storage.setItem(
    conversationAttachmentsStorageKey(workflowId),
    JSON.stringify(items),
  );
}

function emit(workflowId: string): void {
  persistQueue(workflowId);
  for (const listener of listeners.get(workflowId) ?? []) listener();
}

function queueOf(workflowId: string): AttachmentRecord[] {
  const existing = queues.get(workflowId);
  if (existing) return existing;
  const created: AttachmentRecord[] = [];
  queues.set(workflowId, created);
  return created;
}

function replaceQueue(workflowId: string, next: AttachmentRecord[]): void {
  queues.set(workflowId, next);
  emit(workflowId);
}

function patchItem(
  workflowId: string,
  clientId: string,
  patch: Partial<AttachmentRecord>,
): AttachmentRecord | undefined {
  const current = queueOf(workflowId);
  const index = current.findIndex((item) => item.clientId === clientId);
  if (index < 0) return undefined;
  const next = current.slice();
  next[index] = { ...current[index]!, ...patch };
  replaceQueue(workflowId, next);
  return next[index];
}

function apiErrorMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: { message?: string } } | undefined)?.error;
  return error?.message || fallback;
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { message: text } };
  }
}

function uploadKey(workflowId: string, clientId: string): string {
  return `${workflowId}:${clientId}`;
}

async function createMetadata(
  workflowId: string,
  body: {
    request_id: string;
    display_name: string;
    size: number;
    declared_mime: string;
  },
): Promise<{ file_id: string; upload_path: string }> {
  const response = await fetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/conversation-files`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, ATTACHMENT_LIMIT_FILE_TOO_LARGE));
  }
  return payload as { file_id: string; upload_path: string };
}

function contentUrl(uploadPath: string): string {
  return uploadPath.startsWith("/api/") ? uploadPath : `/api${uploadPath}`;
}

async function putContent(
  uploadPath: string,
  file: File,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(contentUrl(uploadPath), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
    signal,
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(apiErrorMessage(payload, "附件上传失败，请重试或移除"));
  }
}

async function fetchMetadata(
  workflowId: string,
  fileId: string,
): Promise<{ id: string; status: string; display_name: string; size: number; declared_mime: string } | undefined> {
  const response = await fetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/conversation-files/${encodeURIComponent(fileId)}`,
    { credentials: "same-origin" },
  );
  if (response.status === 404) return undefined;
  if (!response.ok) {
    return {
      id: fileId,
      status: "ready",
      display_name: "",
      size: 0,
      declared_mime: "application/octet-stream",
    };
  }
  return (await readResponse(response)) as {
    id: string;
    status: string;
    display_name: string;
    size: number;
    declared_mime: string;
  };
}

async function deleteDraftFile(workflowId: string, fileId: string): Promise<void> {
  await fetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/conversation-files/${encodeURIComponent(fileId)}`,
    { method: "DELETE", credentials: "same-origin" },
  );
}

async function runUpload(item: AttachmentRecord): Promise<void> {
  if (!item.file) {
    patchItem(item.workflowId, item.clientId, {
      interrupted: true,
      status: "failed",
      error: INTERRUPTED_ATTACHMENT_UPLOAD,
    });
    return;
  }
  const key = uploadKey(item.workflowId, item.clientId);
  uploads.get(key)?.abort();
  const controller = new AbortController();
  uploads.set(key, controller);
  patchItem(item.workflowId, item.clientId, {
    status: item.fileId ? "uploading" : "pending",
    interrupted: false,
    error: undefined,
  });
  try {
    let fileId = item.fileId;
    let uploadPath = item.uploadPath;
    if (!fileId || !uploadPath) {
      const created = await createMetadata(item.workflowId, {
        request_id: item.requestId,
        display_name: item.displayName,
        size: item.size,
        declared_mime: item.mime,
      });
      fileId = created.file_id;
      uploadPath = created.upload_path;
      patchItem(item.workflowId, item.clientId, {
        fileId,
        uploadPath,
        status: "uploading",
      });
    } else {
      patchItem(item.workflowId, item.clientId, { status: "uploading" });
    }
    await putContent(uploadPath, item.file, controller.signal);
    patchItem(item.workflowId, item.clientId, {
      fileId,
      uploadPath,
      status: "ready",
      interrupted: false,
      error: undefined,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    patchItem(item.workflowId, item.clientId, {
      status: "failed",
      error: error instanceof Error ? error.message : "附件上传失败，请重试或移除",
    });
  } finally {
    if (uploads.get(key) === controller) uploads.delete(key);
  }
}

function recordFromFile(
  workflowId: string,
  file: File,
  capability?: FileInputCapability,
): AttachmentRecord {
  const mime = declaredAttachmentMime(file);
  const kind = classifyConversationAttachmentKind(mime, file.name);
  return {
    clientId: crypto.randomUUID(),
    workflowId,
    requestId: crypto.randomUUID(),
    file,
    displayName: file.name,
    size: file.size,
    mime,
    kind,
    status: "pending",
    supported: attachmentTypeSupported(kind, capability),
    interrupted: false,
    previewUrl: isPreviewableImage(kind, mime)
      ? URL.createObjectURL(file)
      : undefined,
  };
}

function conversationBatchLimitReason(
  current: AttachmentRecord[],
  files: File[],
): string | undefined {
  const totalBytes =
    current.reduce((sum, item) => sum + item.size, 0) +
    files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    const reason = conversationAttachmentLimitReason({
      fileCount: current.length + files.length,
      fileBytes: file.size,
      totalBytes,
    });
    if (reason) return reason;
  }
  return undefined;
}

export function addConversationFiles(
  workflowId: string,
  files: File[],
  capability?: FileInputCapability,
): string | undefined {
  const current = queueOf(workflowId);
  const reason = conversationBatchLimitReason(current, files);
  if (reason) return reason;
  const accepted = files.map((file) =>
    recordFromFile(workflowId, file, capability),
  );
  replaceQueue(workflowId, current.concat(accepted));
  for (const item of accepted) void runUpload(item);
  return undefined;
}

export function retryConversationAttachment(workflowId: string, clientId: string): void {
  const item = queueOf(workflowId).find((entry) => entry.clientId === clientId);
  if (!item) return;
  void runUpload(item);
}

export async function removeConversationAttachment(
  workflowId: string,
  clientId: string,
): Promise<void> {
  const item = queueOf(workflowId).find((entry) => entry.clientId === clientId);
  if (!item) return;
  uploads.get(uploadKey(workflowId, clientId))?.abort();
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  if (item.fileId) {
    try {
      await deleteDraftFile(workflowId, item.fileId);
    } catch {
      // 已被消息引用时服务端拒绝删除，草稿侧仍可移除。
    }
  }
  replaceQueue(
    workflowId,
    queueOf(workflowId).filter((entry) => entry.clientId !== clientId),
  );
}

export function clearSubmittedConversationAttachments(
  workflowId: string,
  submittedIds: string[],
): void {
  const submitted = new Set(submittedIds);
  const next = queueOf(workflowId).filter((item) => {
    const id = item.fileId ?? item.clientId;
    if (!submitted.has(id) && !submitted.has(item.clientId)) return true;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    return false;
  });
  replaceQueue(workflowId, next);
}

export function clearConversationAttachments(workflowId: string): void {
  for (const item of queueOf(workflowId)) {
    if (item.status === "uploading" || item.status === "pending") continue;
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  replaceQueue(
    workflowId,
    queueOf(workflowId).filter(
      (item) => item.status === "uploading" || item.status === "pending",
    ),
  );
}

export function applyAttachmentCapability(
  workflowId: string,
  capability?: FileInputCapability,
): void {
  const current = queueOf(workflowId);
  if (!current.length) return;
  let changed = false;
  const next = current.map((item) => {
    const supported = attachmentTypeSupported(item.kind, capability);
    if (supported === item.supported) return item;
    changed = true;
    return { ...item, supported };
  });
  if (changed) replaceQueue(workflowId, next);
}

function persistedToRecord(
  workflowId: string,
  item: PersistedAttachment,
): AttachmentRecord {
  const interrupted =
    item.interrupted || item.status !== "ready" || !item.fileId;
  return {
    clientId: item.clientId,
    workflowId,
    requestId: item.requestId,
    fileId: item.fileId,
    displayName: item.displayName,
    size: item.size,
    mime: item.mime,
    kind: item.kind,
    status: interrupted ? "failed" : item.status,
    supported: item.supported,
    interrupted,
    error: interrupted ? INTERRUPTED_ATTACHMENT_UPLOAD : item.error,
  };
}

async function restoreQueue(workflowId: string): Promise<void> {
  if (restores.has(workflowId)) return;
  restores.add(workflowId);
  const storage = readStorage();
  const raw = storage?.getItem(conversationAttachmentsStorageKey(workflowId));
  if (!raw) return;
  let parsed: PersistedAttachment[] = [];
  try {
    parsed = JSON.parse(raw) as PersistedAttachment[];
  } catch {
    return;
  }
  const restored: AttachmentRecord[] = [];
  for (const item of parsed) {
    if (item.status === "ready" && item.fileId) {
      const meta = await fetchMetadata(workflowId, item.fileId);
      if (!meta) {
        restored.push({
          ...persistedToRecord(workflowId, item),
          status: "ready",
          interrupted: false,
          error: undefined,
        });
        continue;
      }
      restored.push({
        ...persistedToRecord(workflowId, item),
        fileId: meta.id || item.fileId,
        displayName: meta.display_name || item.displayName,
        size: meta.size || item.size,
        mime: meta.declared_mime || item.mime,
        status: meta.status === "ready" ? "ready" : "failed",
        interrupted: meta.status !== "ready",
        error:
          meta.status === "ready" ? undefined : INTERRUPTED_ATTACHMENT_UPLOAD,
      });
      continue;
    }
    restored.push(persistedToRecord(workflowId, item));
  }
  if (queueOf(workflowId).length) return;
  if (restored.length) replaceQueue(workflowId, restored);
}

function subscribe(workflowId: string, listener: () => void): () => void {
  const set = listeners.get(workflowId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(workflowId, set);
  return () => {
    set.delete(listener);
  };
}

export function useConversationAttachmentQueue(
  workflowId: string,
  onDraftChange: (attachments: ConversationDraftAttachment[]) => void,
  capability?: FileInputCapability,
): {
  items: AttachmentRecord[];
  limitReason?: string;
  addFiles: (files: File[]) => void;
  retry: (clientId: string) => void;
  remove: (clientId: string) => void;
  pickLocalFiles: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  handleFileInput: (event: ChangeEvent<HTMLInputElement>) => void;
} {
  const inputRef = useRef<HTMLInputElement>(null);
  const [limitReason, setLimitReason] = useState<string>();
  const [, setTick] = useState(0);
  const onDraftChangeRef = useRef(onDraftChange);
  const lastDraftSig = useRef("");
  onDraftChangeRef.current = onDraftChange;

  useEffect(() => {
    lastDraftSig.current = "";
    const refresh = () => setTick((value) => value + 1);
    const unsubscribe = subscribe(workflowId, refresh);
    void restoreQueue(workflowId).then(refresh);
    return unsubscribe;
  }, [workflowId]);

  const capabilityKey = capability
    ? `${capability.text}:${capability.image}:${capability.binary}`
    : "";
  useEffect(() => {
    applyAttachmentCapability(workflowId, capability);
  }, [capability, capabilityKey, workflowId]);

  const items = queues.get(workflowId) ?? EMPTY_ITEMS;
  const signature = draftSignature(items);

  useEffect(() => {
    if (signature === lastDraftSig.current) return;
    lastDraftSig.current = signature;
    onDraftChangeRef.current(items.map(toDraftAttachment));
  }, [items, signature]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setLimitReason(addConversationFiles(workflowId, files, capability));
    },
    [capability, workflowId],
  );

  const retry = useCallback(
    (clientId: string) => {
      retryConversationAttachment(workflowId, clientId);
    },
    [workflowId],
  );

  const remove = useCallback(
    (clientId: string) => {
      void removeConversationAttachment(workflowId, clientId);
    },
    [workflowId],
  );

  const pickLocalFiles = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
    },
    [addFiles],
  );

  return {
    items,
    limitReason,
    addFiles,
    retry,
    remove,
    pickLocalFiles,
    inputRef,
    handleFileInput,
  };
}

export function ConversationAttachments({
  workflowId,
  items,
  limitReason,
  onRetry,
  onRemove,
  inputRef,
  onFileInput,
}: {
  workflowId: string;
  items: AttachmentRecord[];
  limitReason?: string;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onFileInput: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="conversation-attachment-bar" data-workflow-id={workflowId}>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={onFileInput}
      />
      {items.length > 0 && (
        <ul className="conversation-attachment-list">
          {items.map((item) => (
            <AttachmentChip
              key={item.clientId}
              item={item}
              onRetry={onRetry}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
      {limitReason && (
        <p className="conversation-attachment-limit" role="status">
          {limitReason}
        </p>
      )}
    </div>
  );
}

function AttachmentChip({
  item,
  onRetry,
  onRemove,
}: {
  item: AttachmentRecord;
  onRetry: (clientId: string) => void;
  onRemove: (clientId: string) => void;
}) {
  const canRetry =
    item.status === "failed" && Boolean(item.file) && !item.interrupted;
  const status = attachmentStatusLabel(item);
  return (
    <li
      className={
        "conversation-attachment-chip" +
        (item.supported ? "" : " is-unsupported") +
        (item.status === "failed" ? " is-failed" : "")
      }
    >
      {item.previewUrl ? (
        <img
          className="conversation-attachment-thumb"
          src={item.previewUrl}
          alt={item.displayName}
        />
      ) : (
        <span className="conversation-attachment-icon" aria-hidden="true">
          {item.kind === "text" ? "TXT" : "FILE"}
        </span>
      )}
      <span className="conversation-attachment-meta">
        <span className="conversation-attachment-name">{item.displayName}</span>
        <span className="conversation-attachment-sub">
          {formatAttachmentSize(item.size)} · {item.mime || item.kind} · {status}
        </span>
      </span>
      {canRetry && (
        <button
          type="button"
          className="conversation-attachment-retry"
          onClick={() => onRetry(item.clientId)}
        >
          重试
        </button>
      )}
      <button
        type="button"
        className="conversation-attachment-remove"
        aria-label={`移除 ${item.displayName}`}
        onClick={() => onRemove(item.clientId)}
      >
        ×
      </button>
    </li>
  );
}

export function preventFileDragDefault(event: DragEvent): void {
  if (!isConversationFileDrag(event.dataTransfer)) return;
  event.preventDefault();
}
