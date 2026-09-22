import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type {
  ConversationSourceCursor,
  NativeConversationEvent,
} from "../../sdk/src/interface.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import {
  conversationCursorHash,
  parseJsonLine,
  readJsonlSlice,
  type ConversationRecordSource,
} from "../../sdk/src/conversation-source.js";

export const GROK_ADAPTER_ID = "grok-build";
export const GROK_SPAWN_TOOL = "spawn_subagent";
const GROK_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROK_SAFE_CHILD_ID = /^[A-Za-z0-9._-]{1,128}$/;
const READONLY_CHILD_TYPES = new Set([
  "explore",
  "plan",
  "devflow-readonly-child",
]);
const READONLY_TOOLS = new Set([
  "read",
  "read_file",
  "grep",
  "glob",
  "list_dir",
]);
const WRITE_TOOLS = new Set([
  "write",
  "search_replace",
  "run_terminal_command",
  "bash",
  "edit",
  "mcptool",
]);
const STREAM_TYPES = new Set([
  "tool_call",
  "tool_call_update",
  "text",
  "end",
  "error",
  "usage",
  "plan",
  "available_commands",
]);
const BOUND_EVENT_TYPES = new Set([
  "turn_started",
  "turn_ended",
  "tool_call",
]);
const ACP_UPDATES = new Set([
  "tool_call",
  "tool_call_update",
  "turn_completed",
  "agent_message_chunk",
]);

export type GrokWriteRestriction = "restricted" | "unrestricted" | "unknown";
export type GrokBoundKind = "events" | "updates" | "summary" | "meta";

export interface GrokSpawnFacts {
  tool_call_id: string;
  subagent_type?: string;
  description?: string;
  write_restriction: GrokWriteRestriction;
  subagent_id?: string;
  session_id?: string;
  agent_id?: string;
}

export interface GrokBoundSourceOptions {
  grokHome: string;
  workspaceRoot: string;
  sessionId: string;
  rootSessionId?: string;
}

interface GrokStreamState {
  rootNativeId: string;
  nextSeq: number;
  spawns: Map<string, GrokSpawnFacts>;
}

export function grokSubagentsDefaultDisabled(): boolean {
  return false;
}

export function grokSubagentCapabilities(cliVersion?: string): SubagentCapabilities {
  return {
    discovery: "native",
    activity: "native",
    stop: "owned-process-tree",
    resume: "native",
    readonly_delegation: "verified",
    file_input: { text: false, image: false, binary: false },
    cli_version: cliVersion,
    reason:
      "streaming-json 原生 spawn_subagent 默认可用；只读委派须走 explore/plan 或只读自定义 agent，写工具仍拒绝。headless 附件入参未接入，不把 read_file 冒充 file_input。",
  };
}

export function grokDefaultHome(): string {
  return process.env.GROK_HOME || join(homedir(), ".grok");
}

export function grokBoundSourceId(
  kind: GrokBoundKind,
  sessionId: string,
  childId?: string,
): string {
  if (kind === "meta" && childId) {
    return [GROK_ADAPTER_ID, kind, sessionId, childId].join(":");
  }
  return [GROK_ADAPTER_ID, kind, sessionId].join(":");
}

export function parseGrokBoundSourceId(sourceId: string): {
  kind: GrokBoundKind;
  sessionId: string;
  childId?: string;
} | undefined {
  const parts = sourceId.split(":");
  if (parts[0] !== GROK_ADAPTER_ID) return;
  const kind = parts[1];
  if (!kind || !isBoundKind(kind)) return;
  const sessionId = parts[2];
  if (!sessionId || !GROK_SESSION_ID.test(sessionId)) return;
  if (kind === "meta") {
    const childId = parts[3];
    if (!childId || !GROK_SAFE_CHILD_ID.test(childId)) return;
    return { kind, sessionId, childId };
  }
  if (parts.length !== 3) return;
  return { kind, sessionId };
}

export function classifyGrokWriteRestriction(input: {
  subagentType?: string;
  tools?: string[];
}): GrokWriteRestriction {
  const tools = (input.tools ?? []).map((name) => name.toLowerCase());
  if (tools.some((name) => WRITE_TOOLS.has(name))) return "unrestricted";
  if (tools.length > 0 && tools.every((name) => READONLY_TOOLS.has(name))) {
    return "restricted";
  }
  if (input.subagentType && READONLY_CHILD_TYPES.has(input.subagentType)) {
    return "restricted";
  }
  if (input.subagentType === "general-purpose") return "unrestricted";
  if (input.subagentType) return "unknown";
  return "unknown";
}

export function decodeGrokStreamingJsonLine(
  line: string,
  state: GrokStreamState,
  sourceId = grokStreamSourceId(state.rootNativeId),
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  if (!raw) return [];
  return decodeGrokObject(raw, state, sourceId);
}

export function createGrokStreamState(rootNativeId = "unbound-root"): GrokStreamState {
  return { rootNativeId, nextSeq: 0, spawns: new Map() };
}

export class GrokStreamDecoder {
  private buffer = "";
  private readonly state: GrokStreamState;
  constructor(rootNativeId = "unbound-root") {
    this.state = createGrokStreamState(rootNativeId);
  }
  push(data: string, final = false): NativeConversationEvent[] {
    this.buffer += data;
    if (final && this.buffer.length > 0 && !this.buffer.endsWith("\n")) {
      this.buffer += "\n";
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const events: NativeConversationEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(
        ...decodeGrokStreamingJsonLine(
          line,
          this.state,
          grokStreamSourceId(this.state.rootNativeId),
        ),
      );
    }
    return events;
  }
}

export class GrokBoundConversationSource implements ConversationRecordSource {
  readonly adapterId = GROK_ADAPTER_ID;
  constructor(private readonly options: GrokBoundSourceOptions) {
    if (!GROK_SESSION_ID.test(options.sessionId)) {
      throw new Error("Grok 会话标识无效");
    }
  }
  capabilities(): SubagentCapabilities {
    return grokSubagentCapabilities();
  }
  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const parsed = parseGrokBoundSourceId(cursor.source_id);
    if (!parsed) return [];
    if (parsed.sessionId !== this.options.sessionId) return [];
    if (parsed.kind === "summary") return this.readSummary(cursor);
    if (parsed.kind === "meta") return this.readMeta(parsed.childId, cursor);
    return this.readJsonl(parsed.kind, cursor);
  }
  sessionDirectory(): string {
    return grokSessionDirectory(
      this.options.grokHome,
      this.options.workspaceRoot,
      this.options.sessionId,
    );
  }
  private async readJsonl(
    kind: "events" | "updates",
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const filePath = join(this.sessionDirectory(), kind + ".jsonl");
    const slice = await readJsonlSlice({
      filePath,
      offsetBytes: Number(cursor.source_seq ?? "0") || 0,
      fileIdentity: cursor.file_identity,
    }).catch(() => undefined);
    if (!slice) return [];
    const state = createGrokStreamState(
      this.options.rootSessionId ?? this.options.sessionId,
    );
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) {
      const decoded =
        kind === "updates"
          ? decodeGrokAcpUpdateLine(line, state, cursor.source_id)
          : decodeGrokBoundEventLine(line, state, cursor.source_id);
      events.push(...decoded);
    }
    return events;
  }
  private async readSummary(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (cursor.source_seq && cursor.source_seq !== "0") return [];
    const filePath = join(this.sessionDirectory(), "summary.json");
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (!text.trim()) return [];
    return decodeGrokSummary(parseJsonLine(text), this.summaryContext());
  }
  private async readMeta(
    childId: string | undefined,
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (!childId || (cursor.source_seq && cursor.source_seq !== "0")) return [];
    const filePath = join(this.sessionDirectory(), "subagents", childId, "meta.json");
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (!text.trim()) return [];
    return decodeGrokSubagentMeta(parseJsonLine(text), {
      sourceId: grokBoundSourceId("meta", this.options.sessionId, childId),
      rootNativeId: this.options.rootSessionId ?? this.options.sessionId,
      parentNativeId: this.options.sessionId,
    });
  }
  private summaryContext() {
    return {
      sourceId: grokBoundSourceId("summary", this.options.sessionId),
      rootNativeId: this.options.rootSessionId ?? this.options.sessionId,
      sessionId: this.options.sessionId,
    };
  }
}

export async function listGrokBoundMetaSources(
  options: GrokBoundSourceOptions,
): Promise<string[]> {
  const dir = join(
    grokSessionDirectory(options.grokHome, options.workspaceRoot, options.sessionId),
    "subagents",
  );
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => GROK_SAFE_CHILD_ID.test(name))
    .map((name) => grokBoundSourceId("meta", options.sessionId, name));
}

export function grokSessionDirectory(
  grokHome: string,
  workspaceRoot: string,
  sessionId: string,
): string {
  if (!GROK_SESSION_ID.test(sessionId)) {
    throw new Error("Grok 会话标识无效");
  }
  return join(grokHome, "sessions", encodeURIComponent(workspaceRoot), sessionId);
}

function grokStreamSourceId(rootNativeId: string): string {
  return conversationCursorHash({
    adapterId: GROK_ADAPTER_ID,
    sourceId: "stream",
    conversationId: rootNativeId,
  });
}

function isBoundKind(value: string): value is GrokBoundKind {
  return (
    value === "events" ||
    value === "updates" ||
    value === "summary" ||
    value === "meta"
  );
}

function decodeGrokObject(
  raw: unknown,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const record = asRecord(raw);
  if (!record) return [];
  const type = asString(record.type);
  if (!type) return [];
  if (type === "thought") return [];
  if (!STREAM_TYPES.has(type)) return [];
  if (type === "end") return decodeStreamEnd(record, state, sourceId);
  if (type === "tool_call") return decodeStreamToolCall(record, state, sourceId);
  if (type === "tool_call_update") {
    return decodeStreamToolUpdate(record, state, sourceId);
  }
  if (type === "usage") return decodeStreamUsage(record, state, sourceId);
  if (type === "text") return decodeStreamText(record, state, sourceId);
  if (type === "error") return decodeStreamError(record, state, sourceId);
  return [];
}

function decodeGrokBoundEventLine(
  line: string,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  const record = asRecord(raw);
  if (!record) return [];
  const type = asString(record.type);
  if (!type || !BOUND_EVENT_TYPES.has(type)) return [];
  if (type === "turn_started") return decodeTurnStarted(record, state, sourceId);
  if (type === "turn_ended") return decodeTurnEnded(record, state, sourceId);
  return decodeStreamToolCall(record, state, sourceId);
}

function decodeGrokAcpUpdateLine(
  line: string,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  const record = asRecord(raw);
  if (!record) return [];
  if (record.method !== "session/update") return [];
  const params = asRecord(record.params);
  const update = asRecord(params?.update);
  if (!params || !update) return [];
  const sessionId = asString(params.sessionId);
  if (sessionId && GROK_SESSION_ID.test(sessionId)) {
    state.rootNativeId = sessionId;
  }
  const sessionUpdate = asString(update.sessionUpdate);
  if (!sessionUpdate || !ACP_UPDATES.has(sessionUpdate)) return [];
  if (sessionUpdate === "tool_call") {
    return decodeStreamToolCall(
      { ...update, type: "tool_call", sessionId },
      state,
      sourceId,
    );
  }
  if (sessionUpdate === "tool_call_update") {
    return decodeStreamToolUpdate(
      { ...update, type: "tool_call_update", sessionId },
      state,
      sourceId,
    );
  }
  if (sessionUpdate === "turn_completed") {
    return decodeTurnEnded(
      { type: "turn_ended", outcome: "completed", session_id: sessionId },
      state,
      sourceId,
    );
  }
  if (sessionUpdate === "agent_message_chunk") {
    const content = asRecord(update.content);
    return decodeStreamText(
      { type: "text", data: content?.text, sessionId },
      state,
      sourceId,
    );
  }
  return [];
}

function decodeGrokSummary(
  raw: unknown,
  ctx: { sourceId: string; rootNativeId: string; sessionId: string },
): NativeConversationEvent[] {
  const record = asRecord(raw);
  if (!record) return [];
  const info = asRecord(record.info);
  const sessionId = asString(info?.id) ?? ctx.sessionId;
  if (!GROK_SESSION_ID.test(sessionId)) return [];
  const agentId = asString(record.agent_id);
  const model = asString(record.current_model_id);
  const events: NativeConversationEvent[] = [
    event(ctx.sourceId, "0", {
      rootNativeId: ctx.rootNativeId,
      sessionNativeId: sessionId,
      agentNativeId: agentId,
      kind: "state",
      occurredAt: asString(record.updated_at) ?? asString(record.created_at),
      payload: {
        title: asString(record.generated_title),
        agent_name: asString(record.agent_name),
        status: "running",
      },
    }),
  ];
  if (model) {
    events.push(
      event(ctx.sourceId, "1", {
        rootNativeId: ctx.rootNativeId,
        sessionNativeId: sessionId,
        agentNativeId: agentId,
        kind: "model",
        payload: { actual_model: model, model_source: "native_session" },
      }),
    );
  }
  return events;
}

function decodeGrokSubagentMeta(
  raw: unknown,
  ctx: { sourceId: string; rootNativeId: string; parentNativeId: string },
): NativeConversationEvent[] {
  const record = asRecord(raw);
  if (!record) return [];
  const subagentId = asString(record.subagent_id);
  const sessionId = asString(record.session_id);
  const subagentType = asString(record.subagent_type);
  if (!subagentId || !sessionId || !GROK_SESSION_ID.test(sessionId)) return [];
  const writeRestriction = classifyGrokWriteRestriction({
    subagentType,
    tools: stringList(record.tools),
  });
  return [
    event(ctx.sourceId, "0", {
      rootNativeId: ctx.rootNativeId,
      sessionNativeId: sessionId,
      agentNativeId: asString(record.agent_id) ?? subagentId,
      parentNativeId: ctx.parentNativeId,
      kind: "discovered",
      payload: {
        tool: GROK_SPAWN_TOOL,
        subagent_id: subagentId,
        subagent_type: subagentType,
        description: asString(record.description),
        write_restriction: writeRestriction,
      },
    }),
  ];
}

function decodeStreamToolCall(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const toolName = grokToolName(record);
  const toolCallId = grokToolCallId(record);
  if (!toolName || !toolCallId) return [];
  if (toolName !== GROK_SPAWN_TOOL) {
    return [
      event(sourceId, nextSeq(state), {
        rootNativeId: state.rootNativeId,
        sessionNativeId: grokSessionId(record) ?? state.rootNativeId,
        kind: "activity",
        payload: {
          tool_name: toolName,
          tool_call_id: toolCallId,
          title: asString(record.title),
          status: asString(record.status) ?? "in_progress",
        },
      }),
    ];
  }
  const rawInput = asRecord(record.rawInput) ?? asRecord(record.input) ?? {};
  const facts: GrokSpawnFacts = {
    tool_call_id: toolCallId,
    subagent_type: asString(rawInput.subagent_type),
    description: asString(rawInput.description),
    write_restriction: classifyGrokWriteRestriction({
      subagentType: asString(rawInput.subagent_type),
      tools: stringList(rawInput.tools),
    }),
  };
  state.spawns.set(toolCallId, facts);
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      parentNativeId: state.rootNativeId,
      kind: "discovered",
      payload: publicSpawnPayload(facts),
    }),
  ];
}

function decodeStreamToolUpdate(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const toolCallId = grokToolCallId(record);
  if (!toolCallId) return [];
  const spawn = state.spawns.get(toolCallId);
  if (!spawn) return [];
  const output = asRecord(record.rawOutput) ?? asRecord(record.output) ?? {};
  spawn.subagent_id = asString(output.subagent_id) ?? spawn.subagent_id;
  spawn.session_id = asString(output.session_id) ?? spawn.session_id;
  spawn.agent_id = asString(output.agent_id) ?? spawn.agent_id;
  const status = asString(record.status) ?? "completed";
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: spawn.session_id,
      agentNativeId: spawn.agent_id ?? spawn.subagent_id,
      parentNativeId: state.rootNativeId,
      kind: "state",
      payload: {
        ...publicSpawnPayload(spawn),
        status: status === "completed" ? "running" : status,
      },
    }),
  ];
}

function decodeStreamEnd(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const sessionId = grokSessionId(record) ?? asString(record.sessionId);
  if (sessionId && GROK_SESSION_ID.test(sessionId)) {
    state.rootNativeId = sessionId;
  }
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: sessionId ?? state.rootNativeId,
      kind: "state",
      occurredAt: asString(record.ts),
      payload: {
        status: "completed",
        stop_reason: asString(record.stopReason),
      },
    }),
  ];
}

function decodeStreamUsage(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const usage = asRecord(record.usage);
  if (!usage) return [];
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: grokSessionId(record) ?? state.rootNativeId,
      kind: "quota",
      payload: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
    }),
  ];
}

function decodeStreamText(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const text = asString(record.data);
  if (!text) return [];
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: grokSessionId(record) ?? state.rootNativeId,
      kind: "activity",
      payload: { text: text.slice(0, 500) },
    }),
  ];
}

function decodeStreamError(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: grokSessionId(record) ?? state.rootNativeId,
      kind: "state",
      payload: {
        status: "failed",
        message: asString(record.message),
      },
    }),
  ];
}

function decodeTurnStarted(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const sessionId = asString(record.session_id);
  if (sessionId && GROK_SESSION_ID.test(sessionId)) {
    state.rootNativeId = sessionId;
  }
  const relationship = asString(record.session_relationship);
  if (relationship && relationship !== "primary") return [];
  const events: NativeConversationEvent[] = [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: sessionId ?? state.rootNativeId,
      kind: "state",
      occurredAt: asString(record.ts),
      payload: { status: "running", schema_version: asString(record.schema_version) },
    }),
  ];
  const model = asString(record.model_id);
  if (model) {
    events.push(
      event(sourceId, nextSeq(state), {
        rootNativeId: state.rootNativeId,
        sessionNativeId: sessionId ?? state.rootNativeId,
        kind: "model",
        occurredAt: asString(record.ts),
        payload: { actual_model: model, model_source: "native_event" },
      }),
    );
  }
  return events;
}

function decodeTurnEnded(
  record: Record<string, unknown>,
  state: GrokStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const outcome = asString(record.outcome) ?? "completed";
  return [
    event(sourceId, nextSeq(state), {
      rootNativeId: state.rootNativeId,
      sessionNativeId: asString(record.session_id) ?? state.rootNativeId,
      kind: "state",
      occurredAt: asString(record.ts),
      payload: { status: outcome === "completed" ? "completed" : outcome },
    }),
  ];
}

function publicSpawnPayload(facts: GrokSpawnFacts): Record<string, unknown> {
  return {
    tool: GROK_SPAWN_TOOL,
    tool_call_id: facts.tool_call_id,
    subagent_type: facts.subagent_type,
    description: facts.description,
    write_restriction: facts.write_restriction,
    subagent_id: facts.subagent_id,
    session_id: facts.session_id,
  };
}

function grokToolName(record: Record<string, unknown>): string | undefined {
  return asString(record.toolName) ?? asString(record.tool) ?? asString(record.name);
}

function grokToolCallId(record: Record<string, unknown>): string | undefined {
  return (
    asString(record.toolCallId) ??
    asString(record.tool_call_id) ??
    asString(record.id)
  );
}

function grokSessionId(record: Record<string, unknown>): string | undefined {
  const value = asString(record.sessionId) ?? asString(record.session_id);
  if (!value || !GROK_SESSION_ID.test(value)) return;
  return value;
}

function nextSeq(state: GrokStreamState): string {
  const value = String(state.nextSeq);
  state.nextSeq += 1;
  return value;
}

function event(
  sourceId: string,
  sourceSeq: string,
  parts: {
    rootNativeId: string;
    sessionNativeId?: string;
    agentNativeId?: string;
    parentNativeId?: string;
    kind: NativeConversationEvent["kind"];
    occurredAt?: string;
    payload: unknown;
  },
): NativeConversationEvent {
  return {
    source_id: sourceId,
    source_seq: sourceSeq,
    root_native_id: parts.rootNativeId,
    session_native_id: parts.sessionNativeId,
    agent_native_id: parts.agentNativeId,
    parent_native_id: parts.parentNativeId,
    kind: parts.kind,
    occurred_at: parts.occurredAt,
    payload: parts.payload,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length ? items : undefined;
}
