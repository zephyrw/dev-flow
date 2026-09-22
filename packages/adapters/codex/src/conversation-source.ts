import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { SubagentCapabilitiesSchema } from "../../../contracts/src/conversation.js";
import type {
  ConversationSourceCursor,
  HostChunk,
  NativeConversationEvent,
} from "../../sdk/src/interface.js";
import {
  parseJsonLine,
  readJsonlSlice,
  type ConversationRecordSource,
} from "../../sdk/src/conversation-source.js";
import { toolSummary } from "../../../presentation/src/tool-summary.js";

export const CODEX_ADAPTER_ID = "codex";
export const CODEX_UNPAID_REASON = "未用真实付费调用验证";
export const CODEX_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EXEC_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);
const SESSION_RECORD_TYPES = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
]);
const SPAWN_ITEM_TYPES = new Set([
  "agent",
  "collab_agent_tool_call",
  "collabAgentToolCall",
]);
const SPAWN_TOOL_NAMES = new Set(["spawn_agent", "assign_agent_task"]);
const ACTIVITY_ITEM_TYPES = new Set([
  "command_execution",
  "agent_message",
  "file_change",
  "mcp_tool_call",
  "web_search",
  "image_generation",
]);
const SKIP_ITEM_TYPES = new Set([
  "agent_reasoning",
  "reasoning",
  "todo_list",
  "image_view",
  "local_shell_call",
  "function_call",
  "proposed_plan",
]);

const DiscoveredPayloadSchema = z
  .object({
    spawn_call_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    task_summary: z.string().max(500).optional(),
    continuation: z
      .enum(["resume-native", "recreate-after-confirmed-exit"])
      .optional(),
    replaces_native_id: z.string().min(1).optional(),
  })
  .strict();

const StatePayloadSchema = z
  .object({
    status: z.string().min(1),
    reason: z.string().min(1).optional(),
    continuation: z
      .enum(["resume-native", "recreate-after-confirmed-exit"])
      .optional(),
    root_process_exit: z.boolean().optional(),
    descendants_terminal: z.boolean().optional(),
  })
  .strict();

const ActivityPayloadSchema = z
  .object({
    activity_id: z.string().min(1).optional(),
    public_text: z.string().max(16000).optional(),
    title: z.string().max(200).optional(),
    command: z.string().max(32000).optional(),
    status: z.string().min(1).optional(),
  })
  .strict();

const ModelPayloadSchema = z
  .object({
    actual_model: z.string().min(1).optional(),
    actual_effort: z.string().min(1).optional(),
    model_source: z.enum(["native_event", "native_session"]),
  })
  .strict();

const QuotaPayloadSchema = z
  .object({
    rate_limits: z.unknown(),
    source: z.enum(["native_event", "native_session"]),
  })
  .strict();

export interface CodexVersionParts {
  major: number;
  minor: number;
  patch: number;
}

export interface CodexBoundSourceInput {
  filePath: string;
  rootNativeId: string;
  sessionNativeId?: string;
  parentNativeId?: string;
}

export interface CodexContinuationInput {
  sameNativeSession: boolean;
  confirmedExited: boolean;
}

let cachedInstalledVersion: string | undefined | false;

export function parseCodexCliVersion(
  text?: string,
): string | undefined {
  if (!text) return undefined;
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}`;
}

export function parseCodexVersionParts(
  version?: string,
): CodexVersionParts | undefined {
  const parsed = parseCodexCliVersion(version);
  if (!parsed) return undefined;
  const [major, minor, patch] = parsed.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    !Number.isInteger(patch)
  )
    return undefined;
  return { major, minor, patch };
}

export function codexProtocolCompatible(version?: string): boolean {
  const parts = parseCodexVersionParts(version);
  if (!parts) return false;
  if (parts.major !== 0) return false;
  return parts.minor >= 40;
}

export function collectInstalledCodexCliVersion(): string | undefined {
  if (cachedInstalledVersion === false) return undefined;
  if (cachedInstalledVersion) return cachedInstalledVersion;
  try {
    const result = spawnSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const version = parseCodexCliVersion(text);
    cachedInstalledVersion = version ?? false;
    return version;
  } catch {
    cachedInstalledVersion = false;
    return undefined;
  }
}

export function protocolMismatchReason(version?: string): string {
  if (!version) return `未能采集本机 Codex 版本；${CODEX_UNPAID_REASON}`;
  return `版本协议不符：${version}；${CODEX_UNPAID_REASON}`;
}

export function codexSubagentCapabilities(
  cliVersion?: string,
): SubagentCapabilities {
  const version = parseCodexCliVersion(cliVersion) ?? cliVersion;
  if (version && !codexProtocolCompatible(version)) {
    return SubagentCapabilitiesSchema.parse({
      discovery: "unknown",
      activity: "unavailable",
      stop: "unavailable",
      resume: "unavailable",
      readonly_delegation: "unknown",
      file_input: { text: false, image: false, binary: false },
      cli_version: version,
      reason: protocolMismatchReason(version),
    });
  }
  return SubagentCapabilitiesSchema.parse({
    discovery: version ? "native" : "unknown",
    activity: version ? "native" : "unavailable",
    stop: version ? "owned-process-tree" : "unavailable",
    resume: version ? "native" : "unavailable",
    readonly_delegation: "unknown",
    file_input: { text: true, image: true, binary: false },
    cli_version: version,
    reason: version ? CODEX_UNPAID_REASON : protocolMismatchReason(version),
  });
}

export function continuationForCodexSession(
  input: CodexContinuationInput,
): "resume-native" | "recreate-after-confirmed-exit" {
  if (input.sameNativeSession) return "resume-native";
  if (input.confirmedExited) return "recreate-after-confirmed-exit";
  return "resume-native";
}

export function rootProcessExitState(): {
  status: string;
  reason: string;
  root_process_exit: boolean;
  descendants_terminal: boolean;
} {
  return {
    status: "interrupted",
    reason: "process_exit",
    root_process_exit: true,
    descendants_terminal: false,
  };
}

export function codexSessionSourceId(sessionId: string): string {
  return `${CODEX_ADAPTER_ID}:session:${sessionId}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function uuidField(value: unknown): string | undefined {
  const text = stringField(value);
  if (!text || !CODEX_SESSION_ID.test(text)) return undefined;
  return text;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  return asRecord(parseJsonLine(value));
}

function eventBase(params: {
  sourceId: string;
  sourceSeq: string;
  rootNativeId: string;
  session?: string;
  agent?: string;
  parent?: string;
  kind: NativeConversationEvent["kind"];
  occurredAt?: string;
  payload: unknown;
}): NativeConversationEvent {
  return {
    source_id: params.sourceId,
    source_seq: params.sourceSeq,
    root_native_id: params.rootNativeId,
    session_native_id: params.session,
    agent_native_id: params.agent,
    parent_native_id: params.parent,
    kind: params.kind,
    occurred_at: params.occurredAt,
    payload: params.payload,
  };
}

function envelopeThread(record: Record<string, unknown>): string | undefined {
  return uuidField(
    record.thread_id ?? record.session_id ?? record.conversation_id,
  );
}

function itemTypeOf(item: Record<string, unknown>): string | undefined {
  return stringField(item.type);
}

function toolNameOf(item: Record<string, unknown>): string | undefined {
  return stringField(item.tool ?? item.name);
}

function isSpawnItem(item: Record<string, unknown>): boolean {
  const type = itemTypeOf(item);
  if (type && SPAWN_ITEM_TYPES.has(type)) return true;
  return (
    type === "mcp_tool_call" &&
    Boolean(toolNameOf(item) && SPAWN_TOOL_NAMES.has(toolNameOf(item)!))
  );
}

function spawnCallId(item: Record<string, unknown>): string | undefined {
  return stringField(item.id ?? item.call_id ?? item.tool_call_id);
}

function spawnChildId(
  item: Record<string, unknown>,
  envelope: string | undefined,
): string | undefined {
  const result = nestedRecord(item.result);
  const agent = asRecord(item.agent);
  const candidates = [
    item.child_thread_id,
    result?.thread_id,
    result?.child_thread_id,
    agent?.thread_id,
    item.thread_id,
  ];
  for (const candidate of candidates) {
    const id = uuidField(candidate);
    if (id && id !== envelope) return id;
  }
  return undefined;
}

function spawnAgentId(item: Record<string, unknown>): string | undefined {
  const agent = asRecord(item.agent);
  return stringField(
    item.agent_id ??
      item.agentId ??
      item.agent_nickname ??
      agent?.id ??
      agent?.nickname,
  );
}

function spawnTitle(item: Record<string, unknown>): string | undefined {
  const agent = asRecord(item.agent);
  return stringField(
    item.agent_nickname ??
      item.title ??
      agent?.nickname ??
      agent?.role ??
      item.agent_id,
  )?.slice(0, 200);
}

function spawnSummary(item: Record<string, unknown>): string | undefined {
  const input = asRecord(item.input) ?? nestedRecord(item.arguments);
  return stringField(
    item.task_summary ?? input?.prompt ?? input?.message ?? item.text,
  )?.slice(0, 500);
}

function itemStatus(item: Record<string, unknown>, eventType: string): string {
  const raw = stringField(item.status);
  if (raw === "paused") return "paused";
  if (raw === "interrupted" || raw === "cancelled") return "interrupted";
  if (raw === "failed" || raw === "error") return "failed";
  if (raw === "completed" || eventType === "item.completed") {
    if (item.error) return "failed";
    if (typeof item.exit_code === "number" && item.exit_code !== 0)
      return "failed";
    return "completed";
  }
  if (eventType === "item.started") return "starting";
  return "running";
}

function activityStatus(eventType: string, item: Record<string, unknown>): string {
  const failed =
    stringField(item.status) === "failed" ||
    Boolean(item.error) ||
    (typeof item.exit_code === "number" && item.exit_code !== 0);
  if (failed) return "error";
  if (eventType === "item.completed") return "done";
  return "active";
}

function activityTitle(
  type: string,
  item?: Record<string, unknown>,
): string | undefined {
  if (type === "command_execution") return "执行命令";
  if (type === "file_change") return "修改文件";
  if (type === "agent_message") return "模型输出";
  if (type === "web_search") return "搜索网页";
  if (type === "mcp_tool_call") {
    const summary = toolSummary(
      stringField(item?.tool ?? item?.name),
      asRecord(item?.arguments) ?? {},
    );
    return (
      summary.title ??
      `工具 · ${stringField(item?.tool ?? item?.name) ?? "MCP"}`
    );
  }
  if (type === "image_generation") return "生成图片";
  return undefined;
}

function publicActivityText(item: Record<string, unknown>): string | undefined {
  const type = itemTypeOf(item);
  if (type === "command_execution")
    return stringField(item.command)?.slice(0, 16000);
  if (type === "agent_message") return stringField(item.text)?.slice(0, 16000);
  if (type === "web_search") return stringField(item.query)?.slice(0, 16000);
  if (type === "mcp_tool_call") {
    const summary = toolSummary(
      stringField(item.tool ?? item.name),
      asRecord(item.arguments) ?? {},
    );
    return (
      summary.text ||
      stringField(item.tool ?? item.name) ||
      "MCP 工具"
    )?.slice(0, 16000);
  }
  if (type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const path = changes
      .map((entry) => stringField(asRecord(entry)?.path))
      .find(Boolean);
    return path?.slice(0, 16000);
  }
  return stringField(item.text)?.slice(0, 16000);
}

function quotaFrom(record: Record<string, unknown>): unknown | undefined {
  if (record.rate_limits) return record.rate_limits;
  const item = asRecord(record.item);
  if (item?.rate_limits) return item.rate_limits;
  return undefined;
}

function errorLooksLikeQuota(record: Record<string, unknown>): boolean {
  const error = asRecord(record.error) ?? record;
  const text = `${stringField(error.message) ?? ""} ${stringField(error.code) ?? ""}`.toLowerCase();
  return /quota|rate.?limit|usage.?limit/.test(text);
}

export function decodeCodexExecRecord(
  record: Record<string, unknown>,
  context: {
    sourceId: string;
    sourceSeq: string;
    rootNativeId: string;
    parentNativeId?: string;
    agentNativeId?: string;
    occurredAt?: string;
  },
): NativeConversationEvent[] {
  const type = stringField(record.type ?? record.event);
  if (!type || !EXEC_EVENT_TYPES.has(type)) return [];
  const session = envelopeThread(record) ?? context.rootNativeId;
  const parent =
    session === context.rootNativeId ? undefined : context.parentNativeId;
  const occurredAt = stringField(record.timestamp) ?? context.occurredAt;
  const base = {
    sourceId: context.sourceId,
    rootNativeId: context.rootNativeId,
    session,
    agent: context.agentNativeId,
    parent,
    occurredAt,
  };
  if (type === "thread.started") {
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:discovered`,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          continuation: continuationForCodexSession({
            sameNativeSession: true,
            confirmedExited: false,
          }),
        }),
      }),
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:state`,
        kind: "state",
        payload: StatePayloadSchema.parse({
          status: "starting",
          continuation: "resume-native",
        }),
      }),
    ];
  }
  if (type === "turn.started") {
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:state`,
        kind: "state",
        payload: StatePayloadSchema.parse({ status: "running" }),
      }),
    ];
  }
  if (type === "turn.completed") {
    const events: NativeConversationEvent[] = [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:state`,
        kind: "state",
        payload: StatePayloadSchema.parse({
          status: "waiting",
          descendants_terminal: false,
        }),
      }),
    ];
    const quota = quotaFrom(record);
    if (quota)
      events.push(
        eventBase({
          ...base,
          sourceSeq: `${context.sourceSeq}:quota`,
          kind: "quota",
          payload: QuotaPayloadSchema.parse({
            rate_limits: quota,
            source: "native_event",
          }),
        }),
      );
    return events;
  }
  if (type === "turn.failed" || type === "error") {
    const quota = errorLooksLikeQuota(record);
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:state`,
        kind: "state",
        payload: StatePayloadSchema.parse({
          status: quota ? "failed" : "interrupted",
          reason: quota ? "quota" : "native_error",
          descendants_terminal: false,
        }),
      }),
    ];
  }
  if (!/^item\.(started|updated|completed)$/.test(type)) return [];
  const item = asRecord(record.item);
  if (!item) return [];
  return decodeCodexItem(item, type, context, base, record);
}

function decodeCodexItem(
  item: Record<string, unknown>,
  eventType: string,
  context: {
    sourceId: string;
    sourceSeq: string;
    rootNativeId: string;
    parentNativeId?: string;
    agentNativeId?: string;
    occurredAt?: string;
  },
  base: {
    sourceId: string;
    rootNativeId: string;
    session?: string;
    agent?: string;
    parent?: string;
    occurredAt?: string;
  },
  record: Record<string, unknown>,
): NativeConversationEvent[] {
  const type = itemTypeOf(item);
  if (!type) return [];
  if (SKIP_ITEM_TYPES.has(type)) return [];
  if (isSpawnItem(item))
    return decodeSpawnItem(item, eventType, context, base);
  if (!ACTIVITY_ITEM_TYPES.has(type)) return [];
  const events: NativeConversationEvent[] = [
    eventBase({
      ...base,
      sourceSeq: `${context.sourceSeq}:activity`,
      kind: "activity",
      payload: ActivityPayloadSchema.parse({
        activity_id: spawnCallId(item),
        public_text: publicActivityText(item),
        title: activityTitle(type, item),
        command:
          type === "command_execution"
            ? stringField(item.command)?.slice(0, 32000)
            : undefined,
        status: activityStatus(eventType, item),
      }),
    }),
  ];
  const quota = quotaFrom(record) ?? quotaFrom(item);
  if (quota)
    events.push(
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:quota`,
        kind: "quota",
        payload: QuotaPayloadSchema.parse({
          rate_limits: quota,
          source: "native_event",
        }),
      }),
    );
  return events;
}

function childLaunchStatus(eventType: string, status: string): string {
  if (status === "failed" || status === "paused" || status === "interrupted")
    return status;
  if (eventType === "item.started") return "starting";
  return "running";
}

function spawnLifecycleEvents(
  sessionId: string,
  agentId: string | undefined,
  parentId: string | undefined,
  status: string,
  continuation: "resume-native" | "recreate-after-confirmed-exit",
  context: {
    sourceId: string;
    sourceSeq: string;
    rootNativeId: string;
  },
  occurredAt?: string,
): NativeConversationEvent[] {
  return [
    eventBase({
      sourceId: context.sourceId,
      sourceSeq: `${context.sourceSeq}:state`,
      rootNativeId: context.rootNativeId,
      session: sessionId,
      agent: agentId,
      parent: parentId,
      kind: "state",
      occurredAt,
      payload: StatePayloadSchema.parse({ status, continuation }),
    }),
  ];
}

function decodeSpawnItem(
  item: Record<string, unknown>,
  eventType: string,
  context: {
    sourceId: string;
    sourceSeq: string;
    rootNativeId: string;
    parentNativeId?: string;
    agentNativeId?: string;
    occurredAt?: string;
  },
  base: {
    sourceId: string;
    rootNativeId: string;
    session?: string;
    agent?: string;
    parent?: string;
    occurredAt?: string;
  },
): NativeConversationEvent[] {
  const parentId = base.session ?? context.rootNativeId;
  const childId = spawnChildId(item, parentId);
  const agentId = spawnAgentId(item) ?? context.agentNativeId;
  const status = itemStatus(item, eventType);
  const replaces = uuidField(
    item.replaces_thread_id ?? item.replaces_native_id,
  );
  const callId = spawnCallId(item);
  if (!childId) {
    if (parentId && parentId !== context.rootNativeId) {
      return spawnLifecycleEvents(
        parentId,
        agentId,
        context.parentNativeId,
        status,
        continuationForCodexSession({
          sameNativeSession: true,
          confirmedExited: status === "completed" || status === "failed",
        }),
        context,
        base.occurredAt,
      );
    }
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:activity`,
        kind: "activity",
        payload: ActivityPayloadSchema.parse({
          activity_id: callId,
          public_text: spawnTitle(item) ?? "委派子 Agent",
          title: "委派子 Agent",
          status: activityStatus(eventType, item),
        }),
      }),
    ];
  }
  const continuation = continuationForCodexSession({
    sameNativeSession: !replaces,
    confirmedExited: Boolean(replaces),
  });
  return [
    eventBase({
      sourceId: context.sourceId,
      sourceSeq: `${context.sourceSeq}:discovered`,
      rootNativeId: context.rootNativeId,
      session: childId,
      agent: agentId,
      parent: parentId,
      kind: "discovered",
      occurredAt: base.occurredAt,
      payload: DiscoveredPayloadSchema.parse({
        spawn_call_id: callId,
        title: spawnTitle(item),
        task_summary: spawnSummary(item),
        continuation,
        replaces_native_id: replaces,
      }),
    }),
    ...spawnLifecycleEvents(
      childId,
      agentId,
      parentId,
      childLaunchStatus(eventType, status),
      continuation,
      context,
      base.occurredAt,
    ),
  ];
}

export function decodeCodexSessionRecord(
  record: Record<string, unknown>,
  context: {
    sourceId: string;
    sourceSeq: string;
    rootNativeId: string;
    sessionNativeId: string;
    parentNativeId?: string;
    occurredAt?: string;
  },
): NativeConversationEvent[] {
  const type = stringField(record.type);
  if (!type || !SESSION_RECORD_TYPES.has(type)) return [];
  const payload = asRecord(record.payload) ?? {};
  const occurredAt = stringField(record.timestamp) ?? context.occurredAt;
  const session = context.sessionNativeId;
  const parent =
    session === context.rootNativeId ? undefined : context.parentNativeId;
  const base = {
    sourceId: context.sourceId,
    rootNativeId: context.rootNativeId,
    session,
    parent,
    occurredAt,
  };
  if (type === "session_meta") {
    const id = uuidField(payload.id);
    if (id && id !== session) return [];
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:discovered`,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          continuation: "resume-native",
        }),
      }),
    ];
  }
  if (type === "turn_context") {
    const model = stringField(payload.model);
    const effort = stringField(payload.effort);
    if (!model && !effort) return [];
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:model`,
        kind: "model",
        payload: ModelPayloadSchema.parse({
          actual_model: model,
          actual_effort: effort,
          model_source: "native_session",
        }),
      }),
    ];
  }
  if (type === "event_msg") {
    const msgType = stringField(payload.type);
    if (msgType !== "token_count" || !payload.rate_limits) return [];
    return [
      eventBase({
        ...base,
        sourceSeq: `${context.sourceSeq}:quota`,
        kind: "quota",
        payload: QuotaPayloadSchema.parse({
          rate_limits: payload.rate_limits,
          source: "native_session",
        }),
      }),
    ];
  }
  return [];
}

export class CodexStreamMapper {
  private rootThreadId?: string;
  private parentByChild = new Map<string, string>();
  private agentBySession = new Map<string, string>();
  private seq = 0;

  constructor(private sourceId = "codex:stream") {}

  bindRoot(threadId: string) {
    if (!this.rootThreadId) this.rootThreadId = threadId;
  }

  decodeLine(line: string, occurredAt?: string): NativeConversationEvent[] {
    const raw = parseJsonLine(line);
    const record = asRecord(raw);
    if (!record) return [];
    const type = stringField(record.type ?? record.event);
    if (!type) return [];
    if (!EXEC_EVENT_TYPES.has(type)) return [];
    this.seq += 1;
    const envelope = envelopeThread(record);
    if (type === "thread.started" && envelope) this.noteThreadStarted(envelope);
    const spawn = this.noteSpawn(record);
    const session = envelope ?? this.rootThreadId;
    if (!session) return [];
    if (
      type === "thread.started" &&
      envelope &&
      this.rootThreadId &&
      envelope !== this.rootThreadId &&
      !this.parentByChild.has(envelope)
    )
      return [];
    return decodeCodexExecRecord(record, {
      sourceId: this.sourceId,
      sourceSeq: String(this.seq),
      rootNativeId: this.rootThreadId ?? session,
      parentNativeId: spawn.parentId ?? this.parentByChild.get(session),
      agentNativeId: spawn.agentId ?? this.agentBySession.get(session),
      occurredAt,
    });
  }

  private noteThreadStarted(threadId: string) {
    if (!this.rootThreadId) this.bindRoot(threadId);
  }

  private noteSpawn(record: Record<string, unknown>): {
    parentId?: string;
    agentId?: string;
  } {
    const item = asRecord(record.item);
    if (!item || !isSpawnItem(item)) return {};
    const parentId = envelopeThread(record) ?? this.rootThreadId;
    const childId = spawnChildId(item, parentId);
    const agentId = spawnAgentId(item);
    if (childId && parentId) {
      this.parentByChild.set(childId, parentId);
      if (agentId) this.agentBySession.set(childId, agentId);
    }
    return { parentId, agentId };
  }
}

export class CodexConversationDecoder {
  private buffer = "";
  private readonly mapper: CodexStreamMapper;

  constructor(sourceId = "codex:stream") {
    this.mapper = new CodexStreamMapper(sourceId);
  }

  push(chunk: HostChunk): NativeConversationEvent[] {
    if (chunk.stream && chunk.stream !== "stdout") return [];
    this.buffer +=
      typeof chunk.data === "string"
        ? chunk.data
        : Buffer.from(chunk.data).toString("utf8");
    if (chunk.final) this.buffer += "\n";
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024)
      throw new Error("CLI 事件单行超出 4 MiB 限制");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const events: NativeConversationEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(...this.mapper.decodeLine(line, chunk.timestamp));
    }
    return events;
  }
}

export class CodexConversationSource implements ConversationRecordSource {
  readonly adapterId = CODEX_ADAPTER_ID;
  readonly sourceId: string;
  private readonly mapper: CodexStreamMapper;

  constructor(
    private readonly bound: CodexBoundSourceInput,
    private readonly cliVersion?: string,
  ) {
    this.sourceId = bound.filePath;
    this.mapper = new CodexStreamMapper(this.sourceId);
    this.mapper.bindRoot(bound.rootNativeId);
  }

  capabilities(): SubagentCapabilities {
    return codexSubagentCapabilities(this.cliVersion);
  }

  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const offset = Number(cursor.source_seq ?? "0");
    const slice = await readJsonlSlice({
      filePath: this.bound.filePath,
      offsetBytes: Number.isFinite(offset) ? offset : 0,
      fileIdentity: cursor.file_identity,
    });
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines)
      events.push(...this.mapper.decodeLine(line));
    if (!events.length && this.bound.sessionNativeId) {
      for (const [index, line] of slice.lines.entries()) {
        const raw = asRecord(parseJsonLine(line));
        if (!raw) continue;
        events.push(
          ...decodeCodexSessionRecord(raw, {
            sourceId: this.sourceId,
            sourceSeq: String(index),
            rootNativeId: this.bound.rootNativeId,
            sessionNativeId: this.bound.sessionNativeId,
            parentNativeId: this.bound.parentNativeId,
          }),
        );
      }
    }
    return events;
  }
}
