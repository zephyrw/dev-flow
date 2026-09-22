import type {
  ConversationSourceCursor,
  NativeConversationEvent,
} from "../../sdk/src/interface.js";
import {
  parseJsonLine,
  readJsonlSlice,
  type ConversationRecordSource,
} from "../../sdk/src/conversation-source.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { isAbsolute } from "node:path";
import {
  CLAUDE_READONLY_AGENT,
  proveReadonlyDelegation,
  type ClaudeAgentDefinition,
} from "./scoped-hooks.js";

export const CLAUDE_ADAPTER_ID = "claude-code";
export const CLAUDE_PROTOCOL = "claude-code";
const SPAWN_TOOLS = new Set(["Task", "Agent"]);
const STREAM_TYPES = new Set(["system", "assistant", "user", "result"]);
const HOOK_EVENTS = new Set(["SubagentStart", "SubagentStop"]);
const TRANSCRIPT_TYPES = new Set([
  "system",
  "assistant",
  "user",
  "result",
  "progress",
]);

export interface ClaudeEventPayload {
  protocol: typeof CLAUDE_PROTOCOL;
  event:
    | "session_init"
    | "task_call"
    | "subagent_start"
    | "subagent_stop"
    | "activity"
    | "model"
    | "result";
  spawn_call_id?: string;
  agent_id?: string;
  agent_type?: string;
  title?: string;
  task_summary?: string;
  public_text?: string;
  status?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  model?: string;
  source_kind: "stream" | "hook" | "transcript";
  source_event_id?: string;
  continuation?: "resume-native" | "recreate-after-confirmed-exit";
  background?: boolean;
}

export interface ClaudeDecodeContext {
  sourceId: string;
  sourceSeq: string;
  sourceKind: ClaudeEventPayload["source_kind"];
  rootNativeId?: string;
  agentNativeId?: string;
  occurredAt?: string;
}

export function claudeSourceId(
  kind: ClaudeEventPayload["source_kind"],
  id: string,
): string {
  return `${CLAUDE_ADAPTER_ID}:${kind}:${id}`;
}

export function parseClaudeVersion(cliVersion?: string): {
  major: number;
  minor: number;
  patch: number;
} | undefined {
  if (!cliVersion) return undefined;
  const match = cliVersion.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function claudeResumeContinuation(
  kind: "parent" | "task-child" | "background-child",
  cliVersion?: string,
): {
  resume: SubagentCapabilities["resume"];
  continuation: "resume-native" | "recreate-after-confirmed-exit";
} {
  if (kind === "task-child") {
    return {
      resume: "unavailable",
      continuation: "recreate-after-confirmed-exit",
    };
  }
  const version = parseClaudeVersion(cliVersion);
  if (kind === "background-child") {
    if (version && (version.major > 2 || (version.major === 2 && version.minor >= 1))) {
      return { resume: "native", continuation: "resume-native" };
    }
    return {
      resume: "unavailable",
      continuation: "recreate-after-confirmed-exit",
    };
  }
  if (!version || version.major >= 2) {
    return { resume: "native", continuation: "resume-native" };
  }
  return {
    resume: "unavailable",
    continuation: "recreate-after-confirmed-exit",
  };
}

export function claudeSubagentCapabilities(input: {
  cliVersion?: string;
  agents?: Record<string, ClaudeAgentDefinition>;
  agentSpawnAllowed?: boolean;
}): SubagentCapabilities {
  const readonly = proveReadonlyDelegation(
    input.agents?.[CLAUDE_READONLY_AGENT],
  );
  const parent = claudeResumeContinuation("parent", input.cliVersion);
  const reasons: string[] = [];
  if (readonly.reason) reasons.push(readonly.reason);
  if (input.agentSpawnAllowed === false) {
    reasons.push("父调用仍禁止 Agent/Task，只读子定义未放宽 Bash/Edit/Write");
  }
  return {
    discovery: "native",
    activity: "native",
    stop: "owned-process-tree",
    resume: parent.resume,
    readonly_delegation: readonly.status === "unknown" ? "unknown" : readonly.status,
    file_input: { text: true, image: true, binary: false },
    cli_version: input.cliVersion,
    reason: reasons.join("；") || undefined,
  };
}

export function decodeClaudeStreamLine(
  line: string,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return decodeClaudeRecord(raw as Record<string, unknown>, context);
}

export function decodeClaudeHookLine(
  line: string,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  if (!isClaudeHookEvent(raw)) return [];
  return decodeHookEvent(raw, context);
}

export function decodeClaudeTranscriptLine(
  line: string,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !TRANSCRIPT_TYPES.has(type)) return [];
  return decodeClaudeRecord(record, {
    ...context,
    sourceKind: "transcript",
    agentNativeId: context.agentNativeId,
  });
}

export function isClaudeHookEvent(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.hook_event_name === "string" &&
    HOOK_EVENTS.has(event.hook_event_name)
  );
}

export function bindClaudeAgentEvents(
  events: NativeConversationEvent[],
): NativeConversationEvent[] {
  const spawnToAgent = new Map<string, string>();
  for (const event of events) {
    const payload = asPayload(event.payload);
    if (payload?.spawn_call_id && event.agent_native_id) {
      spawnToAgent.set(payload.spawn_call_id, event.agent_native_id);
    }
  }
  const seen = new Set<string>();
  const bound: NativeConversationEvent[] = [];
  for (const event of events) {
    const next = applyAgentBinding(event, spawnToAgent);
    const key = claudeDedupKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    bound.push(next);
  }
  return bound;
}

export function claudeDedupKey(event: NativeConversationEvent): string {
  const payload = asPayload(event.payload);
  const identity = event.agent_native_id
    ? `agent:${event.agent_native_id}`
    : payload?.spawn_call_id
      ? `spawn:${payload.spawn_call_id}`
      : `${event.source_id}:${event.source_seq}`;
  if (event.kind === "discovered") return `discovered:${identity}`;
  if (event.kind === "state") {
    return `state:${identity}:${payload?.event ?? ""}:${payload?.status ?? ""}`;
  }
  if (event.kind === "model") return `model:${identity}:${payload?.model ?? ""}`;
  if (event.kind === "activity") {
    const activityId = payload?.source_event_id ?? `${event.source_id}:${event.source_seq}`;
    return `activity:${identity}:${activityId}`;
  }
  return `${event.source_id}:${event.source_seq}`;
}

export class ClaudeConversationBinder {
  private spawnToAgent = new Map<string, string>();
  private seen = new Set<string>();
  push(events: NativeConversationEvent[]): NativeConversationEvent[] {
    for (const event of events) {
      const payload = asPayload(event.payload);
      if (payload?.spawn_call_id && event.agent_native_id) {
        this.spawnToAgent.set(payload.spawn_call_id, event.agent_native_id);
      }
    }
    const out: NativeConversationEvent[] = [];
    for (const event of events) {
      const next = applyAgentBinding(event, this.spawnToAgent);
      const key = claudeDedupKey(next);
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      out.push(next);
    }
    return out;
  }
}

export class ClaudeConversationSource implements ConversationRecordSource {
  readonly adapterId = CLAUDE_ADAPTER_ID;
  private transcripts = new Map<string, string>();
  constructor(
    private input: {
      eventsPath?: string;
      transcriptPaths?: Map<string, string>;
      rootNativeId?: string;
      cliVersion?: string;
      agents?: Record<string, ClaudeAgentDefinition>;
      agentSpawnAllowed?: boolean;
    } = {},
  ) {
    if (input.transcriptPaths) this.transcripts = new Map(input.transcriptPaths);
  }

  capabilities(): SubagentCapabilities {
    return claudeSubagentCapabilities(this.input);
  }

  registerTranscript(agentId: string, filePath: string) {
    if (!agentId || !isExactTranscriptPath(filePath)) return;
    this.transcripts.set(agentId, filePath);
  }

  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (cursor.source_id.includes(":hook:")) {
      return this.readHookFile(cursor);
    }
    if (cursor.source_id.includes(":transcript:")) {
      return this.readTranscriptFile(cursor);
    }
    return [];
  }

  private async readHookFile(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (!this.input.eventsPath) return [];
    const slice = await readJsonlSlice({
      filePath: this.input.eventsPath,
      offsetBytes: Number(cursor.source_seq ?? "0") || 0,
      fileIdentity: cursor.file_identity,
    }).catch(() => undefined);
    if (!slice) return [];
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) {
      const decoded = decodeClaudeHookLine(line, {
        sourceId: cursor.source_id,
        sourceSeq: slice.nextSeq,
        sourceKind: "hook",
        rootNativeId: this.input.rootNativeId,
      });
      for (const event of decoded) {
        rememberTranscript(this, event);
        events.push(event);
      }
    }
    return bindClaudeAgentEvents(events);
  }

  private async readTranscriptFile(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const agentId = cursor.source_id.split(":transcript:")[1];
    if (!agentId) return [];
    const filePath = this.transcripts.get(agentId);
    if (!filePath) return [];
    const slice = await readJsonlSlice({
      filePath,
      offsetBytes: Number(cursor.source_seq ?? "0") || 0,
      fileIdentity: cursor.file_identity,
    }).catch(() => undefined);
    if (!slice) return [];
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) {
      events.push(
        ...decodeClaudeTranscriptLine(line, {
          sourceId: cursor.source_id,
          sourceSeq: slice.nextSeq,
          sourceKind: "transcript",
          rootNativeId: this.input.rootNativeId,
          agentNativeId: agentId,
        }),
      );
    }
    return bindClaudeAgentEvents(events);
  }
}

function decodeClaudeRecord(
  record: Record<string, unknown>,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const type = record.type;
  if (typeof type !== "string" || !STREAM_TYPES.has(type)) return [];
  if (type === "system") return decodeSystemRecord(record, context);
  if (type === "assistant") return decodeAssistantRecord(record, context);
  if (type === "user") return decodeUserRecord(record, context);
  if (type === "result") return decodeResultRecord(record, context);
  return [];
}

function decodeSystemRecord(
  record: Record<string, unknown>,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const subtype = typeof record.subtype === "string" ? record.subtype : "";
  if (subtype === "init") {
    const sessionId = stringField(record, "session_id", "sessionId");
    const model = stringField(record, "model");
    if (!sessionId) return [];
    const events: NativeConversationEvent[] = [
      conversationEvent(context, {
        kind: "discovered",
        root: sessionId,
        session: sessionId,
        payload: {
          protocol: CLAUDE_PROTOCOL,
          event: "session_init",
          source_kind: context.sourceKind,
          status: "running",
          model,
          source_event_id: stringField(record, "uuid"),
        },
      }),
    ];
    if (model) {
      events.push(
        conversationEvent(context, {
          kind: "model",
          root: sessionId,
          session: sessionId,
          payload: {
            protocol: CLAUDE_PROTOCOL,
            event: "model",
            source_kind: context.sourceKind,
            model,
          },
        }),
      );
    }
    return events;
  }
  if (isHookSubtype(subtype) || isClaudeHookEvent(record)) {
    return decodeHookEvent(record, context);
  }
  return [];
}

function decodeHookEvent(
  record: Record<string, unknown>,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const hookName =
    stringField(record, "hook_event_name") ??
    stringField(nestedObject(record, "hook"), "hook_event_name");
  if (!hookName || !HOOK_EVENTS.has(hookName)) return [];
  const agentId =
    stringField(record, "agent_id", "agentId") ??
    stringField(nestedObject(record, "hook"), "agent_id", "agentId");
  if (!agentId) return [];
  const root =
    stringField(record, "session_id", "sessionId") ?? context.rootNativeId;
  if (!root) return [];
  const spawn =
    stringField(record, "tool_use_id", "parent_tool_use_id", "toolUseId") ??
    stringField(
      nestedObject(record, "hook"),
      "tool_use_id",
      "parent_tool_use_id",
      "toolUseId",
    );
  const agentType =
    stringField(record, "agent_type", "agentType") ??
    stringField(nestedObject(record, "hook"), "agent_type", "agentType");
  const transcript =
    stringField(record, "agent_transcript_path", "agentTranscriptPath") ??
    stringField(
      nestedObject(record, "hook"),
      "agent_transcript_path",
      "agentTranscriptPath",
    );
  const start = hookName === "SubagentStart";
  const background = record.background === true;
  const continuation = claudeResumeContinuation(
    background ? "background-child" : "task-child",
  ).continuation;
  return [
    conversationEvent(context, {
      kind: start ? "discovered" : "state",
      root,
      session: root,
      agent: agentId,
      parent: root,
      payload: {
        protocol: CLAUDE_PROTOCOL,
        event: start ? "subagent_start" : "subagent_stop",
        source_kind: context.sourceKind === "transcript" ? "transcript" : "hook",
        spawn_call_id: spawn,
        agent_id: agentId,
        agent_type: agentType,
        status: start ? "starting" : hookStopStatus(record),
        agent_transcript_path: transcript,
        transcript_path: stringField(record, "transcript_path"),
        source_event_id: stringField(record, "uuid") ?? `${hookName}:${agentId}`,
        continuation,
        background,
      },
    }),
  ];
}

function decodeAssistantRecord(
  record: Record<string, unknown>,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const message = nestedObject(record, "message");
  const content = message?.content ?? record.content;
  const sessionId =
    stringField(record, "session_id", "sessionId") ?? context.rootNativeId;
  if (!sessionId || !Array.isArray(content)) return [];
  const parentTool = stringField(record, "parent_tool_use_id", "parentToolUseId");
  const model = stringField(message ?? {}, "model") ?? stringField(record, "model");
  const uuid = stringField(record, "uuid");
  const events: NativeConversationEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "tool_use") {
      const spawn = spawnFromToolUse(item);
      if (spawn) {
        events.push(
          conversationEvent(context, {
            kind: "discovered",
            root: sessionId,
            session: sessionId,
            parent: context.agentNativeId ?? sessionId,
            payload: {
              protocol: CLAUDE_PROTOCOL,
              event: "task_call",
              source_kind: context.sourceKind,
              spawn_call_id: spawn.id,
              agent_type: spawn.agentType,
              title: spawn.title,
              task_summary: clip(spawn.summary, 500),
              model: spawn.model ?? model,
              status: "discovered",
              source_event_id: uuid ?? spawn.id,
              continuation: claudeResumeContinuation("task-child").continuation,
            },
          }),
        );
      }
      continue;
    }
    if (item.type === "text" && typeof item.text === "string") {
      if (parentTool || context.agentNativeId) {
        events.push(
          conversationEvent(context, {
            kind: "activity",
            root: sessionId,
            session: sessionId,
            agent: context.agentNativeId,
            parent: sessionId,
            payload: {
              protocol: CLAUDE_PROTOCOL,
              event: "activity",
              source_kind: context.sourceKind,
              spawn_call_id: parentTool,
              agent_id: context.agentNativeId,
              public_text: clip(item.text, 16000),
              status: "running",
              source_event_id: uuid,
            },
          }),
        );
      }
    }
  }
  return events;
}

function decodeUserRecord(
  record: Record<string, unknown>,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const message = nestedObject(record, "message");
  const content = message?.content ?? record.content;
  const sessionId =
    stringField(record, "session_id", "sessionId") ?? context.rootNativeId;
  if (!sessionId || !Array.isArray(content)) return [];
  const events: NativeConversationEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type !== "tool_result") continue;
    const spawn = stringField(item, "tool_use_id", "toolUseId");
    if (!spawn) continue;
    const agentId = agentIdFromToolResult(item.content ?? item);
    if (!agentId) continue;
    events.push(
      conversationEvent(context, {
        kind: "state",
        root: sessionId,
        session: sessionId,
        agent: agentId,
        parent: sessionId,
        payload: {
          protocol: CLAUDE_PROTOCOL,
          event: "result",
          source_kind: context.sourceKind,
          spawn_call_id: spawn,
          agent_id: agentId,
          status: toolResultStatus(item),
          public_text: clip(publicResultText(item.content), 16000),
          source_event_id: stringField(record, "uuid") ?? spawn,
          continuation: claudeResumeContinuation("task-child").continuation,
        },
      }),
    );
  }
  return events;
}

function decodeResultRecord(
  record: Record<string, unknown>,
  context: ClaudeDecodeContext,
): NativeConversationEvent[] {
  const sessionId =
    stringField(record, "session_id", "sessionId") ?? context.rootNativeId;
  if (!sessionId) return [];
  if (context.agentNativeId) return [];
  const failed = record.is_error === true || record.subtype === "error";
  return [
    conversationEvent(context, {
      kind: "state",
      root: sessionId,
      session: sessionId,
      payload: {
        protocol: CLAUDE_PROTOCOL,
        event: "result",
        source_kind: context.sourceKind,
        status: failed ? "failed" : "completed",
        public_text: clip(
          typeof record.result === "string" ? record.result : undefined,
          16000,
        ),
        source_event_id: stringField(record, "uuid"),
      },
    }),
  ];
}

function spawnFromToolUse(item: Record<string, unknown>): {
  id: string;
  agentType?: string;
  title?: string;
  summary?: string;
  model?: string;
} | undefined {
  const name = stringField(item, "name");
  const id = stringField(item, "id");
  if (!name || !id || !SPAWN_TOOLS.has(name)) return undefined;
  const input = nestedObject(item, "input") ?? {};
  return {
    id,
    agentType: stringField(input, "subagent_type", "subagentType", "agent_type"),
    title: stringField(input, "description", "name"),
    summary: stringField(input, "prompt", "instruction"),
    model: stringField(input, "model"),
  };
}

function agentIdFromToolResult(content: unknown): string | undefined {
  if (!content) return undefined;
  if (typeof content === "object" && !Array.isArray(content)) {
    return stringField(content as Record<string, unknown>, "agent_id", "agentId");
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      const found = agentIdFromToolResult(part);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof content !== "string") return undefined;
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return agentIdFromToolResult(JSON.parse(trimmed));
    } catch {
      return undefined;
    }
  }
  const match = trimmed.match(/(?:^|\n)agent_id:\s*(\S+)(?:\n|$)/);
  return match?.[1];
}

function publicResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

function toolResultStatus(item: Record<string, unknown>): string {
  if (item.is_error === true) return "failed";
  const content = nestedObject(item, "content");
  const status = content ? stringField(content, "status") : undefined;
  if (status === "failed" || status === "interrupted" || status === "cancelled") {
    return status;
  }
  return "completed";
}

function hookStopStatus(record: Record<string, unknown>): string {
  const reason = stringField(record, "stop_reason", "reason", "status");
  if (reason === "error" || reason === "failed") return "failed";
  if (reason === "interrupted") return "interrupted";
  if (reason === "cancelled") return "cancelled";
  return "completed";
}

function isHookSubtype(subtype: string): boolean {
  return (
    subtype === "hook" ||
    subtype === "hook_started" ||
    subtype === "hook_response" ||
    subtype === "hook_finished"
  );
}

function conversationEvent(
  context: ClaudeDecodeContext,
  input: {
    kind: NativeConversationEvent["kind"];
    root: string;
    session?: string;
    agent?: string;
    parent?: string;
    payload: ClaudeEventPayload;
  },
): NativeConversationEvent {
  return {
    source_id: context.sourceId,
    source_seq: context.sourceSeq,
    root_native_id: input.root,
    session_native_id: input.session,
    agent_native_id: input.agent ?? context.agentNativeId,
    parent_native_id: input.parent,
    kind: input.kind,
    occurred_at: context.occurredAt,
    payload: input.payload,
  };
}

function applyAgentBinding(
  event: NativeConversationEvent,
  spawnToAgent: Map<string, string>,
): NativeConversationEvent {
  const payload = asPayload(event.payload);
  if (!payload?.spawn_call_id || event.agent_native_id) return event;
  const agent = spawnToAgent.get(payload.spawn_call_id);
  if (!agent) return event;
  return {
    ...event,
    agent_native_id: agent,
    payload: { ...payload, agent_id: agent },
  };
}

function asPayload(value: unknown): ClaudeEventPayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as ClaudeEventPayload;
  if (payload.protocol !== CLAUDE_PROTOCOL) return undefined;
  return payload;
}

function stringField(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function nestedObject(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function isExactTranscriptPath(filePath: string): boolean {
  return isAbsolute(filePath) && !filePath.split(/[\\/]/).includes("..");
}

function rememberTranscript(
  source: ClaudeConversationSource,
  event: NativeConversationEvent,
) {
  const payload = asPayload(event.payload);
  if (!event.agent_native_id || !payload?.agent_transcript_path) return;
  source.registerTranscript(event.agent_native_id, payload.agent_transcript_path);
}
