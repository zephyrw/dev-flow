import { relative, resolve, isAbsolute, sep } from "node:path";
import { realpath } from "node:fs/promises";
import type {
  NativeConversationEvent,
} from "../../adapters/sdk/src/interface.js";
import {
  CONVERSATION_SOURCE_LIMITS,
  conversationCursorHash,
  parseJsonLine,
  readJsonlSlice,
  type ConversationRecordSource,
} from "../../adapters/sdk/src/conversation-source.js";
import {
  ConversationCursorSchema,
  isTerminalConversationStatus,
  type ConversationCursor,
  type SubagentCapabilities,
} from "../../contracts/src/conversation.js";
import {
  ConversationService,
  hasWorkingConversationDescendants,
  type ConversationApplyContext,
  type ConversationDiagnostic,
} from "../../core/src/conversation-service.js";
import { now } from "../../core/src/util.js";

export interface ConversationObserverSource {
  source_id: string;
  adapter_id: string;
  file_path?: string;
  trusted_root?: string;
  conversation_id?: string;
  record_source?: ConversationRecordSource;
}

export interface ConversationObserverOptions {
  service: ConversationService;
  context: ConversationApplyContext;
  pollIntervalMs?: number;
  maxParallelReads?: number;
  maxBytesPerRound?: number;
  maxLineBytes?: number;
}

export class ConversationObserver {
  private sources = new Map<string, ConversationObserverSource>();
  private diagnostics: ConversationDiagnostic[] = [];
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;
  private stopped = false;
  private readonly pollIntervalMs: number;
  private readonly maxParallelReads: number;
  private readonly maxBytesPerRound: number;
  private readonly maxLineBytes: number;

  constructor(private readonly options: ConversationObserverOptions) {
    this.pollIntervalMs =
      options.pollIntervalMs ?? CONVERSATION_SOURCE_LIMITS.pollIntervalMs;
    this.maxParallelReads =
      options.maxParallelReads ?? CONVERSATION_SOURCE_LIMITS.maxParallelReads;
    this.maxBytesPerRound =
      options.maxBytesPerRound ?? CONVERSATION_SOURCE_LIMITS.maxBytesPerRound;
    this.maxLineBytes =
      options.maxLineBytes ?? CONVERSATION_SOURCE_LIMITS.maxLineBytes;
  }

  addSource(source: ConversationObserverSource) {
    this.sources.set(source.source_id, source);
    const capabilities = source.record_source?.capabilities();
    if (capabilities) this.applyCapabilities(capabilities);
  }

  start() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    this.timer.unref();
    void this.poll();
  }

  async poll() {
    if (this.stopped) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.readAll().catch((error) => {
      this.recordDiagnostic({
        code: "observer_read_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
    this.releaseIfIdle();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.inflight) await this.inflight;
    this.sources.clear();
  }

  getDiagnostics(): ConversationDiagnostic[] {
    return [...this.diagnostics, ...this.options.service.getDiagnostics()];
  }

  private applyCapabilities(capabilities: SubagentCapabilities) {
    this.options.service.setCapabilities(
      this.options.context.workflow_id,
      capabilities,
    );
  }

  private async readAll() {
    const items = [...this.sources.values()];
    await runPool(items, this.maxParallelReads, (source) =>
      this.readSource(source),
    );
  }

  private async readSource(source: ConversationObserverSource) {
    if (source.record_source) {
      await this.readRecordSource(source, source.record_source);
      return;
    }
    if (!source.file_path) return;
    await this.readFileSource(source);
  }

  private async readRecordSource(
    source: ConversationObserverSource,
    record: ConversationRecordSource,
  ) {
    const cursor = this.fileCursor(source);
    const events = await record.readEvents({
      source_id: source.source_id,
      source_seq: cursor?.source_seq,
      file_identity: cursor?.file_identity,
    });
    this.applyAttributedEvents(source, events);
  }

  private async readFileSource(source: ConversationObserverSource) {
    const trusted = source.trusted_root;
    if (!trusted) {
      this.recordDiagnostic({
        code: "untrusted_path",
        message: "文件来源缺少受信任根目录",
        source_id: source.source_id,
      });
      return;
    }
    const resolved = await resolveTrustedPath(source.file_path!, trusted);
    if (resolved.malicious) {
      this.recordDiagnostic({
        code: "untrusted_path",
        message: "拒绝读取越界或恶意路径",
        source_id: source.source_id,
      });
      return;
    }
    if (!resolved.path) return;
    const stored = this.fileCursor(source);
    const slice = await readJsonlSlice({
      filePath: resolved.path,
      offsetBytes: Number(stored?.source_seq ?? "0") || 0,
      fileIdentity: stored?.file_identity,
      maxBytes: this.maxBytesPerRound,
      maxLineBytes: this.maxLineBytes,
    });
    const rotated =
      !!stored?.file_identity &&
      slice.fileIdentity !== stored.file_identity &&
      slice.lines.length === 0 &&
      slice.nextSeq === "0";
    if (slice.truncatedLine) {
      this.recordDiagnostic({
        code: "truncated_line",
        message: "单行超过上限，已跳过并继续后续事件",
        source_id: source.source_id,
      });
    }
    const nextSeq = rotated
      ? sizeFromIdentity(slice.fileIdentity) ?? slice.nextSeq
      : slice.nextSeq;
    if (!rotated) this.applyFileLines(source, slice.lines, stored?.source_seq);
    this.persistFileCursor(source, nextSeq, slice.fileIdentity);
  }

  private applyFileLines(
    source: ConversationObserverSource,
    lines: string[],
    startSeq?: string,
  ) {
    const events: NativeConversationEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      const parsed = parseJsonLine(lines[index]!);
      const event = asNativeEvent(
        parsed,
        source,
        this.options.context,
        lineSeq(startSeq, index),
      );
      if (!event) {
        this.recordDiagnostic({
          code: "unattributed_source",
          message: "来源身份不明确，未写入猜测的主会话",
          source_id: source.source_id,
        });
        continue;
      }
      events.push(event);
    }
    this.applyAttributedEvents(source, events);
  }

  private applyAttributedEvents(
    source: ConversationObserverSource,
    events: NativeConversationEvent[],
  ) {
    if (!events.length) return;
    const ctx: ConversationApplyContext = {
      ...this.options.context,
      adapter_id: source.adapter_id,
      conversation_id: source.conversation_id,
    };
    this.options.service.applyEvents(ctx, events);
  }

  private fileCursor(
    source: ConversationObserverSource,
  ): ConversationCursor | undefined {
    return this.options.service.readCursor(source.adapter_id, source.source_id);
  }

  private persistFileCursor(
    source: ConversationObserverSource,
    sourceSeq: string,
    fileIdentity: string,
  ) {
    const cursor = ConversationCursorSchema.parse({
      id: conversationCursorHash({
        adapterId: source.adapter_id,
        sourceId: source.source_id,
      }),
      workflow_id: this.options.context.workflow_id,
      adapter_id: source.adapter_id,
      source_id: source.source_id,
      source_seq: sourceSeq,
      file_identity: fileIdentity,
      applied_at: now(),
    });
    this.options.service.recordSourceCursor(cursor);
  }

  private releaseIfIdle() {
    const tree = this.options.service.getTree(this.options.context.workflow_id);
    const root = tree.nodes.find((node) => node.id === tree.active_root_id);
    const attempt = tree.attempts
      .filter((item) => item.conversation_id === root?.id)
      .sort((a, b) => a.generation - b.generation)
      .at(-1);
    if (!root || !attempt) return;
    if (!isTerminalConversationStatus(attempt.status)) return;
    if (hasWorkingConversationDescendants(tree)) return;
    void this.stop();
  }

  private recordDiagnostic(diagnostic: ConversationDiagnostic) {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > 200)
      this.diagnostics.splice(0, this.diagnostics.length - 200);
  }
}

function lineSeq(startSeq: string | undefined, index: number): string {
  if (startSeq && /^\d+$/.test(startSeq)) {
    try {
      return String(BigInt(startSeq) + BigInt(index));
    } catch {
      return `${startSeq}:${index}`;
    }
  }
  return `${startSeq ?? "0"}:${index}`;
}

function sizeFromIdentity(identity: string): string | undefined {
  const parts = identity.split(":");
  return parts.length >= 3 && /^\d+$/.test(parts[2]!) ? parts[2] : undefined;
}

function asNativeEvent(
  value: unknown,
  source: ConversationObserverSource,
  ctx: ConversationApplyContext,
  sourceSeq: string,
): NativeConversationEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  const kind = row.kind;
  if (
    kind !== "discovered" &&
    kind !== "state" &&
    kind !== "activity" &&
    kind !== "model" &&
    kind !== "quota"
  )
    return undefined;
  const root = readText(row.root_native_id) ?? ctx.root_native_id;
  if (!root && !source.conversation_id) return undefined;
  const session = readText(row.session_native_id);
  const agent = readText(row.agent_native_id);
  const parent = readText(row.parent_native_id);
  if (
    !session &&
    !agent &&
    !parent &&
    !source.conversation_id &&
    kind !== "discovered" &&
    kind !== "state"
  )
    return undefined;
  if (!root && !session && !agent && !source.conversation_id) return undefined;
  return {
    source_id: readText(row.source_id) ?? source.source_id,
    source_seq: readText(row.source_seq) ?? sourceSeq,
    root_native_id: root ?? session ?? source.conversation_id!,
    session_native_id: session,
    agent_native_id: agent,
    parent_native_id: parent,
    kind,
    occurred_at: readText(row.occurred_at),
    payload: row.payload ?? {},
  };
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function resolveTrustedPath(
  filePath: string,
  trustedRoot: string,
): Promise<{ path?: string; malicious: boolean }> {
  if (!filePath || filePath.includes("\0"))
    return { malicious: true };
  const root = resolve(trustedRoot);
  const candidate = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  if (escapesRoot(root, candidate)) return { malicious: true };
  try {
    const actualRoot = await realpath(root);
    const actual = await realpath(candidate);
    if (escapesRoot(actualRoot, actual)) return { malicious: true };
    return { path: actual, malicious: false };
  } catch {
    return { malicious: false };
  }
}

function escapesRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= limit) await Promise.race(pending);
  }
  await Promise.all([...pending]);
}
