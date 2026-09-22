import { z } from "zod";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { SubagentCapabilitiesSchema } from "../../../contracts/src/conversation.js";
import type {
  ConversationSourceCursor,
  HostChunk,
  NativeConversationEvent,
  PreparedInvocation,
} from "../../sdk/src/interface.js";
import {
  parseJsonLine,
  readJsonlSlice,
  type ConversationRecordSource,
} from "../../sdk/src/conversation-source.js";
import { readOnlyPurpose } from "../../sdk/src/invocation.js";

export const QODER_READONLY_READ_TOOLS = ["Read", "Glob", "Grep"] as const;
export const QODER_READONLY_DELEGATION_TOOL = "Agent";
export const QODER_WRITE_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
] as const;
export const QODER_UNCONSTRAINED_SPAWN_TOOLS = ["Task"] as const;
export const QODER_READONLY_CHILD_AGENT = "devflow-readonly-child";

const READ_TOOL_SET = new Set<string>(QODER_READONLY_READ_TOOLS);
const WRITE_TOOL_SET = new Set<string>(QODER_WRITE_TOOLS);
const SPAWN_TOOL_SET = new Set<string>([
  QODER_READONLY_DELEGATION_TOOL,
  ...QODER_UNCONSTRAINED_SPAWN_TOOLS,
]);

export interface QoderChildAgentDefinition {
  description?: string;
  tools?: string[];
}

export interface QoderReadonlyDelegationConfig {
  allowedTools: string[];
  disallowedTools?: string[];
  childAgents?: Record<string, QoderChildAgentDefinition>;
}

export interface QoderReadonlyDelegationResult {
  readonly_delegation: SubagentCapabilities["readonly_delegation"];
  reason: string;
}

export interface QoderBoundSourceInput {
  filePath: string;
  rootNativeId: string;
}

const DiscoveredPayloadSchema = z
  .object({
    spawn_call_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    task_summary: z.string().max(500).optional(),
    resume_session_id: z.string().min(1).optional(),
    child_tools: z.array(z.string().min(1)).optional(),
    readonly_constrained: z.boolean().optional(),
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

function toolList(value: unknown): string[] {
  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function hasAll(items: string[], required: readonly string[]): boolean {
  const set = new Set(items);
  return required.every((item) => set.has(item));
}

function containsAny(items: string[], banned: ReadonlySet<string>): boolean {
  return items.some((item) => banned.has(item));
}

function toolsAreReadOnly(tools: string[]): boolean {
  if (!tools.length) return false;
  return tools.every((tool) => READ_TOOL_SET.has(tool));
}

function childAgentIsConstrained(def: QoderChildAgentDefinition): boolean {
  if (!def.tools || !toolsAreReadOnly(def.tools)) return false;
  return !containsAny(def.tools, WRITE_TOOL_SET);
}

function parseChildAgents(raw: unknown): Record<string, QoderChildAgentDefinition> | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const result: Record<string, QoderChildAgentDefinition> = {};
  for (const [name, value] of Object.entries(record)) {
    const item = asRecord(value);
    if (!item) continue;
    result[name] = {
      description: stringField(item.description),
      tools: toolList(item.tools),
    };
  }
  return result;
}

export function evaluateQoderReadonlyDelegation(
  config: QoderReadonlyDelegationConfig,
): QoderReadonlyDelegationResult {
  const allowed = config.allowedTools;
  if (!hasAll(allowed, QODER_READONLY_READ_TOOLS))
    return {
      readonly_delegation: "unsupported",
      reason: "只读白名单缺少 Read/Glob/Grep",
    };
  if (containsAny(allowed, WRITE_TOOL_SET))
    return {
      readonly_delegation: "unsupported",
      reason: "只读白名单包含写工具",
    };
  if (!allowed.includes(QODER_READONLY_DELEGATION_TOOL))
    return {
      readonly_delegation: "unsupported",
      reason: "只读白名单未允许受约束的 Agent 委派",
    };
  if (containsAny(allowed, new Set(QODER_UNCONSTRAINED_SPAWN_TOOLS)))
    return {
      readonly_delegation: "unsupported",
      reason: "不能只添加任意 Agent 工具并默认子会话只读",
    };
  const denied = new Set(config.disallowedTools ?? []);
  if (!QODER_WRITE_TOOLS.every((tool) => denied.has(tool)))
    return {
      readonly_delegation: "unsupported",
      reason: "缺少写工具拒绝，子会话不能默认只读",
    };
  const children = Object.values(config.childAgents ?? {});
  if (!children.length)
    return {
      readonly_delegation: "unsupported",
      reason: "只读委派缺少子 Agent 工具限制",
    };
  if (!children.every(childAgentIsConstrained))
    return {
      readonly_delegation: "unsupported",
      reason: "子 Agent 未限制为 Read/Glob/Grep",
    };
  return { readonly_delegation: "verified", reason: "受约束委派已配套子权限限制" };
}

export function qoderSubagentCapabilities(
  extra: Partial<SubagentCapabilities> = {},
): SubagentCapabilities {
  const evaluated = evaluateQoderReadonlyDelegation({
    allowedTools: [
      ...QODER_READONLY_READ_TOOLS,
      QODER_READONLY_DELEGATION_TOOL,
    ],
    disallowedTools: [...QODER_WRITE_TOOLS, ...QODER_UNCONSTRAINED_SPAWN_TOOLS],
    childAgents: {
      [QODER_READONLY_CHILD_AGENT]: { tools: [...QODER_READONLY_READ_TOOLS] },
    },
  });
  return SubagentCapabilitiesSchema.parse({
    discovery: "native",
    activity: "native",
    stop: "owned-process-tree",
    resume: "native",
    readonly_delegation: evaluated.readonly_delegation,
    file_input: { text: true, image: false, binary: false },
    reason: extra.reason ?? evaluated.reason,
    ...extra,
  });
}

function flagNamesMatch(flag: string, names: string[]): boolean {
  return names.includes(flag);
}

function readFlagValue(args: string[], names: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (flagNamesMatch(args[index]!, names) && index + 1 < args.length)
      return args[index + 1];
  }
  return undefined;
}

function setExclusiveFlag(
  args: string[],
  names: string[],
  preferred: string,
  value: string,
): string[] {
  const next: string[] = [];
  let replaced = false;
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index]!;
    if (flagNamesMatch(current, names) && index + 1 < args.length) {
      if (!replaced) {
        next.push(preferred, value);
        replaced = true;
      }
      index += 1;
      continue;
    }
    next.push(current);
  }
  if (!replaced) next.push(preferred, value);
  return next;
}

export function parseQoderReadonlyInvocation(
  args: string[],
): QoderReadonlyDelegationConfig {
  const allowedTools = toolList(readFlagValue(args, ["--tools"]));
  const disallowedTools = toolList(
    readFlagValue(args, ["--disallowed-tools", "--disallowedTools"]),
  );
  let childAgents: Record<string, QoderChildAgentDefinition> | undefined;
  const agentsRaw = readFlagValue(args, ["--agents"]);
  if (agentsRaw) {
    const parsed = parseJsonLine(agentsRaw);
    childAgents = parseChildAgents(parsed);
  }
  return { allowedTools, disallowedTools, childAgents };
}

export function applyQoderConstrainedDelegationArgs(args: string[]): string[] {
  const withTools = setExclusiveFlag(
    args,
    ["--tools"],
    "--tools",
    [...QODER_READONLY_READ_TOOLS, QODER_READONLY_DELEGATION_TOOL].join(","),
  );
  const withDenied = setExclusiveFlag(
    withTools,
    ["--disallowed-tools", "--disallowedTools"],
    "--disallowed-tools",
    [...QODER_WRITE_TOOLS, ...QODER_UNCONSTRAINED_SPAWN_TOOLS].join(","),
  );
  return setExclusiveFlag(
    withDenied,
    ["--agents"],
    "--agents",
    JSON.stringify({
      [QODER_READONLY_CHILD_AGENT]: {
        description: "DevFlow read-only subagent",
        tools: [...QODER_READONLY_READ_TOOLS],
      },
    }),
  );
}

export function applyQoderConstrainedDelegation(
  invocation: PreparedInvocation,
  purpose: string,
): PreparedInvocation {
  if (!readOnlyPurpose(purpose)) return invocation;
  return {
    ...invocation,
    args: applyQoderConstrainedDelegationArgs(invocation.args),
  };
}

export function qoderSpawnIsConstrained(input: unknown): boolean {
  const record = asRecord(input);
  if (!record) return false;
  const type = stringField(
    record.subagent_type ?? record.subagentType ?? record.agent ?? record.name,
  );
  const tools = toolList(record.tools);
  const typeOk = type === QODER_READONLY_CHILD_AGENT;
  const toolsOk = toolsAreReadOnly(tools);
  if (typeOk && (!tools.length || toolsOk)) return true;
  return toolsOk;
}

function nativeIds(raw: Record<string, unknown>): {
  session?: string;
  agent?: string;
} {
  return {
    session: stringField(
      raw.session_id ?? raw.sessionId ?? raw.child_session_id,
    ),
    agent: stringField(raw.agent_id ?? raw.agentId ?? raw.child_agent_id),
  };
}

function parentSessionOf(raw: Record<string, unknown>): string | undefined {
  return stringField(raw.parent_session_id ?? raw.parentSessionId);
}

function contentBlocks(message: unknown): Record<string, unknown>[] {
  const record = asRecord(message);
  const content = record?.content;
  if (typeof content === "string") {
    const parsed = parseJsonLine(content);
    const parsedRecord = asRecord(parsed);
    return parsedRecord ? [parsedRecord] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const block = asRecord(item);
    return block ? [block] : [];
  });
}

function publicTextFrom(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 16000);
  const record = asRecord(value);
  if (!record) return undefined;
  const direct = stringField(record.text ?? record.result ?? record.public_text);
  if (direct) return direct.slice(0, 16000);
  const blocks = contentBlocks(record);
  const texts = blocks
    .map((block) => stringField(block.text))
    .filter((item): item is string => Boolean(item));
  return texts.length ? texts.join("\n").slice(0, 16000) : undefined;
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") return asRecord(parseJsonLine(value));
  return asRecord(value);
}

function childIdsFromBlock(
  block: Record<string, unknown>,
  envelopeSession?: string,
): { session?: string; agent?: string } {
  const direct = nativeIds(block);
  const nested = nestedRecord(block.content);
  const fromNested = nested ? nativeIds(nested) : {};
  const session = direct.session ?? fromNested.session;
  const agent = direct.agent ?? fromNested.agent;
  return {
    session: session && session !== envelopeSession ? session : undefined,
    agent,
  };
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

export class QoderStreamMapper {
  private rootSessionId?: string;
  private seq = 0;

  constructor(private sourceId = "qoder:stream") {}

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
    if (type === "system" && stringField(record.subtype) === "init")
      return this.mapInit(record, sourceSeq, occurredAt);
    if (type === "assistant" || type === "user")
      return this.mapMessage(record, sourceSeq, occurredAt);
    if (type === "result") return this.mapResult(record, sourceSeq, occurredAt);
    if (type === "agent_start" || type === "agent_stop")
      return this.mapAgentLifecycle(record, type, sourceSeq, occurredAt);
    return [];
  }

  private rootId(): string {
    return this.rootSessionId ?? "unbound";
  }

  private mapInit(
    record: Record<string, unknown>,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const ids = nativeIds(record);
    if (ids.session) this.bindRoot(ids.session);
    const root = this.rootId();
    const events: NativeConversationEvent[] = [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:discovered`,
        rootNativeId: root,
        session: ids.session,
        agent: ids.agent,
        kind: "discovered",
        occurredAt,
        payload: DiscoveredPayloadSchema.parse({
          resume_session_id: ids.session,
        }),
      }),
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:state`,
        rootNativeId: root,
        session: ids.session,
        agent: ids.agent,
        kind: "state",
        occurredAt,
        payload: StatePayloadSchema.parse({
          status: "running",
          resume_session_id: ids.session,
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
          session: ids.session,
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
    const envelope = nativeIds(record);
    if (envelope.session && !this.rootSessionId) this.bindRoot(envelope.session);
    const root = this.rootId();
    const parent = parentSessionOf(record) ?? this.rootSessionId;
    const events: NativeConversationEvent[] = [];
    const blocks = contentBlocks(record.message ?? record);
    let blockIndex = 0;
    for (const block of blocks) {
      const blockType = stringField(block.type);
      if (blockType === "tool_use") {
        events.push(
          ...this.mapToolUse(
            block,
            envelope,
            parent,
            `${sourceSeq}:${blockIndex}`,
            occurredAt,
          ),
        );
      } else if (blockType === "tool_result") {
        events.push(
          ...this.mapToolResult(
            block,
            envelope,
            parent,
            `${sourceSeq}:${blockIndex}`,
            occurredAt,
          ),
        );
      } else {
        const text = publicTextFrom(block);
        if (text)
          events.push(
            eventBase({
              sourceId: this.sourceId,
              sourceSeq: `${sourceSeq}:${blockIndex}:activity`,
              rootNativeId: root,
              session: envelope.session,
              agent: envelope.agent,
              parent: envelope.session === root ? undefined : parent,
              kind: "activity",
              occurredAt,
              payload: ActivityPayloadSchema.parse({ public_text: text }),
            }),
          );
      }
      blockIndex += 1;
    }
    return events;
  }

  private mapToolUse(
    block: Record<string, unknown>,
    envelope: { session?: string; agent?: string },
    parent: string | undefined,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const name = stringField(block.name ?? block.tool);
    const callId = stringField(block.id ?? block.tool_use_id ?? block.call_id);
    const input = asRecord(block.input ?? block.arguments ?? block.params);
    const root = this.rootId();
    if (!name || !SPAWN_TOOL_SET.has(name)) {
      return [
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:activity`,
          rootNativeId: root,
          session: envelope.session,
          agent: envelope.agent,
          parent: envelope.session === root ? undefined : parent,
          kind: "activity",
          occurredAt,
          payload: ActivityPayloadSchema.parse({
            tool: name,
            spawn_call_id: callId,
            public_text: name,
          }),
        }),
      ];
    }
    const childTools = toolList(input?.tools);
    const constrained = qoderSpawnIsConstrained(input);
    const title = stringField(input?.description ?? input?.title);
    const summary = stringField(input?.prompt ?? input?.task);
    return [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:discovered`,
        rootNativeId: root,
        parent: envelope.session ?? parent,
        kind: "discovered",
        occurredAt,
        payload: DiscoveredPayloadSchema.parse({
          spawn_call_id: callId,
          title,
          task_summary: summary?.slice(0, 500),
          child_tools: childTools.length ? childTools : undefined,
          readonly_constrained: constrained,
        }),
      }),
    ];
  }

  private mapToolResult(
    block: Record<string, unknown>,
    envelope: { session?: string; agent?: string },
    parent: string | undefined,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const callId = stringField(
      block.tool_use_id ?? block.id ?? block.call_id ?? block.tool_call_id,
    );
    const child = childIdsFromBlock(block, envelope.session);
    const root = this.rootId();
    const events: NativeConversationEvent[] = [];
    if (child.session || child.agent) {
      events.push(
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:discovered`,
          rootNativeId: root,
          session: child.session,
          agent: child.agent,
          parent: envelope.session ?? parent,
          kind: "discovered",
          occurredAt,
          payload: DiscoveredPayloadSchema.parse({
            spawn_call_id: callId,
            resume_session_id: child.session,
          }),
        }),
      );
      events.push(
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:state`,
          rootNativeId: root,
          session: child.session,
          agent: child.agent,
          parent: envelope.session ?? parent,
          kind: "state",
          occurredAt,
          payload: StatePayloadSchema.parse({
            status: "running",
            resume_session_id: child.session,
          }),
        }),
      );
    }
    const text = publicTextFrom(block);
    if (text)
      events.push(
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:activity`,
          rootNativeId: root,
          session: child.session ?? envelope.session,
          agent: child.agent ?? envelope.agent,
          parent: child.session ? envelope.session ?? parent : undefined,
          kind: "activity",
          occurredAt,
          payload: ActivityPayloadSchema.parse({
            public_text: text,
            spawn_call_id: callId,
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
    const ids = nativeIds(record);
    if (ids.session && !this.rootSessionId) this.bindRoot(ids.session);
    const failed =
      record.is_error === true || stringField(record.subtype) === "error";
    return [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:state`,
        rootNativeId: this.rootId(),
        session: ids.session,
        agent: ids.agent,
        kind: "state",
        occurredAt,
        payload: StatePayloadSchema.parse({
          status: failed ? "failed" : "completed",
          resume_session_id: ids.session,
        }),
      }),
    ];
  }

  private mapAgentLifecycle(
    record: Record<string, unknown>,
    type: string,
    sourceSeq: string,
    occurredAt?: string,
  ): NativeConversationEvent[] {
    const ids = nativeIds(record);
    const parent = parentSessionOf(record) ?? this.rootSessionId;
    if (ids.session && !this.rootSessionId && !parent) this.bindRoot(ids.session);
    const root = this.rootId();
    const status = type === "agent_start" ? "running" : "completed";
    const events: NativeConversationEvent[] = [
      eventBase({
        sourceId: this.sourceId,
        sourceSeq: `${sourceSeq}:state`,
        rootNativeId: root,
        session: ids.session,
        agent: ids.agent,
        parent: ids.session === root ? undefined : parent,
        kind: "state",
        occurredAt,
        payload: StatePayloadSchema.parse({
          status,
          resume_session_id: ids.session,
        }),
      }),
    ];
    if (type === "agent_start")
      events.unshift(
        eventBase({
          sourceId: this.sourceId,
          sourceSeq: `${sourceSeq}:discovered`,
          rootNativeId: root,
          session: ids.session,
          agent: ids.agent,
          parent: ids.session === root ? undefined : parent,
          kind: "discovered",
          occurredAt,
          payload: DiscoveredPayloadSchema.parse({
            resume_session_id: ids.session,
          }),
        }),
      );
    return events;
  }
}

export class QoderConversationDecoder {
  private buffer = "";
  private readonly mapper: QoderStreamMapper;

  constructor(sourceId = "qoder:stream") {
    this.mapper = new QoderStreamMapper(sourceId);
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

export class QoderConversationSource implements ConversationRecordSource {
  readonly adapterId = "qoder";
  readonly sourceId: string;

  constructor(private readonly bound: QoderBoundSourceInput) {
    this.sourceId = bound.filePath;
  }

  capabilities(): SubagentCapabilities {
    return qoderSubagentCapabilities();
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
    const mapper = new QoderStreamMapper(this.sourceId);
    mapper.bindRoot(this.bound.rootNativeId);
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines)
      events.push(...mapper.decodeLine(line));
    return events;
  }
}
