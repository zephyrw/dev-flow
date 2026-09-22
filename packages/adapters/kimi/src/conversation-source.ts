import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { readFile } from "node:fs/promises";
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

export const KIMI_ADAPTER_ID = "kimi-code";
export const KIMI_MAIN_AGENT_ID = "main";
export const KIMI_SPAWN_TOOLS = ["Agent", "AgentSwarm"] as const;
export const KIMI_READONLY_PROFILES = ["explore", "plan"] as const;
export const KIMI_WRITE_PROFILES = ["coder"] as const;
export const KIMI_TEXT_TOOL = "Read";
export const KIMI_IMAGE_TOOL = "ReadMediaFile";
export const KIMI_PLAN_FLAG = "--plan";
export const KIMI_PROMPT_FLAG = "--prompt";
export const KIMI_PROMPT_PLAN_CONFLICT =
  "kimi-code 0.37.2 的 --plan 不能与 -p/--prompt 同时使用，headless 无法靠该标志进入计划模式";
export const KIMI_PLAN_INHERIT_REASON =
  "子代理 configureChild 只继承 cwd/modelAlias/thinkingEffort 与 profile 工具表，不复制 planMode；explore/plan 只读来自自身工具列表，不是 Codex sandbox_mode。默认 Agent 子类型 coder 仍有 Write/Edit";

const SPAWN_TOOL_SET = new Set<string>(KIMI_SPAWN_TOOLS);
const READONLY_PROFILE_SET = new Set<string>(KIMI_READONLY_PROFILES);
const WRITE_PROFILE_SET = new Set<string>(KIMI_WRITE_PROFILES);
const SESSION_ID_RE =
  /^(session_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_RE = /^(main|agent-\d+)$/;
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const WORKDIR_KEY_PREFIX = "wd_";
const WORKDIR_HASH_LENGTH = 12;
const WORKDIR_SLUG_MAX = 40;

const DiscoveredPayloadSchema = z
  .object({
    protocol: z.enum(["stream-json", "session-record", "event2"]),
    spawn_call_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
    task_summary: z.string().max(500).optional(),
    session_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    parent_agent_id: z.string().min(1).optional(),
    subagent_type: z.string().min(1).optional(),
    actual_subagent_type: z.string().min(1).optional(),
    plan_mode_inherited: z.literal(false).optional(),
    readonly_by_profile: z.boolean().optional(),
    resume_target: z.enum(["session", "agent"]).optional(),
  })
  .strict();

const StatePayloadSchema = z
  .object({
    protocol: z.enum(["stream-json", "session-record", "event2"]),
    status: z.string().min(1),
    reason: z.string().max(500).optional(),
    session_id: z.string().min(1).optional(),
    agent_id: z.string().min(1).optional(),
    parent_agent_id: z.string().min(1).optional(),
    plan_mode: z.boolean().optional(),
    plan_mode_inherited: z.literal(false).optional(),
    exception: z
      .object({
        name: z.string().max(200).optional(),
        message: z.string().max(500).optional(),
        status_code: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ActivityPayloadSchema = z
  .object({
    protocol: z.enum(["stream-json", "session-record", "event2"]),
    public_text: z.string().max(16000).optional(),
    tool: z.string().max(200).optional(),
    spawn_call_id: z.string().min(1).optional(),
    title: z.string().max(200).optional(),
  })
  .strict();

const ModelPayloadSchema = z
  .object({
    protocol: z.enum(["stream-json", "session-record", "event2"]),
    model_alias: z.string().min(1).optional(),
    thinking_effort: z.string().min(1).optional(),
    source: z.enum(["native_event", "native_session"]).optional(),
  })
  .strict();

export interface KimiPendingSpawn {
  toolCallId: string;
  tool: string;
  subagentType?: string;
  description?: string;
}

export interface KimiStreamState {
  sessionId?: string;
  rootNativeId: string;
  nextSeq: number;
  pending: Map<string, KimiPendingSpawn>;
}

export interface KimiBoundSourceOptions {
  sessionDir: string;
  sessionId: string;
  rootNativeId?: string;
}

export type KimiBoundKind = "session" | "wire";

export function kimiPromptAllowsPlanFlag(): boolean {
  return false;
}

export function kimiChildInheritsPlanMode(): boolean {
  return false;
}

export function kimiReadonlyByProfile(subagentType?: string): boolean | undefined {
  if (!subagentType) return undefined;
  if (READONLY_PROFILE_SET.has(subagentType)) return true;
  if (WRITE_PROFILE_SET.has(subagentType)) return false;
  return undefined;
}

export function kimiSubagentCapabilities(
  extra: Partial<SubagentCapabilities> = {},
): SubagentCapabilities {
  return SubagentCapabilitiesSchema.parse({
    discovery: extra.discovery ?? "native",
    activity: extra.activity ?? "scoped-record",
    stop: extra.stop ?? "owned-process-tree",
    resume: extra.resume ?? "parent-instruction",
    readonly_delegation: extra.readonly_delegation ?? "unsupported",
    file_input: extra.file_input ?? {
      text: true,
      image: true,
      binary: false,
    },
    cli_version: extra.cli_version,
    reason:
      extra.reason ??
      `${KIMI_PROMPT_PLAN_CONFLICT}。${KIMI_PLAN_INHERIT_REASON}。session_id 与 agent_id 独立；子恢复用 Agent(resume=agent_id)，--session 只接受 session_id。文本走 ${KIMI_TEXT_TOOL}，图片走 ${KIMI_IMAGE_TOOL}，无二进制附件参数。`,
  });
}

export function kimiDefaultHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

export function isKimiSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value) && SAFE_SESSION_ID_RE.test(value);
}

export function isKimiAgentId(value: string): boolean {
  return AGENT_ID_RE.test(value);
}

export function kimiStreamSourceId(runId: string): string {
  return `${KIMI_ADAPTER_ID}:stream:${runId}`;
}

export function kimiBoundSourceId(
  kind: KimiBoundKind,
  sessionId: string,
  agentId?: string,
): string {
  if (kind === "wire" && agentId) {
    return [KIMI_ADAPTER_ID, kind, sessionId, agentId].join(":");
  }
  return [KIMI_ADAPTER_ID, kind, sessionId].join(":");
}

export function parseKimiBoundSourceId(sourceId: string):
  | { kind: KimiBoundKind; sessionId: string; agentId?: string }
  | undefined {
  const parts = sourceId.split(":");
  if (parts[0] !== KIMI_ADAPTER_ID) return;
  const kind = parts[1];
  const sessionId = parts[2];
  if (!sessionId || !isKimiSessionId(sessionId)) return;
  if (kind === "session" && parts.length === 3) return { kind, sessionId };
  if (kind === "wire" && parts.length === 4) {
    const agentId = parts[3];
    if (!agentId || !isKimiAgentId(agentId)) return;
    return { kind, sessionId, agentId };
  }
  return;
}

export function kimiEncodeWorkDirKey(workDir: string): string {
  const normalized = kimiNormalizeWorkDir(workDir);
  return `${WORKDIR_KEY_PREFIX}${kimiSlugifyWorkDir(basename(normalized))}_${createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, WORKDIR_HASH_LENGTH)}`;
}

export function kimiSessionDirectory(
  homeDir: string,
  workDir: string,
  sessionId: string,
): string {
  if (!isKimiSessionId(sessionId)) {
    throw new Error("Kimi session id 含有不受支持的路径字符");
  }
  return join(homeDir, "sessions", kimiEncodeWorkDirKey(workDir), sessionId);
}

export function createKimiStreamState(rootNativeId = "unbound-root"): KimiStreamState {
  return {
    rootNativeId,
    nextSeq: 0,
    pending: new Map(),
  };
}

export function decodeKimiStreamJsonLine(
  line: string,
  state: KimiStreamState,
  sourceId = kimiStreamSourceId("unbound"),
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  if (!raw) return [];
  return decodeKimiObject(raw, state, sourceId);
}

export class KimiStreamDecoder {
  private buffer = "";
  private readonly state: KimiStreamState;
  private readonly sourceId: string;
  constructor(sourceId = kimiStreamSourceId("unbound"), rootNativeId?: string) {
    this.sourceId = sourceId;
    this.state = createKimiStreamState(rootNativeId ?? "unbound-root");
    if (rootNativeId && isKimiSessionId(rootNativeId)) {
      this.state.sessionId = rootNativeId;
    }
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
      events.push(...decodeKimiStreamJsonLine(line, this.state, this.sourceId));
    }
    return events;
  }
  pushChunk(chunk: HostChunk): NativeConversationEvent[] {
    if (chunk.stream !== "stdout") return [];
    const text =
      typeof chunk.data === "string" ? chunk.data : chunk.data.toString("utf8");
    return this.push(text, chunk.final);
  }
}

export function prepareKimiInputAttachments(
  attachments: ResolvedInputAttachment[],
): Promise<PreparedInputAttachments> {
  const accepted = attachments.filter(
    (item) => item.read_mode === "text" || item.read_mode === "image",
  );
  const binary = attachments.filter((item) => item.read_mode === "binary");
  return Promise.resolve({
    attachments: accepted,
    extraReadRoots: uniqueDirs(accepted.map((item) => item.absolute_path)),
    unsupported: binary.length
      ? `kimi-code 当前只证实 ${KIMI_TEXT_TOOL} 文本与 ${KIMI_IMAGE_TOOL} 图片读取，没有二进制附件参数`
      : undefined,
  });
}

export class KimiBoundConversationSource implements ConversationRecordSource {
  readonly adapterId = KIMI_ADAPTER_ID;
  readonly sourceId: string;
  private readonly options: KimiBoundSourceOptions;
  constructor(options: KimiBoundSourceOptions) {
    if (!isKimiSessionId(options.sessionId)) {
      throw new Error("Kimi session id 含有不受支持的路径字符");
    }
    this.options = options;
    this.sourceId = kimiBoundSourceId("session", options.sessionId);
  }
  capabilities(): SubagentCapabilities {
    return kimiSubagentCapabilities();
  }
  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const parsed = parseKimiBoundSourceId(cursor.source_id);
    if (!parsed || parsed.sessionId !== this.options.sessionId) return [];
    if (parsed.kind === "session") return this.readSessionState(cursor);
    if (parsed.kind === "wire" && parsed.agentId) {
      return this.readAgentWire(parsed.agentId, cursor);
    }
    return [];
  }
  private async readSessionState(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (cursor.source_seq && cursor.source_seq !== "0") return [];
    const statePath = join(this.options.sessionDir, "state.json");
    const raw = await readJsonFile(statePath);
    const record = asRecord(raw);
    if (!record) return [];
    const sessionId = stringField(record.id);
    if (sessionId !== this.options.sessionId) return [];
    return decodeKimiSessionState(record, {
      sourceId: this.sourceId,
      sessionId: this.options.sessionId,
      rootNativeId: this.options.rootNativeId ?? this.options.sessionId,
    });
  }
  private async readAgentWire(
    agentId: string,
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (!isKimiAgentId(agentId)) return [];
    const agents = await this.listedAgentIds();
    if (!agents.has(agentId)) return [];
    const filePath = join(
      this.options.sessionDir,
      "agents",
      agentId,
      "wire.jsonl",
    );
    const slice = await readJsonlSlice({
      filePath,
      offsetBytes: Number(cursor.source_seq ?? "0") || 0,
      fileIdentity: cursor.file_identity,
    });
    const state = createKimiStreamState(
      this.options.rootNativeId ?? this.options.sessionId,
    );
    state.sessionId = this.options.sessionId;
    const sourceId = kimiBoundSourceId(
      "wire",
      this.options.sessionId,
      agentId,
    );
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) {
      events.push(
        ...decodeKimiWireLine(line, state, sourceId, agentId),
      );
    }
    return events;
  }
  private async listedAgentIds(): Promise<Set<string>> {
    const raw = await readJsonFile(join(this.options.sessionDir, "state.json"));
    const record = asRecord(raw);
    const agents = asRecord(record?.agents);
    const ids = new Set<string>();
    if (!agents) return ids;
    for (const id of Object.keys(agents)) {
      if (isKimiAgentId(id)) ids.add(id);
    }
    return ids;
  }
}

export function decodeKimiSessionState(
  record: Record<string, unknown>,
  input: {
    sourceId: string;
    sessionId: string;
    rootNativeId: string;
  },
): NativeConversationEvent[] {
  const agents = asRecord(record.agents);
  if (!agents) return [];
  const events: NativeConversationEvent[] = [];
  let seq = 0;
  for (const [agentId, value] of Object.entries(agents)) {
    if (!isKimiAgentId(agentId)) continue;
    const meta = asRecord(value);
    if (!meta) continue;
    const type = stringField(meta.type);
    const parentAgentId =
      type === "sub"
        ? stringField(meta.parentAgentId) ?? KIMI_MAIN_AGENT_ID
        : undefined;
    seq += 1;
    events.push(
      eventBase({
        sourceId: input.sourceId,
        sourceSeq: String(seq),
        rootNativeId: input.rootNativeId,
        session: input.sessionId,
        agent: agentId,
        parent: parentAgentId,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          protocol: "session-record",
          session_id: input.sessionId,
          agent_id: agentId,
          parent_agent_id: parentAgentId,
          resume_target: agentId === KIMI_MAIN_AGENT_ID ? "session" : "agent",
          plan_mode_inherited: kimiChildInheritsPlanMode() ? undefined : false,
        }),
      }),
    );
  }
  return events;
}

export function decodeKimiWireLine(
  line: string,
  state: KimiStreamState,
  sourceId: string,
  ownerAgentId: string,
): NativeConversationEvent[] {
  const raw = parseJsonLine(line);
  const record = asRecord(raw);
  if (!record) return [];
  const type = stringField(record.type);
  if (type === "profile.bind") {
    return decodeProfileBind(record, state, sourceId, ownerAgentId);
  }
  if (type === "llm.request") {
    return decodeLlmRequest(record, state, sourceId, ownerAgentId);
  }
  if (type === "context.append_loop_event") {
    const event = asRecord(record.event);
    if (!event) return [];
    return decodeLoopEvent(event, state, sourceId, ownerAgentId);
  }
  return [];
}

function decodeKimiObject(
  raw: unknown,
  state: KimiStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const record = asRecord(raw);
  if (!record) return [];
  if (looksLikeCodexRecord(record)) return [];
  const nativeType = stringField(record.type);
  if (nativeType?.startsWith("subagent.") || nativeType === "event.session.created") {
    return decodeEvent2(record, state, sourceId);
  }
  if (nativeType === "agent.status.updated") {
    return decodeAgentStatus(record, state, sourceId);
  }
  const role = stringField(record.role);
  if (role === "meta") return decodeMeta(record, state, sourceId);
  if (role === "assistant") return decodeAssistant(record, state, sourceId);
  if (role === "tool") {
    return decodeToolResult(record, state, sourceId, KIMI_MAIN_AGENT_ID);
  }
  return [];
}

function decodeMeta(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const type = stringField(record.type);
  if (type === "system.version") return [];
  if (type === "session.resume_hint") {
    const sessionId = stringField(record.session_id);
    if (!sessionId || !isKimiSessionId(sessionId)) return [];
    rememberSession(state, sessionId);
    return [
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          protocol: "stream-json",
          session_id: sessionId,
          agent_id: KIMI_MAIN_AGENT_ID,
          resume_target: "session",
        }),
      }),
    ];
  }
  if (type === "turn.step.retrying") {
    return [
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "activity",
        payload: ActivityPayloadSchema.parse({
          protocol: "stream-json",
          title: "turn.step.retrying",
          public_text: clip(stringField(record.error_message), 500),
        }),
      }),
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "state",
        payload: StatePayloadSchema.parse({
          protocol: "stream-json",
          status: "running",
          session_id: state.sessionId,
          agent_id: KIMI_MAIN_AGENT_ID,
          exception: {
            name: stringField(record.error_name),
            message: clip(stringField(record.error_message), 500),
            status_code:
              typeof record.status_code === "number"
                ? record.status_code
                : undefined,
          },
        }),
      }),
    ];
  }
  return [];
}

function decodeAssistant(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const events: NativeConversationEvent[] = [];
  const content = stringField(record.content);
  if (content) {
    events.push(
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "activity",
        payload: ActivityPayloadSchema.parse({
          protocol: "stream-json",
          public_text: clip(content, 16000),
        }),
      }),
    );
  }
  const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  for (const item of toolCalls) {
    events.push(...decodeToolCall(item, state, sourceId, KIMI_MAIN_AGENT_ID));
  }
  return events;
}

function decodeToolCall(
  raw: unknown,
  state: KimiStreamState,
  sourceId: string,
  ownerAgentId: string,
): NativeConversationEvent[] {
  const record = asRecord(raw);
  if (!record) return [];
  const fn = asRecord(record.function);
  const tool = stringField(fn?.name) ?? stringField(record.name);
  const toolCallId =
    stringField(record.id) ?? stringField(record.toolCallId) ?? "";
  if (!tool || !toolCallId) return [];
  if (!SPAWN_TOOL_SET.has(tool)) {
    return [
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: ownerAgentId,
        parent:
          ownerAgentId === KIMI_MAIN_AGENT_ID ? undefined : KIMI_MAIN_AGENT_ID,
        kind: "activity",
        payload: ActivityPayloadSchema.parse({
          protocol: "stream-json",
          tool,
          spawn_call_id: toolCallId,
        }),
      }),
    ];
  }
  const args = parseToolArguments(fn?.arguments ?? record.arguments);
  const subagentType = stringField(args.subagent_type);
  const description = stringField(args.description);
  state.pending.set(toolCallId, {
    toolCallId,
    tool,
    subagentType,
    description,
  });
  return [
    eventBase({
      sourceId,
      sourceSeq: nextSeq(state),
      rootNativeId: state.rootNativeId,
      session: state.sessionId,
      agent: undefined,
      parent: ownerAgentId,
      kind: "discovered",
      payload: DiscoveredPayloadSchema.parse({
        protocol: "stream-json",
        spawn_call_id: toolCallId,
        title: clip(description, 200),
        task_summary: clip(description, 500),
        session_id: state.sessionId,
        parent_agent_id: ownerAgentId,
        subagent_type: subagentType,
        plan_mode_inherited: false,
        readonly_by_profile: kimiReadonlyByProfile(subagentType),
        resume_target: "agent",
      }),
    }),
  ];
}

function decodeToolResult(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
  ownerAgentId: string,
): NativeConversationEvent[] {
  const toolCallId = stringField(record.tool_call_id);
  if (!toolCallId) return [];
  const pending = state.pending.get(toolCallId);
  const content = stringifyContent(record.content);
  if (!pending) {
    return [
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: ownerAgentId,
        kind: "activity",
        payload: ActivityPayloadSchema.parse({
          protocol: "stream-json",
          spawn_call_id: toolCallId,
          public_text: clip(content, 500),
        }),
      }),
    ];
  }
  state.pending.delete(toolCallId);
  const parsed = parseAgentResult(content);
  const events: NativeConversationEvent[] = [];
  const agentIds =
    parsed.agentIds.length > 0 ? parsed.agentIds : parsed.agentId ? [parsed.agentId] : [];
  if (agentIds.length === 0) {
    return [
      childStateEvent(state, sourceId, {
        status: parsed.status ?? "unknown",
        reason: parsed.error,
        spawnCallId: toolCallId,
        subagentType: parsed.subagentType ?? pending.subagentType,
      }),
    ];
  }
  for (const agentId of agentIds) {
    if (!isKimiAgentId(agentId) || agentId === KIMI_MAIN_AGENT_ID) continue;
    events.push(
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: agentId,
        parent: ownerAgentId,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          protocol: "stream-json",
          spawn_call_id: toolCallId,
          session_id: state.sessionId,
          agent_id: agentId,
          parent_agent_id: ownerAgentId,
          subagent_type: pending.subagentType,
          actual_subagent_type: parsed.subagentType,
          plan_mode_inherited: false,
          readonly_by_profile: kimiReadonlyByProfile(
            parsed.subagentType ?? pending.subagentType,
          ),
          resume_target: "agent",
        }),
      }),
    );
    events.push(
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: agentId,
        parent: ownerAgentId,
        kind: "state",
        payload: StatePayloadSchema.parse({
          protocol: "stream-json",
          status: parsed.status ?? "unknown",
          reason: parsed.error,
          session_id: state.sessionId,
          agent_id: agentId,
          parent_agent_id: ownerAgentId,
          plan_mode_inherited: false,
          exception: parsed.error
            ? { message: clip(parsed.error, 500) }
            : undefined,
        }),
      }),
    );
  }
  return events;
}

function decodeEvent2(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const type = stringField(record.type);
  if (type === "event.session.created") {
    const session = asRecord(record.session);
    const sessionId = stringField(session?.id) ?? stringField(record.session_id);
    if (!sessionId || !isKimiSessionId(sessionId)) return [];
    rememberSession(state, sessionId);
    return [
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          protocol: "event2",
          session_id: sessionId,
          agent_id: KIMI_MAIN_AGENT_ID,
          resume_target: "session",
        }),
      }),
    ];
  }
  const agentId =
    stringField(record.subagentId) ?? stringField(record.agent_id);
  if (!agentId || !isKimiAgentId(agentId)) return [];
  const parent =
    stringField(record.parentAgentId) ??
    stringField(record.parent_agent_id) ??
    KIMI_MAIN_AGENT_ID;
  if (type === "subagent.spawned") {
    const subagentType =
      stringField(record.subagentName) ?? stringField(record.subagent_type);
    return [
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: agentId,
        parent,
        kind: "discovered",
        payload: DiscoveredPayloadSchema.parse({
          protocol: "event2",
          spawn_call_id: stringField(record.parentToolCallId),
          session_id: state.sessionId,
          agent_id: agentId,
          parent_agent_id: parent,
          subagent_type: subagentType,
          plan_mode_inherited: false,
          readonly_by_profile: kimiReadonlyByProfile(subagentType),
          resume_target: "agent",
        }),
      }),
    ];
  }
  if (type === "subagent.started") {
    return [
      childStateEvent(state, sourceId, {
        status: "running",
        agentId,
        parent,
      }),
    ];
  }
  if (type === "subagent.completed") {
    return [
      childStateEvent(state, sourceId, {
        status: "completed",
        agentId,
        parent,
      }),
    ];
  }
  if (type === "subagent.failed") {
    return [
      childStateEvent(state, sourceId, {
        status: "failed",
        agentId,
        parent,
        reason: stringField(record.error),
      }),
    ];
  }
  if (type === "subagent.suspended") {
    return [
      childStateEvent(state, sourceId, {
        status: "interrupted",
        agentId,
        parent,
        reason: stringField(record.reason),
      }),
    ];
  }
  return [];
}

function decodeAgentStatus(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
): NativeConversationEvent[] {
  const events: NativeConversationEvent[] = [];
  const modelAlias = stringField(record.model);
  const thinkingEffort = stringField(record.thinkingEffort);
  if (modelAlias || thinkingEffort) {
    events.push(
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "model",
        payload: ModelPayloadSchema.parse({
          protocol: "event2",
          model_alias: modelAlias,
          thinking_effort: thinkingEffort,
          source: "native_event",
        }),
      }),
    );
  }
  if (typeof record.planMode === "boolean") {
    events.push(
      eventBase({
        sourceId,
        sourceSeq: nextSeq(state),
        rootNativeId: state.rootNativeId,
        session: state.sessionId,
        agent: KIMI_MAIN_AGENT_ID,
        kind: "state",
        payload: StatePayloadSchema.parse({
          protocol: "event2",
          status: "running",
          session_id: state.sessionId,
          agent_id: KIMI_MAIN_AGENT_ID,
          plan_mode: record.planMode,
          plan_mode_inherited: false,
        }),
      }),
    );
  }
  return events;
}

function decodeProfileBind(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
  ownerAgentId: string,
): NativeConversationEvent[] {
  const modelAlias = stringField(record.modelAlias);
  const thinkingEffort = stringField(record.thinkingEffort);
  if (!modelAlias && !thinkingEffort) return [];
  return [
    eventBase({
      sourceId,
      sourceSeq: nextSeq(state),
      rootNativeId: state.rootNativeId,
      session: state.sessionId,
      agent: ownerAgentId,
      parent:
        ownerAgentId === KIMI_MAIN_AGENT_ID ? undefined : KIMI_MAIN_AGENT_ID,
      kind: "model",
      payload: ModelPayloadSchema.parse({
        protocol: "session-record",
        model_alias: modelAlias,
        thinking_effort: thinkingEffort,
        source: "native_session",
      }),
    }),
  ];
}

function decodeLlmRequest(
  record: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
  ownerAgentId: string,
): NativeConversationEvent[] {
  const modelAlias = stringField(record.modelAlias);
  const thinkingEffort = stringField(record.thinkingEffort);
  if (!modelAlias && !thinkingEffort) return [];
  return [
    eventBase({
      sourceId,
      sourceSeq: nextSeq(state),
      rootNativeId: state.rootNativeId,
      session: state.sessionId,
      agent: ownerAgentId,
      parent:
        ownerAgentId === KIMI_MAIN_AGENT_ID ? undefined : KIMI_MAIN_AGENT_ID,
      kind: "model",
      payload: ModelPayloadSchema.parse({
        protocol: "session-record",
        model_alias: modelAlias,
        thinking_effort: thinkingEffort,
        source: "native_event",
      }),
    }),
  ];
}

function decodeLoopEvent(
  event: Record<string, unknown>,
  state: KimiStreamState,
  sourceId: string,
  ownerAgentId: string,
): NativeConversationEvent[] {
  const type = stringField(event.type);
  if (type === "tool.call") {
    return decodeToolCall(
      {
        id: event.toolCallId,
        name: event.name,
        arguments: event.args,
      },
      state,
      sourceId,
      ownerAgentId,
    );
  }
  if (type === "tool.result") {
    const output = asRecord(event.result);
    return decodeToolResult(
      {
        tool_call_id: event.toolCallId,
        content: output?.output ?? event.result,
      },
      state,
      sourceId,
      ownerAgentId,
    );
  }
  return [];
}

function childStateEvent(
  state: KimiStreamState,
  sourceId: string,
  input: {
    status: string;
    agentId?: string;
    parent?: string;
    reason?: string;
    spawnCallId?: string;
    subagentType?: string;
  },
): NativeConversationEvent {
  return eventBase({
    sourceId,
    sourceSeq: nextSeq(state),
    rootNativeId: state.rootNativeId,
    session: state.sessionId,
    agent: input.agentId,
    parent: input.parent ?? KIMI_MAIN_AGENT_ID,
    kind: "state",
    payload: StatePayloadSchema.parse({
      protocol: "stream-json",
      status: input.status,
      reason: input.reason,
      session_id: state.sessionId,
      agent_id: input.agentId,
      parent_agent_id: input.parent ?? KIMI_MAIN_AGENT_ID,
      plan_mode_inherited: false,
      exception: input.reason ? { message: clip(input.reason, 500) } : undefined,
    }),
  });
}

function rememberSession(state: KimiStreamState, sessionId: string): void {
  state.sessionId = sessionId;
  if (state.rootNativeId === "unbound-root") state.rootNativeId = sessionId;
}

function nextSeq(state: KimiStreamState): string {
  state.nextSeq += 1;
  return String(state.nextSeq);
}

function looksLikeCodexRecord(record: Record<string, unknown>): boolean {
  if (stringField(record.thread_id)) return true;
  if (stringField(record.sandbox_mode)) return true;
  if (stringField(record.type) === "session_meta") return true;
  if (stringField(record.type) === "item.started") return true;
  if (stringField(record.type) === "item.completed") return true;
  return false;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = parseJsonLine(value);
    return asRecord(parsed) ?? {};
  }
  return asRecord(value) ?? {};
}

function parseAgentResult(content: string): {
  agentId?: string;
  agentIds: string[];
  subagentType?: string;
  status?: string;
  error?: string;
} {
  const agentIds: string[] = [];
  let agentId: string | undefined;
  let subagentType: string | undefined;
  let status: string | undefined;
  let error: string | undefined;
  for (const line of content.split(/\r?\n/)) {
    const labeled = /^agent_id:\s*(\S+)/.exec(line);
    if (labeled?.[1] && isKimiAgentId(labeled[1])) {
      agentId = labeled[1];
      agentIds.push(labeled[1]);
      continue;
    }
    const attr = /agent_id="([^"]+)"/.exec(line);
    if (attr?.[1] && isKimiAgentId(attr[1])) {
      agentIds.push(attr[1]);
      agentId = agentId ?? attr[1];
      continue;
    }
    const typeMatch = /^actual_subagent_type:\s*(\S+)/.exec(line);
    if (typeMatch?.[1]) subagentType = typeMatch[1];
    const statusMatch = /^status:\s*(\S+)/.exec(line);
    if (statusMatch?.[1]) status = mapAgentStatus(statusMatch[1]);
    const errorMatch = /^subagent error:\s*(.+)$/.exec(line);
    if (errorMatch?.[1]) error = errorMatch[1];
  }
  if (!status && /was stopped before it finished/i.test(content)) {
    status = "interrupted";
    error = error ?? "The subagent was stopped before it finished.";
  }
  return { agentId, agentIds: unique(agentIds), subagentType, status, error };
}

function mapAgentStatus(status: string): string {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "running") return "running";
  if (status === "cancelled" || status === "killed" || status === "stopped") {
    return "interrupted";
  }
  return status;
}

function eventBase(input: {
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
    source_id: input.sourceId,
    source_seq: input.sourceSeq,
    root_native_id: input.rootNativeId,
    session_native_id: input.session,
    agent_native_id: input.agent,
    parent_native_id: input.parent,
    kind: input.kind,
    occurred_at: input.occurredAt,
    payload: input.payload,
  };
}

function kimiNormalizeWorkDir(workDir: string): string {
  if (/^[A-Za-z]:[\\/]/.test(workDir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)) {
    return win32.resolve(workDir).replaceAll("\\", "/");
  }
  return resolve(workDir);
}

function kimiSlugifyWorkDir(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, WORKDIR_SLUG_MAX)
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" || slug === "." || slug === ".." ? "workspace" : slug;
}

function uniqueDirs(paths: string[]): string[] {
  const dirs = new Set<string>();
  for (const filePath of paths) dirs.add(dirname(filePath));
  return [...dirs];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? "";
}

async function readJsonFile(filePath: string): Promise<unknown> {
  if (!isAbsolute(filePath) && filePath.includes(`..${sep}`)) return undefined;
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return undefined;
  }
}
