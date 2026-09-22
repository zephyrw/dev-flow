import { dirname } from "node:path";
import { z } from "zod";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { SubagentCapabilitiesSchema } from "../../../contracts/src/conversation.js";
import type { ResolvedInputAttachment } from "../../../contracts/src/conversation-input.js";
import type {
  ConversationSourceCursor,
  HostChunk,
  NativeConversationEvent,
  PreparedInputAttachments,
} from "../../sdk/src/interface.js";
import {
  parseJsonLine,
  readJsonlSlice,
  type ConversationRecordSource,
} from "../../sdk/src/conversation-source.js";

export const CURSOR_ADAPTER_ID = "cursor-agent";
export const CURSOR_NO_CHILD_REASON = "当前版本无法读取子会话";
export const CURSOR_IMAGE_FLAG = "--image";
export const CURSOR_READONLY_MODES = ["ask", "plan"] as const;

const DiscoveredPayloadSchema = z
  .object({
    spawn_call_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    task_summary: z.string().max(500).optional(),
    resume_session_id: z.string().min(1).optional(),
  })
  .strict();

const StatePayloadSchema = z
  .object({
    status: z.string().min(1),
    resume_session_id: z.string().min(1).optional(),
  })
  .strict();

const ActivityPayloadSchema = z
  .object({
    public_text: z.string().max(16000).optional(),
    tool: z.string().max(200).optional(),
    spawn_call_id: z.string().min(1).optional(),
  })
  .strict();

const ModelPayloadSchema = z
  .object({
    actual_model: z.string().min(1).optional(),
  })
  .strict();

const QuotaPayloadSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  })
  .strict();

export interface CursorBoundSourceInput {
  filePath: string;
  rootNativeId: string;
  cliVersion?: string;
}

export interface CursorChildIdentity {
  agent?: string;
  session?: string;
  parent?: string;
  spawnCallId?: string;
}

export function cursorSubagentCapabilities(
  extra: Partial<SubagentCapabilities> = {},
): SubagentCapabilities {
  const discovery = extra.discovery ?? "unavailable";
  return SubagentCapabilitiesSchema.parse({
    discovery,
    activity: extra.activity ?? "native",
    stop: extra.stop ?? "owned-process-tree",
    resume: extra.resume ?? "native",
    readonly_delegation: extra.readonly_delegation ?? "unknown",
    file_input: extra.file_input ?? {
      text: false,
      image: true,
      binary: false,
    },
    cli_version: extra.cli_version,
    reason:
      extra.reason ??
      (discovery === "native" ? undefined : CURSOR_NO_CHILD_REASON),
  });
}

export function prepareCursorInputAttachments(
  attachments: ResolvedInputAttachment[],
): Promise<PreparedInputAttachments> {
  const images = attachments.filter((item) => item.read_mode === "image");
  const unsupported = attachments.filter((item) => item.read_mode !== "image");
  const extraReadRoots = uniqueDirs(images.map((item) => item.absolute_path));
  return Promise.resolve({
    attachments: images,
    extraReadRoots,
    unsupported: unsupported.length
      ? "当前 cursor-agent 仅证实 --image 图片输入，未证实文本/二进制附件参数"
      : undefined,
  });
}

function uniqueDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const filePath of paths) dirs.add(dirname(filePath));
  return [...dirs];
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function occurredAtFrom(
  record: Record<string, unknown>,
  fallback?: string,
): string | undefined {
  const ms = record.timestamp_ms;
  if (typeof ms === "number" && Number.isFinite(ms))
    return new Date(ms).toISOString();
  return fallback;
}

function firstString(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = stringField(record[key]);
    if (value) return value;
  }
  return undefined;
}

function toolCallObject(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const nested = asRecord(record.tool);
  if (nested && typeof nested.case === "string") {
    const fromValue = asRecord(nested.value);
    if (fromValue) return { ...fromValue, tool_case: nested.case };
  }
  return record;
}

function toolCallCase(toolCall: Record<string, unknown> | undefined): string | undefined {
  if (!toolCall) return undefined;
  const named = stringField(toolCall.tool_case);
  if (named) return named;
  const keys = [
    "taskToolCall",
    "task_tool_call",
    "shellToolCall",
    "shell_tool_call",
    "readToolCall",
    "read_tool_call",
    "grepToolCall",
    "grep_tool_call",
    "globToolCall",
    "glob_tool_call",
    "lsToolCall",
    "ls_tool_call",
    "editToolCall",
    "edit_tool_call",
  ];
  for (const key of keys) {
    if (asRecord(toolCall[key])) return key;
  }
  return undefined;
}

function nestedToolSection(
  toolCall: Record<string, unknown> | undefined,
  names: string[],
): Record<string, unknown> | undefined {
  if (!toolCall) return undefined;
  for (const name of names) {
    const section = asRecord(toolCall[name]);
    if (section) return section;
  }
  return undefined;
}

function taskSections(
  toolCall: Record<string, unknown> | undefined,
): {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
} {
  const task = nestedToolSection(toolCall, ["taskToolCall", "task_tool_call"]);
  if (!task) return { args: asRecord(toolCall?.args), result: asRecord(toolCall?.result) };
  return {
    args: asRecord(task.args),
    result: asRecord(task.result),
  };
}

export function cursorChildIdentity(
  record: Record<string, unknown>,
  rootId: string,
): CursorChildIdentity | undefined {
  const spawnCallId = firstString(record, ["call_id", "callId", "tool_call_id"]);
  const envelopeAgent = firstString(record, [
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  ]);
  const parent = firstString(record, [
    "parent_conversation_id",
    "parentConversationId",
    "parent_session_id",
    "parentSessionId",
    "parent_agent_id",
    "parentAgentId",
  ]);
  const envelopeSession = firstString(record, ["session_id", "sessionId"]);
  const toolCall = toolCallObject(record.tool_call ?? record.toolCall);
  const task = taskSections(toolCall);
  const nestedAgent = firstString(task.args, [
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  ]) ?? firstString(task.result, [
    "agent_id",
    "agentId",
    "subagent_id",
    "subagentId",
  ]);
  const nestedSession = firstString(task.result, ["session_id", "sessionId"]);
  const nestedParent = firstString(task.result, [
    "parent_conversation_id",
    "parentConversationId",
  ]);
  const agent = envelopeAgent ?? nestedAgent;
  const childSession = nestedSession;
  const resolvedParent = parent ?? nestedParent;
  if (agent && agent !== rootId) {
    return {
      agent,
      session: childSession && childSession !== rootId ? childSession : undefined,
      parent: resolvedParent ?? rootId,
      spawnCallId,
    };
  }
  if (childSession && childSession !== rootId && resolvedParent) {
    return {
      session: childSession,
      parent: resolvedParent,
      spawnCallId,
    };
  }
  if (
    envelopeSession &&
    envelopeSession !== rootId &&
    resolvedParent &&
    resolvedParent !== envelopeSession
  ) {
    return {
      session: envelopeSession,
      parent: resolvedParent,
      spawnCallId,
    };
  }
  return undefined;
}

function publicTextFrom(value: unknown): string | undefined {
  if (typeof value === "string") return clip(value, 16000);
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = stringField(record.text ?? record.result ?? record.public_text);
  if (direct) return clip(direct, 16000);
  const message = asRecord(record.message);
  const content = message?.content ?? record.content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    const text = stringField(block?.text);
    if (text) texts.push(text);
  }
  return texts.length ? clip(texts.join("\n"), 16000) : undefined;
}

function quotaFrom(usage: unknown): z.infer<typeof QuotaPayloadSchema> | undefined {
  const record = asRecord(usage);
  if (!record) return undefined;
  const input = record.input_tokens ?? record.inputTokens;
  const output = record.output_tokens ?? record.outputTokens;
  const payload: { input_tokens?: number; output_tokens?: number } = {};
  if (typeof input === "number" && Number.isFinite(input))
    payload.input_tokens = input;
  if (typeof output === "number" && Number.isFinite(output))
    payload.output_tokens = output;
  if (!Object.keys(payload).length) return undefined;
  return QuotaPayloadSchema.parse(payload);
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

function activityToolName(toolCall: Record<string, unknown> | undefined): string {
  const toolCase = toolCallCase(toolCall);
  if (!toolCase) return "tool";
  if (toolCase === "taskToolCall" || toolCase === "task_tool_call") return "task";
  if (toolCase === "shellToolCall" || toolCase === "shell_tool_call") return "shell";
  return toolCase.replace(/ToolCall|_tool_call/g, "").replace(/_/g, "") || "tool";
}

function toolPublicText(
  toolCall: Record<string, unknown> | undefined,
): string | undefined {
  const shell = nestedToolSection(toolCall, ["shellToolCall", "shell_tool_call"]);
  const shellArgs = asRecord(shell?.args) ?? asRecord(toolCall?.args);
  const command = firstString(shellArgs, ["command", "cmd"]);
  if (command) return clip(command, 16000);
  const task = taskSections(toolCall);
  const description = firstString(task.args, ["description", "title"]);
  if (description) return clip(description, 16000);
  return undefined;
}

export class CursorStreamMapper {
  private rootSessionId?: string;
  private seq = 0;

  constructor(private sourceId = "cursor-agent:stream") {}

  bindRoot(sessionId: string) {
    if (!this.rootSessionId) this.rootSessionId = sessionId;
  }

  decodeLine(line: string, occurredAt?: string): NativeConversationEvent[] {
    const raw = parseJsonLine(line);
    const record = asRecord(raw);
    if (!record) return [];
    const type = stringField(record.type ?? record.event);
    if (!type) return [];
    this.seq += 1;
    const sourceSeq = String(this.seq);
    const time = occurredAtFrom(record, occurredAt);
    if (type === "thinking") return [];
    if (type === "system") return this.mapSystem(record, sourceSeq, time);
    if (type === "assistant" || type === "user")
      return this.mapMessage(record, sourceSeq, time);
    if (type === "tool_call") return this.mapToolCall(record, sourceSeq, time);
    if (type === "result") return this.mapResult(record, sourceSeq, time);
    return this.mapStructuredChildOnly(record, sourceSeq, time);
  }

  private rootId(): string {
    return this.rootSessionId ?? "unbound";
  }

  private rememberRoot(session?: string) {
    if (session) this.bindRoot(session);
  }

  private mapSystem(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const subtype = stringField(record.subtype);
    if (subtype === "init") return this.mapInit(record, sourceSeq, occurredAt);
    if (subtype === "task_notification")
      return this.mapRootActivity(record, sourceSeq, occurredAt, {
        public_text: clip(
          firstString(record, ["title", "detail", "task_id"]) ?? "task",
          500,
        ),
      });
    return this.mapStructuredChildOnly(record, sourceSeq, occurredAt);
  }

  private mapInit(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    this.rememberRoot(session);
    const root = this.rootId();
    const events: NativeConversationEvent[] = [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:discovered`,
        rootNativeId: root,
        session,
        kind: "discovered",
        occurredAt,
        payload: DiscoveredPayloadSchema.parse({
          resume_session_id: session,
        }),
      }),
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:state`,
        rootNativeId: root,
        session,
        kind: "state",
        occurredAt,
        payload: StatePayloadSchema.parse({
          status: "running",
          resume_session_id: session,
        }),
      }),
    ];
    const model = stringField(record.model);
    if (model)
      events.push(
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:model`,
          rootNativeId: root,
          session,
          kind: "model",
          occurredAt,
          payload: ModelPayloadSchema.parse({ actual_model: model }),
        }),
      );
    return events;
  }

  private mapMessage(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    this.rememberRoot(session);
    const child = cursorChildIdentity(record, this.rootId());
    const events: NativeConversationEvent[] = [];
    if (child)
      events.push(
        ...this.childDiscovered(record, child, sourceSeq, occurredAt),
      );
    const text = publicTextFrom(record);
    if (!text) return events;
    events.push(
      ...this.routeIdentity(record, `${sourceSeq}:activity`, occurredAt, {
        kind: "activity",
        payload: ActivityPayloadSchema.parse({ public_text: text }),
      }),
    );
    return events;
  }

  private mapToolCall(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    this.rememberRoot(session);
    const child = cursorChildIdentity(record, this.rootId());
    const toolCall = toolCallObject(record.tool_call ?? record.toolCall);
    const spawnCallId = firstString(record, ["call_id", "callId"]);
    const events: NativeConversationEvent[] = [];
    if (child) {
      events.push(
        ...this.childDiscovered(record, child, sourceSeq, occurredAt),
      );
    }
    events.push(
      ...this.routeIdentity(record, `${sourceSeq}:activity`, occurredAt, {
        kind: "activity",
        payload: ActivityPayloadSchema.parse({
          tool: activityToolName(toolCall),
          spawn_call_id: spawnCallId,
          public_text: toolPublicText(toolCall),
        }),
      }),
    );
    return events;
  }

  private mapResult(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    this.rememberRoot(session);
    const failed =
      record.is_error === true || stringField(record.subtype) === "error";
    const events = this.routeIdentity(record, sourceSeq, occurredAt, {
      kind: "state",
      payload: StatePayloadSchema.parse({
        status: failed ? "failed" : "completed",
        resume_session_id: session,
      }),
    });
    const quota = quotaFrom(record.usage);
    if (quota)
      events.push(
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:quota`,
          rootNativeId: this.rootId(),
          session,
          kind: "quota",
          occurredAt,
          payload: quota,
        }),
      );
    return events;
  }

  private mapRootActivity(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt: string | undefined,
    payload: z.infer<typeof ActivityPayloadSchema>,
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    this.rememberRoot(session);
    return [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:activity`,
        rootNativeId: this.rootId(),
        session,
        kind: "activity",
        occurredAt,
        payload: ActivityPayloadSchema.parse(payload),
      }),
    ];
  }

  private mapStructuredChildOnly(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    this.rememberRoot(session);
    const child = cursorChildIdentity(record, this.rootId());
    if (!child) return [];
    return this.childDiscovered(record, child, sourceSeq, occurredAt);
  }

  private childDiscovered(
    record: Record<string, unknown>,
    child: CursorChildIdentity,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const toolCall = toolCallObject(record.tool_call ?? record.toolCall);
    const task = taskSections(toolCall);
    const title = firstString(task.args, ["description", "title"]);
    const summary = firstString(task.args, ["prompt", "task"]);
    return [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:discovered`,
        rootNativeId: this.rootId(),
        session: child.session,
        agent: child.agent,
        parent: child.parent,
        kind: "discovered",
        occurredAt,
        payload: DiscoveredPayloadSchema.parse({
          spawn_call_id: child.spawnCallId,
          title: clip(title, 200),
          task_summary: clip(summary, 500),
          resume_session_id: child.session,
        }),
      }),
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:state`,
        rootNativeId: this.rootId(),
        session: child.session,
        agent: child.agent,
        parent: child.parent,
        kind: "state",
        occurredAt,
        payload: StatePayloadSchema.parse({
          status: "running",
          resume_session_id: child.session,
        }),
      }),
    ];
  }

  private routeIdentity(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt: string | undefined,
    event: {
      kind: NativeConversationEvent["kind"];
      payload: unknown;
    },
  ): NativeConversationEvent[] {
    const session = firstString(record, ["session_id", "sessionId"]);
    const root = this.rootId();
    const child = cursorChildIdentity(record, root);
    return [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq,
        rootNativeId: root,
        session: child?.session ?? session,
        agent: child?.agent,
        parent: child?.parent,
        kind: event.kind,
        occurredAt,
        payload: event.payload,
      }),
    ];
  }
}

export class CursorConversationDecoder {
  private buffer = "";
  private readonly mapper: CursorStreamMapper;

  constructor(sourceId = "cursor-agent:stream") {
    this.mapper = new CursorStreamMapper(sourceId);
  }

  push(chunk: HostChunk): NativeConversationEvent[] {
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

export class CursorConversationSource implements ConversationRecordSource {
  readonly adapterId = CURSOR_ADAPTER_ID;
  readonly sourceId: string;

  constructor(private readonly bound: CursorBoundSourceInput) {
    this.sourceId = bound.filePath;
  }

  capabilities(): SubagentCapabilities {
    return cursorSubagentCapabilities({ cli_version: this.bound.cliVersion });
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
    const mapper = new CursorStreamMapper(this.sourceId);
    mapper.bindRoot(this.bound.rootNativeId);
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) events.push(...mapper.decodeLine(line));
    return events;
  }
}
