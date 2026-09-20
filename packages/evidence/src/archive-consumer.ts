import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  ArchiveOutboxItem,
  AttachmentArchiveRecord,
  AttachmentArchiveState,
  Delivery,
  DeliveryManifest,
  Workspace,
  Workflow,
} from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { safePath } from "../../workspace/src/files.js";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const ARCHIVE_CONCURRENCY = 2;
const OUTBOX_KIND = "archive_outbox";
const RECORD_KIND = "attachment_archive";

const fileSlots = createSlotLimiter(ARCHIVE_CONCURRENCY);
const draining = new WeakMap<Store, Promise<void>>();

export function attachmentArchiveKey(
  deliveryId: string,
  repoId: string,
  path: string,
): string {
  return JSON.stringify([deliveryId, repoId, path]);
}

function rememberRecord(
  byKey: Map<string, AttachmentArchiveRecord>,
  record: AttachmentArchiveRecord,
) {
  if (
    !record ||
    typeof record.path !== "string" ||
    !record.path.trim() ||
    typeof record.repo_id !== "string" ||
    typeof record.delivery_id !== "string"
  ) return;
  const key = attachmentArchiveKey(
    record.delivery_id,
    record.repo_id,
    record.path,
  );
  const existing = byKey.get(key);
  if (!existing || archiveRank(record.state) >= archiveRank(existing.state))
    byKey.set(key, record);
}

function archiveRank(state: AttachmentArchiveState) {
  if (state === "archived") return 3;
  if (state === "pending") return 0;
  return 2;
}

function hydrateArchiveRecord(
  id: string,
  value: AttachmentArchiveRecord,
): AttachmentArchiveRecord {
  const parsed = parseArchiveKey(id);
  return {
    delivery_id: typeof value?.delivery_id === "string" ? value.delivery_id : parsed?.deliveryId ?? "",
    repo_id: typeof value?.repo_id === "string" ? value.repo_id : parsed?.repoId ?? "main",
    path: typeof value?.path === "string" ? value.path : parsed?.path ?? "",
    state: typeof value?.state === "string" ? value.state : "pending",
    ...(typeof value?.detail === "string" ? { detail: value.detail } : {}),
  };
}

function parseArchiveKey(id: string) {
  try {
    const value = JSON.parse(id);
    if (!Array.isArray(value) || value.length < 3) return;
    const [deliveryId, repoId, path] = value;
    if (
      typeof deliveryId !== "string" ||
      typeof repoId !== "string" ||
      typeof path !== "string"
    )
      return;
    return { deliveryId, repoId, path };
  } catch {
    return;
  }
}

export function listAttachmentRecords(
  store: Store,
  workflowId: string,
  deliveryId?: string,
): AttachmentArchiveRecord[] {
  const byKey = new Map<string, AttachmentArchiveRecord>();
  for (const delivery of store.list<Delivery>("delivery", workflowId)) {
    if (deliveryId && delivery.id !== deliveryId) continue;
    for (const record of delivery.attachment_status ?? []) {
      rememberRecord(byKey, record);
    }
  }
  for (const job of store.list<ArchiveOutboxItem>(OUTBOX_KIND, workflowId)) {
    if (deliveryId && job.delivery_id !== deliveryId) continue;
    for (const item of job.items ?? []) {
      rememberRecord(byKey, {
        delivery_id: job.delivery_id,
        repo_id: item.repo_id,
        path: item.path,
        state: "pending",
      });
    }
  }
  for (const entry of store.entries<AttachmentArchiveRecord>(
    RECORD_KIND,
    workflowId,
  )) {
    const record = hydrateArchiveRecord(entry.id, entry.value);
    if (deliveryId && record.delivery_id !== deliveryId) continue;
    rememberRecord(byKey, record);
  }
  return [...byKey.values()].filter((record) => record.path);
}

export function createArchiveJobFromManifest(
  store: Store,
  options: {
    deliveryId: string;
    workflowId: string;
    runId: string;
    workspaces?: Workspace[];
    manifest: DeliveryManifest;
  },
): ArchiveOutboxItem | undefined {
  const items = uniqueAttachments(options.manifest, options.workspaces ?? []);
  if (!items.length) return undefined;
  for (const item of items) {
    const key = attachmentArchiveKey(
      options.deliveryId,
      item.repo_id,
      item.path,
    );
    const existing = store.get<AttachmentArchiveRecord>(RECORD_KIND, key);
    if (existing?.state === "archived") continue;
    const record: AttachmentArchiveRecord = {
      delivery_id: options.deliveryId,
      repo_id: item.repo_id,
      path: item.path,
      state: existing?.state ?? "pending",
      ...(existing?.detail ? { detail: existing.detail } : {}),
    };
    store.put(RECORD_KIND, key, options.workflowId, record);
  }
  const job: ArchiveOutboxItem = {
    delivery_id: options.deliveryId,
    workflow_id: options.workflowId,
    run_id: options.runId,
    items,
  };
  enqueueArchive(store, job);
  return job;
}

export function enqueueArchive(store: Store, item: ArchiveOutboxItem): void {
  if (!item.items.length) return;
  const existing = store.get<ArchiveOutboxItem>(OUTBOX_KIND, item.delivery_id);
  const merged = existing
    ? {
        ...item,
        items: uniqueOutboxItems([...existing.items, ...item.items]),
      }
    : item;
  store.put(OUTBOX_KIND, item.delivery_id, item.workflow_id, merged);
  for (const entry of merged.items) {
    const key = attachmentArchiveKey(
      item.delivery_id,
      entry.repo_id,
      entry.path,
    );
    if (store.get<AttachmentArchiveRecord>(RECORD_KIND, key)) continue;
    store.put(RECORD_KIND, key, item.workflow_id, {
      delivery_id: item.delivery_id,
      repo_id: entry.repo_id,
      path: entry.path,
      state: "pending",
    } satisfies AttachmentArchiveRecord);
  }
}

export function drainArchiveOutbox(
  store: Store,
  options: { storageRoot: string; workspaces?: Workspace[] },
): Promise<void> {
  const previous = draining.get(store);
  const job = (async () => {
    if (previous) await previous;
    await runArchivePass(store, options);
  })();
  draining.set(store, job);
  return job.finally(() => {
    if (draining.get(store) === job) draining.delete(store);
  });
}

export function uniqueAttachments(
  manifest: DeliveryManifest,
  workspaces: Workspace[],
): { repo_id: string; path: string }[] {
  const fallback =
    workspaces.length === 1 ? workspaces[0]!.repo_id : undefined;
  const items: { repo_id: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const execution of Array.isArray(manifest.test_executions) ? manifest.test_executions : []) {
    if (!execution || typeof execution !== "object") continue;
    const repoId = execution.repo_id ?? fallback ?? "main";
    for (const path of Array.isArray(execution.report_paths) ? execution.report_paths : []) {
      add(repoId, path);
    }
  }
  for (const artifact of Array.isArray(manifest.artifacts) ? manifest.artifacts : []) {
    if (typeof artifact === "string" && artifact.trim()) {
      add(fallback ?? "main", artifact.trim());
      continue;
    }
    if (!artifact || typeof artifact !== "object") continue;
    const rec = artifact as { path?: unknown; file?: unknown; repo_id?: unknown };
    const path = rec.path ?? rec.file;
    if (!path) continue;
    add(rec.repo_id ?? fallback ?? "main", path);
  }
  return items;

  function add(repoId: unknown, path: unknown) {
    if (typeof repoId !== "string" || !repoId.trim() || typeof path !== "string" || !path.trim()) return;
    const item = { repo_id: repoId.trim(), path: path.trim() };
    const key = attachmentArchiveKey("", item.repo_id, item.path);
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }
}

function uniqueOutboxItems(
  items: { repo_id: string; path: string }[],
): { repo_id: string; path: string }[] {
  const seen = new Set<string>();
  const unique: { repo_id: string; path: string }[] = [];
  for (const item of items) {
    if (!item || typeof item.repo_id !== "string" || !item.repo_id.trim() || typeof item.path !== "string" || !item.path.trim()) continue;
    const key = item.repo_id + "\0" + item.path;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function collectOutboxJobs(store: Store): ArchiveOutboxItem[] {
  const jobs = new Map<string, ArchiveOutboxItem>();
  for (const job of store.list<ArchiveOutboxItem>(OUTBOX_KIND)) {
    if (job?.delivery_id && Array.isArray(job.items)) {
      const items = uniqueOutboxItems(job.items);
      if (items.length) jobs.set(job.delivery_id, { ...job, items });
    }
  }
  for (const row of store.jobs()) {
    if (row.kind !== "archive_delivery") continue;
    const parsed = parseQueuedOutbox(row.data, row.workflow_id);
    if (!parsed) {
      store.jobStatus(row.id, "rejected");
      continue;
    }
    const existing = jobs.get(parsed.delivery_id);
    const merged = existing
      ? {
          ...parsed,
          items: uniqueOutboxItems([...existing.items, ...parsed.items]),
        }
      : parsed;
    jobs.set(parsed.delivery_id, merged);
    store.put(OUTBOX_KIND, merged.delivery_id, merged.workflow_id, merged);
    store.jobStatus(row.id, "delivered");
  }
  for (const delivery of store.list<Delivery>("delivery")) {
    if (jobs.get(delivery.id)?.items.length) continue;
    const pending = (delivery.attachment_status ?? []).filter(
      (record) => record && typeof record.path === "string" && record.path.trim() && record.state !== "archived",
    );
    if (!pending.length) continue;
    const job: ArchiveOutboxItem = {
      delivery_id: delivery.id,
      workflow_id: delivery.workflow_id,
      run_id: delivery.run_id,
      items: uniqueOutboxItems(
        pending.map((record) => ({
          repo_id: record.repo_id,
          path: record.path,
        })),
      ),
    };
    jobs.set(delivery.id, job);
    store.put(OUTBOX_KIND, job.delivery_id, job.workflow_id, job);
  }
  return [...jobs.values()];
}

function parseQueuedOutbox(
  data: string,
  workflowId: string,
): ArchiveOutboxItem | undefined {
  let value: unknown = data;
  for (let i = 0; i < 2; i++) {
    if (typeof value !== "string") break;
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as Record<string, unknown>;
  const items = Array.isArray(rec.items)
    ? rec.items.filter(
        (item): item is { repo_id: string; path: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { repo_id?: unknown }).repo_id === "string" &&
          typeof (item as { path?: unknown }).path === "string",
      )
    : [];
  const deliveryId =
    typeof rec.delivery_id === "string" ? rec.delivery_id : undefined;
  if (!deliveryId || !items.length) return;
  return {
    delivery_id: deliveryId,
    workflow_id: workflowId,
    run_id: typeof rec.run_id === "string" ? rec.run_id : "",
    items,
  };
}

async function runArchivePass(
  store: Store,
  options: { storageRoot: string; workspaces?: Workspace[] },
): Promise<void> {
  const jobs = collectOutboxJobs(store);
  for (const job of jobs) {
    for (const item of job.items) {
      const key = attachmentArchiveKey(job.delivery_id, item.repo_id, item.path);
      if (store.get<AttachmentArchiveRecord>(RECORD_KIND, key)) continue;
      store.put(RECORD_KIND, key, job.workflow_id, {
        delivery_id: job.delivery_id,
        repo_id: item.repo_id,
        path: item.path,
        state: "pending",
      } satisfies AttachmentArchiveRecord);
    }
  }
  const work: {
    job: ArchiveOutboxItem;
    item: { repo_id: string; path: string };
    record: AttachmentArchiveRecord;
    key: string;
  }[] = [];
  for (const job of jobs) {
    for (const item of job.items) {
      const key = attachmentArchiveKey(job.delivery_id, item.repo_id, item.path);
      const record =
        store.get<AttachmentArchiveRecord>(RECORD_KIND, key) ?? {
          delivery_id: job.delivery_id,
          repo_id: item.repo_id,
          path: item.path,
          state: "pending" as const,
        };
      if (record.state === "archived") continue;
      work.push({ job, item, record, key });
    }
  }
  await Promise.all(
    work.map((entry) =>
      fileSlots.run(() => archiveOne(store, options, entry)),
    ),
  );
  for (const job of jobs) {
    const pending = job.items.some((item) => {
      const key = attachmentArchiveKey(job.delivery_id, item.repo_id, item.path);
      return (
        store.get<AttachmentArchiveRecord>(RECORD_KIND, key)?.state !==
        "archived"
      );
    });
    if (!pending) store.remove(OUTBOX_KIND, job.delivery_id);
  }
}

async function archiveOne(
  store: Store,
  options: { storageRoot: string; workspaces?: Workspace[] },
  entry: {
    job: ArchiveOutboxItem;
    item: { repo_id: string; path: string };
    record: AttachmentArchiveRecord;
    key: string;
  },
): Promise<void> {
  const latest = hydrateArchiveRecord(
    entry.key,
    store.get<AttachmentArchiveRecord>(RECORD_KIND, entry.key) ?? entry.record,
  );
  if (latest.state === "archived") return;
  let result: AttachmentArchiveRecord;
  try {
    result = await archiveAttachmentFile(
      store,
      options,
      entry.job,
      entry.item,
    );
  } catch {
    result = {
      delivery_id: entry.job.delivery_id,
      repo_id: entry.item.repo_id,
      path: entry.item.path,
      state: "archive_failed",
      detail: "归档失败",
    };
  }
  store.transaction(() => {
    store.put(RECORD_KIND, entry.key, entry.job.workflow_id, result);
    const workflow = store.get<Workflow>("workflow", entry.job.workflow_id);
    if (workflow && (latest.state !== result.state || latest.detail !== result.detail))
      store.event(workflow.id, workflow.project_id, "AttachmentArchiveUpdated", result, entry.job.run_id);
  });
}

async function archiveAttachmentFile(
  store: Store,
  options: { storageRoot: string; workspaces?: Workspace[] },
  job: ArchiveOutboxItem,
  item: { repo_id: string; path: string },
): Promise<AttachmentArchiveRecord> {
  const base: AttachmentArchiveRecord = {
    delivery_id: job.delivery_id,
    repo_id: item.repo_id,
    path: item.path,
    state: "pending",
  };
  const workspaceRoot = resolveWorkspaceRoot(
    store,
    job.workflow_id,
    item.repo_id,
    options.workspaces,
  );
  if (!workspaceRoot) {
    return { ...base, state: "skipped", detail: "找不到对应工作区" };
  }
  let source: string;
  try {
    source = safePath(workspaceRoot, item.path);
  } catch {
    return { ...base, state: "skipped", detail: "路径不安全" };
  }
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(source);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ...base, state: "missing", detail: "文件不存在" };
    }
    return { ...base, state: "unreadable", detail: "无法读取文件状态" };
  }
  if (!fileStat.isFile()) {
    return { ...base, state: "skipped", detail: "不是普通文件" };
  }
  if (fileStat.size > MAX_REPORT_BYTES) {
    return { ...base, state: "skipped", detail: "文件超过 32MB" };
  }
  const delivery =
    store.get<Delivery>("delivery", job.delivery_id) ?? undefined;
  const deliveryDir =
    delivery?.archive_root ??
    join(options.storageRoot, "deliveries", job.delivery_id);
  const archiveName =
    createHash("sha256").update(entryIdentity(job.delivery_id, item)).digest("hex") +
    ".report";
  const target = join(deliveryDir, "reports", archiveName);
  try {
    await mkdir(dirname(target), { recursive: true });
    await streamArchive(source, target);
    return { ...base, state: "archived" };
  } catch (error) {
    await unlinkQuiet(target);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ...base, state: "missing", detail: "文件不存在" };
    }
    if ((error as Error).message === "too-large") {
      return { ...base, state: "skipped", detail: "文件超过 32MB" };
    }
    if (isReadError(error)) {
      return { ...base, state: "unreadable", detail: "文件不可读" };
    }
    return { ...base, state: "archive_failed", detail: "归档失败" };
  }
}

function entryIdentity(
  deliveryId: string,
  item: { repo_id: string; path: string },
): string {
  return attachmentArchiveKey(deliveryId, item.repo_id, item.path);
}

function resolveWorkspaceRoot(
  store: Store,
  workflowId: string,
  repoId: string,
  workspaces?: Workspace[],
): string | undefined {
  const supplied = workspaces?.filter((workspace) => workspace.workflow_id === workflowId) ?? [];
  const list = supplied.length ? supplied : store.list<Workspace>("workspace", workflowId)
    .filter((workspace) => workspace.workflow_id === workflowId);
  return list.find((workspace) => workspace.repo_id === repoId)?.root;
}

async function streamArchive(source: string, target: string): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_REPORT_BYTES) {
        callback(new Error("too-large"));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(source), limiter, createWriteStream(target));
  hash.digest("hex");
}

async function unlinkQuiet(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch {}
}

function isReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EISDIR";
}

function createSlotLimiter(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };

  function acquire(): Promise<void> {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

export type { AttachmentArchiveState };
