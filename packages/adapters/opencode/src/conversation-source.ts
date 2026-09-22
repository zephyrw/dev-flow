import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { unknownSubagentCapabilities } from "../../../contracts/src/conversation.js";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  PreparedInvocation,
  RunContext,
} from "../../sdk/src/interface.js";
import type { ConversationRecordSource } from "../../sdk/src/conversation-source.js";
import {
  parseJsonLine,
  readJsonlSlice,
} from "../../sdk/src/conversation-source.js";

export const OPENCODE_ADAPTER_ID = "opencode";
export const OPENCODE_KNOWN_JSON_TYPES = new Set([
  "tool_use",
  "step_start",
  "step_finish",
  "text",
  "error",
]);
export const OPENCODE_WRITE_TOOLS = ["edit", "write", "bash", "patch"] as const;
export const OPENCODE_READONLY_TOOLS = ["read", "glob", "grep", "list"] as const;
export const OPENCODE_GLOBAL_ORIGINS = [
  "http://localhost:4096",
  "http://127.0.0.1:4096",
  "http://[::1]:4096",
];
export const OPENCODE_READONLY_TASK_PERMISSION = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  task: {
    "*": "deny",
    "devflow-review-child": "allow",
  },
} as const;

const DiscoveredPayloadSchema = z
  .object({
    title: z.string().max(200).optional(),
    agent: z.string().max(200).optional(),
    spawn_call_id: z.string().min(1).optional(),
    subagent_type: z.string().max(200).optional(),
  })
  .strict();
const StatePayloadSchema = z
  .object({
    status: z.enum([
      "discovered",
      "starting",
      "running",
      "waiting",
      "paused",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "unknown",
    ]),
    native_status: z.string().max(80).optional(),
  })
  .strict();
const ActivityPayloadSchema = z
  .object({
    activity_id: z.string().min(1),
    kind: z.enum(["tool", "message", "event"]),
    title: z.string().max(200).optional(),
    public_text: z.string().max(16000).optional(),
    tool: z.string().max(80).optional(),
  })
  .strict();
const ModelPayloadSchema = z
  .object({
    actual_model: z.string().min(1).optional(),
    provider_id: z.string().min(1).optional(),
    variant: z.string().min(1).optional(),
  })
  .strict();

export interface OpenCodeManagedServer {
  origin: string;
  runId: string;
  username?: string;
  password?: string;
}

export interface OpenCodeInstanceBinding {
  workflowId: string;
  runId: string;
  lineageId: string;
  rootSessionId?: string;
  purpose?: string;
  cliVersion?: string;
  agentName?: string;
  agentConfig?: unknown;
  eventFilePath?: string;
  managedServer?: OpenCodeManagedServer;
}

export interface OpenCodeHttpClient {
  get(path: string): Promise<unknown>;
  post(path: string): Promise<unknown>;
}

export type OpenCodeBindResult =
  | { ok: true; binding: OpenCodeInstanceBinding }
  | { ok: false; reason: string };

export interface OpenCodeTaskPermissionResult {
  readonly_delegation: SubagentCapabilities["readonly_delegation"];
  allowed_agents: string[];
  reason?: string;
}

export function isLoopbackOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  const host = url.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

export function isExternalOpenCodeOrigin(
  origin: string,
  bound?: OpenCodeManagedServer,
): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized || !isLoopbackOrigin(normalized)) return true;
  if (bound && bound.origin === normalized) return false;
  return OPENCODE_GLOBAL_ORIGINS.includes(normalized);
}

export function bindOpenCodeInstance(
  candidate: {
    origin?: string;
    sessionId?: string;
    runId?: string;
    attachUrl?: string;
  },
  expected: OpenCodeInstanceBinding,
): OpenCodeBindResult {
  if (candidate.runId && candidate.runId !== expected.runId)
    return { ok: false, reason: "候选实例不属于当前受管运行" };
  const attach = candidate.attachUrl ?? candidate.origin;
  if (attach) {
    const origin = normalizeOrigin(attach);
    if (!origin) return { ok: false, reason: "实例地址无法解析" };
    if (!isLoopbackOrigin(origin))
      return { ok: false, reason: "拒绝非本机回环 OpenCode 实例" };
    if (isExternalOpenCodeOrigin(origin, expected.managedServer))
      return { ok: false, reason: "拒绝未绑定的全局或外部 OpenCode server" };
    if (!expected.managedServer || expected.managedServer.origin !== origin)
      return { ok: false, reason: "拒绝连接未在本 Run 登记的 OpenCode server" };
    if (expected.managedServer.runId !== expected.runId)
      return { ok: false, reason: "server 绑定与当前运行不一致" };
  }
  if (
    candidate.sessionId &&
    expected.rootSessionId &&
    candidate.sessionId !== expected.rootSessionId
  )
    return { ok: false, reason: "候选 session 不是当前已绑定根会话" };
  return {
    ok: true,
    binding: {
      ...expected,
      rootSessionId: candidate.sessionId ?? expected.rootSessionId,
    },
  };
}

export function evaluateOpenCodeReadonlyTask(
  agentConfig: unknown,
  agentName = "devflow-review",
): OpenCodeTaskPermissionResult {
  const agents = readAgentMap(agentConfig);
  const permission = agents.get(agentName)?.permission;
  if (!permission)
    return {
      readonly_delegation: "unknown",
      allowed_agents: [],
      reason: "未提供当前 agent 的权限配置，无法证明只读 task",
    };
  const task = taskAllowList(permission);
  if (task.denied)
    return {
      readonly_delegation: "unsupported",
      allowed_agents: [],
      reason: "只读 agent 未放行 task，无法委派只读子 agent",
    };
  if (task.wildcard)
    return {
      readonly_delegation: "unsupported",
      allowed_agents: [],
      reason: "task 通配放行会允许可写子 agent",
    };
  if (task.names.length === 0)
    return {
      readonly_delegation: "unknown",
      allowed_agents: [],
      reason: "task 权限无法解析为明确子 agent 名单",
    };
  const writable = task.names.filter(
    (name) => !agentDeniesWrite(agents.get(name)?.permission),
  );
  if (writable.length)
    return {
      readonly_delegation: "unsupported",
      allowed_agents: task.names,
      reason: "task 允许的子 agent 未证明关闭写工具：" + writable.join(", "),
    };
  return { readonly_delegation: "verified", allowed_agents: task.names };
}

export function openCodeSubagentCapabilities(
  binding: OpenCodeInstanceBinding,
): SubagentCapabilities {
  const task = evaluateOpenCodeReadonlyTask(
    binding.agentConfig,
    binding.agentName ?? "devflow-review",
  );
  const http = Boolean(binding.managedServer);
  const local = Boolean(binding.rootSessionId || binding.eventFilePath);
  if (!http && !local)
    return unknownSubagentCapabilities(
      "没有可绑定的 OpenCode 实例或 session，未另启常驻服务",
    );
  if (!http) {
    return {
      discovery: "scoped-record",
      activity: "scoped-record",
      stop: "unavailable",
      resume: binding.rootSessionId ? "native" : "unavailable",
      readonly_delegation: task.readonly_delegation,
      file_input: { text: true, image: true, binary: false },
      cli_version: binding.cliVersion,
      reason: gapWithoutServer(task.reason),
    };
  }
  return {
    discovery: "native",
    activity: "native",
    stop: "native",
    resume: "native",
    readonly_delegation: task.readonly_delegation,
    file_input: { text: true, image: true, binary: false },
    cli_version: binding.cliVersion,
    reason: task.reason,
  };
}

export function decodeOpenCodeJsonEvent(
  raw: unknown,
  binding: OpenCodeInstanceBinding,
): NativeConversationEvent[] {
  if (!raw || typeof raw !== "object") return [];
  const item = raw as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : undefined;
  if (type && !OPENCODE_KNOWN_JSON_TYPES.has(type)) return [];
  const root = sessionIdOf(item.sessionID) ?? binding.rootSessionId;
  if (!root) return [];
  if (binding.rootSessionId && root !== binding.rootSessionId) return [];
  const occurred =
    typeof item.timestamp === "number"
      ? new Date(item.timestamp).toISOString()
      : undefined;
  if (type === "error")
    return eventList(
      binding,
      root,
      root,
      undefined,
      "state",
      occurred,
      StatePayloadSchema.safeParse({
        status: "failed",
        native_status: "error",
      }),
    );
  const part = asRecord(item.part);
  if (!part) return [];
  const partSession = sessionIdOf(part.sessionID) ?? root;
  if (partSession !== root) return [];
  if (type === "text")
    return textEvents(binding, root, part, occurred);
  if (type === "tool_use") return toolEvents(binding, root, part, occurred);
  if (type === "step_start" || type === "step_finish")
    return stepEvents(binding, root, part, type, occurred);
  return [];
}

export class OpenCodeConversationSource implements ConversationRecordSource {
  readonly adapterId = OPENCODE_ADAPTER_ID;
  private binding: OpenCodeInstanceBinding;
  private http?: OpenCodeHttpClient;
  private buffers = new Map<string, { decoder: StringDecoder; text: string }>();
  private known = new Set<string>();
  private children = new Set<string>();

  constructor(
    binding: OpenCodeInstanceBinding,
    http?: OpenCodeHttpClient,
  ) {
    this.binding = { ...binding };
    this.http = http ?? (binding.managedServer ? httpClient(binding.managedServer) : undefined);
    if (binding.rootSessionId) this.known.add(binding.rootSessionId);
  }

  static fromPrepared(
    input: RunContext,
    invocation: PreparedInvocation,
  ): OpenCodeConversationSource {
    return new OpenCodeConversationSource(bindingFromPrepared(input, invocation));
  }

  capabilities(): SubagentCapabilities {
    return openCodeSubagentCapabilities(this.binding);
  }

  bindRootSession(sessionId: string): OpenCodeBindResult {
    const result = bindOpenCodeInstance(
      { sessionId, runId: this.binding.runId },
      this.binding,
    );
    if (result.ok) {
      this.binding = result.binding;
      this.known.add(sessionId);
    }
    return result;
  }

  decodeChunk(chunk: HostChunk): NativeConversationEvent[] {
    const key = (chunk.runId ?? this.binding.runId) + ":" + chunk.stream;
    const stream = this.buffers.get(key) ?? {
      decoder: new StringDecoder("utf8"),
      text: "",
    };
    this.buffers.set(key, stream);
    stream.text +=
      typeof chunk.data === "string"
        ? chunk.data
        : stream.decoder.write(chunk.data);
    if (chunk.final) stream.text += stream.decoder.end() + "\n";
    const lines = stream.text.split("\n");
    stream.text = lines.pop() ?? "";
    const events: NativeConversationEvent[] = [];
    for (const line of lines) {
      const raw = parseJsonLine(line.trim());
      if (raw === undefined) continue;
      this.captureRoot(raw);
      events.push(...decodeOpenCodeJsonEvent(raw, this.binding));
    }
    for (const event of events) this.remember(event);
    return events;
  }

  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (this.binding.managedServer && this.http)
      return this.readServerEvents(cursor);
    if (!this.binding.eventFilePath) return [];
    const slice = await readJsonlSlice({
      filePath: this.binding.eventFilePath,
      offsetBytes: Number(cursor.source_seq ?? "0") || 0,
      fileIdentity: cursor.file_identity,
    });
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) {
      const raw = parseJsonLine(line);
      if (raw === undefined) continue;
      this.captureRoot(raw);
      events.push(...decodeOpenCodeJsonEvent(raw, this.binding));
    }
    for (const event of events) this.remember(event);
    return events;
  }

  async abort(target: ConversationStopTarget): Promise<ConversationStopResult> {
    const session = target.native_session_id;
    if (!session)
      return unconfirmed(target, "缺少已绑定的原生 session");
    if (!this.ownsSession(session))
      return unconfirmed(target, "目标 session 不属于当前绑定实例");
    if (!this.binding.managedServer || !this.http)
      return unconfirmed(
        target,
        "当前受管运行没有可绑定的 OpenCode HTTP server，未调用 abort，也未另启常驻服务",
      );
    try {
      const result = await this.http.post(
        "/session/" + encodeURIComponent(session) + "/abort",
      );
      if (result !== true)
        return unconfirmed(target, "原生 abort 未确认");
      return {
        conversation_id: target.conversation_id,
        confirmation: "native",
        status: "paused",
      };
    } catch (error) {
      return unconfirmed(target, String(error));
    }
  }

  private async readServerEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const root = this.binding.rootSessionId;
    if (!root || !this.http) return [];
    const after = Number(cursor.source_seq ?? "0") || 0;
    const events: NativeConversationEvent[] = [];
    const children = asArray(await this.http.get("/session/" + encodeURIComponent(root) + "/children"));
    for (const child of children) {
      const info = asRecord(child);
      if (!info) continue;
      const id = sessionIdOf(info.id);
      const parent: string = sessionIdOf(info.parentID) ?? root;
      if (!id || parent !== root) continue;
      this.children.add(id);
      this.known.add(id);
      const updated = numberOf(asRecord(info.time)?.updated) ?? 0;
      if (updated <= after) continue;
      events.push(
        ...sessionInfoEvents(this.binding, root, info, updated),
      );
    }
    const tree = [root, ...this.children];
    const statusMap = asRecord(await this.http.get("/session/status")) ?? {};
    for (const session of tree) {
      const native = asRecord(statusMap[session]);
      const nativeStatus =
        typeof native?.type === "string" ? native.type : undefined;
      events.push(
        ...eventList(
          this.binding,
          root,
          session,
          session === root ? undefined : root,
          "state",
          undefined,
          StatePayloadSchema.safeParse({
            status: statusFromNative(nativeStatus),
            native_status: nativeStatus,
          }),
        ),
      );
      const messages = asArray(
        await this.http.get("/session/" + encodeURIComponent(session) + "/message"),
      );
      events.push(
        ...messageEvents(this.binding, root, session, messages, after),
      );
    }
    return events.filter((event) => Number(event.source_seq) > after);
  }

  private captureRoot(raw: unknown) {
    if (this.binding.rootSessionId) return;
    const item = asRecord(raw);
    const session = sessionIdOf(item?.sessionID);
    if (!session) return;
    this.binding = { ...this.binding, rootSessionId: session };
    this.known.add(session);
  }

  private remember(event: NativeConversationEvent) {
    this.known.add(event.session_native_id ?? event.root_native_id);
    if (event.agent_native_id) this.known.add(event.agent_native_id);
    const childId = event.session_native_id ?? event.agent_native_id;
    if (event.parent_native_id && childId) this.children.add(childId);
  }

  private ownsSession(session: string): boolean {
    if (!this.binding.rootSessionId) return false;
    return session === this.binding.rootSessionId || this.known.has(session);
  }
}

export function bindingFromPrepared(
  input: RunContext,
  invocation: PreparedInvocation,
): OpenCodeInstanceBinding {
  const attach = flagValue(invocation.args, "--attach");
  const port = flagValue(invocation.args, "--port");
  const managed = managedServerFromInvocation(input.runId, port, attach);
  return {
    workflowId: input.workflowId,
    runId: input.runId,
    lineageId: input.workflowId + ":" + input.runId,
    rootSessionId: input.conversationId,
    purpose: input.purpose,
    agentName: flagValue(invocation.args, "--agent") ?? "devflow-review",
    agentConfig: parseAgentConfig(invocation.env.OPENCODE_CONFIG_CONTENT),
    managedServer: managed,
  };
}

function managedServerFromInvocation(
  runId: string,
  port: string | undefined,
  attach: string | undefined,
): OpenCodeManagedServer | undefined {
  if (attach) return undefined;
  if (!port || port === "0") return undefined;
  const origin = normalizeOrigin("http://127.0.0.1:" + port);
  if (!origin || !isLoopbackOrigin(origin)) return undefined;
  return { origin, runId };
}

function gapWithoutServer(taskReason?: string): string {
  const gap =
    "当前受管运行没有可绑定的 HTTP server，仅能使用本 Run 的 json/session 记录；未连接全局 server，也未另启常驻服务。缺少 children/messages/status/abort。";
  return taskReason ? gap + " " + taskReason : gap;
}

function toolEvents(
  binding: OpenCodeInstanceBinding,
  root: string,
  part: Record<string, unknown>,
  occurred?: string,
): NativeConversationEvent[] {
  const state = asRecord(part.state) ?? {};
  const input = asRecord(state.input) ?? {};
  const metadata = asRecord(state.metadata) ?? {};
  const tool = typeof part.tool === "string" ? part.tool : undefined;
  const call = stringOf(part.callID ?? part.id);
  const child = sessionIdOf(metadata.sessionId);
  const events: NativeConversationEvent[] = [];
  if (tool === "task" && child) {
    events.push(
      ...eventList(
        binding,
        root,
        child,
        root,
        "discovered",
        occurred,
        DiscoveredPayloadSchema.safeParse({
          title: stringOf(input.description) ?? stringOf(metadata.title),
          agent: stringOf(input.subagent_type) ?? stringOf(metadata.agent),
          spawn_call_id: call,
          subagent_type: stringOf(input.subagent_type),
        }),
      ),
    );
    events.push(
      ...eventList(
        binding,
        root,
        child,
        root,
        "state",
        occurred,
        StatePayloadSchema.safeParse({
          status: statusFromTool(stringOf(state.status)),
          native_status: stringOf(state.status),
        }),
      ),
    );
    const model = modelFrom(metadata.model);
    if (model)
      events.push(
        ...eventList(
          binding,
          root,
          child,
          root,
          "model",
          occurred,
          ModelPayloadSchema.safeParse(model),
        ),
      );
  }
  events.push(
    ...eventList(
      binding,
      root,
      root,
      undefined,
      "activity",
      occurred,
      ActivityPayloadSchema.safeParse({
        activity_id: call ?? "tool",
        kind: "tool",
        title: tool === "task" ? "委派子 Agent" : tool,
        public_text: publicToolText(tool, input),
        tool,
      }),
    ),
  );
  return events;
}

function textEvents(
  binding: OpenCodeInstanceBinding,
  root: string,
  part: Record<string, unknown>,
  occurred?: string,
): NativeConversationEvent[] {
  const text = stringOf(part.text);
  if (!text) return [];
  return eventList(
    binding,
    root,
    root,
    undefined,
    "activity",
    occurred,
    ActivityPayloadSchema.safeParse({
      activity_id: stringOf(part.id) ?? "text",
      kind: "message",
      title: "模型输出",
      public_text: text.slice(0, 16000),
    }),
  );
}

function stepEvents(
  binding: OpenCodeInstanceBinding,
  root: string,
  part: Record<string, unknown>,
  type: string,
  occurred?: string,
): NativeConversationEvent[] {
  return eventList(
    binding,
    root,
    root,
    undefined,
    "state",
    occurred,
    StatePayloadSchema.safeParse({
      status: type === "step_start" ? "running" : "running",
      native_status: type,
    }),
  );
}

function sessionInfoEvents(
  binding: OpenCodeInstanceBinding,
  root: string,
  info: Record<string, unknown>,
  updated: number,
): NativeConversationEvent[] {
  const id = sessionIdOf(info.id);
  if (!id) return [];
  const model = modelFrom(info.model);
  const occurred = new Date(updated).toISOString();
  const events = eventList(
    binding,
    root,
    id,
    root,
    "discovered",
    occurred,
    DiscoveredPayloadSchema.safeParse({
      title: stringOf(info.title),
      agent: stringOf(info.agent),
    }),
    String(updated),
  );
  if (model)
    events.push(
      ...eventList(
        binding,
        root,
        id,
        root,
        "model",
        occurred,
        ModelPayloadSchema.safeParse(model),
        String(updated),
      ),
    );
  return events;
}

function messageEvents(
  binding: OpenCodeInstanceBinding,
  root: string,
  session: string,
  messages: unknown[],
  after: number,
): NativeConversationEvent[] {
  const events: NativeConversationEvent[] = [];
  const parent = session === root ? undefined : root;
  for (const message of messages) {
    const row = asRecord(message);
    const info = asRecord(row?.info) ?? row;
    if (!info) continue;
    const created = numberOf(asRecord(info.time)?.created) ?? 0;
    if (created <= after) continue;
    const parts = asArray(row?.parts);
    for (const part of parts) {
      const item = asRecord(part);
      if (!item || item.type === "reasoning") continue;
      if (item.type === "text") {
        events.push(
          ...eventList(
            binding,
            root,
            session,
            parent,
            "activity",
            new Date(created).toISOString(),
            ActivityPayloadSchema.safeParse({
              activity_id: stringOf(item.id) ?? "text",
              kind: "message",
              title: "模型输出",
              public_text: stringOf(item.text)?.slice(0, 16000),
            }),
            String(created),
          ),
        );
      }
      if (item.type === "tool") {
        const state = asRecord(item.state) ?? {};
        events.push(
          ...eventList(
            binding,
            root,
            session,
            parent,
            "activity",
            new Date(created).toISOString(),
            ActivityPayloadSchema.safeParse({
              activity_id: stringOf(item.callID ?? item.id) ?? "tool",
              kind: "tool",
              title: stringOf(item.tool),
              public_text: publicToolText(
                stringOf(item.tool),
                asRecord(state.input) ?? {},
              ),
              tool: stringOf(item.tool),
            }),
            String(created),
          ),
        );
      }
    }
  }
  return events;
}

function eventList(
  binding: OpenCodeInstanceBinding,
  root: string,
  session: string,
  parent: string | undefined,
  kind: NativeConversationEvent["kind"],
  occurred: string | undefined,
  parsed: { success: boolean; data?: unknown },
  seq?: string,
): NativeConversationEvent[] {
  if (!parsed.success || parsed.data === undefined) return [];
  return [
    {
      source_id: binding.managedServer
        ? "opencode:server:" + binding.runId
        : "opencode:json:" + binding.runId,
      source_seq: seq ?? String(Date.now()),
      root_native_id: root,
      session_native_id: session,
      agent_native_id: session === root ? undefined : session,
      parent_native_id: parent,
      kind,
      occurred_at: occurred,
      payload: parsed.data,
    },
  ];
}

function httpClient(server: OpenCodeManagedServer): OpenCodeHttpClient {
  const headers: Record<string, string> = {};
  if (server.password) {
    const user = server.username ?? "opencode";
    headers.Authorization =
      "Basic " + Buffer.from(user + ":" + server.password).toString("base64");
  }
  const send = async (method: string, path: string) => {
    const signal = AbortSignal.timeout(3000);
    const response = await fetch(server.origin + path, {
      method,
      headers,
      signal,
    });
    if (!response.ok) throw new Error("OpenCode server " + response.status);
    return response.json();
  };
  return {
    get: (path) => send("GET", path),
    post: (path) => send("POST", path),
  };
}

function unconfirmed(
  target: ConversationStopTarget,
  reason: string,
): ConversationStopResult {
  return {
    conversation_id: target.conversation_id,
    confirmation: "unconfirmed",
    reason,
  };
}

function readAgentMap(
  config: unknown,
): Map<string, { permission?: unknown; mode?: unknown }> {
  const map = new Map<string, { permission?: unknown; mode?: unknown }>();
  const root = asRecord(config);
  const agents = asRecord(root?.agent) ?? asRecord(root?.agents) ?? root;
  if (!agents) return map;
  for (const [name, value] of Object.entries(agents)) {
    const item = asRecord(value);
    if (!item) continue;
    map.set(name, { permission: item.permission, mode: item.mode });
  }
  return map;
}

function taskAllowList(permission: unknown): {
  denied: boolean;
  wildcard: boolean;
  names: string[];
} {
  const task = permissionValue(permission, "task");
  if (task === undefined)
    return { denied: permissionAction(permission, "*") === "deny", wildcard: false, names: [] };
  if (task === "deny") return { denied: true, wildcard: false, names: [] };
  if (task === "allow" || task === "ask")
    return { denied: false, wildcard: true, names: [] };
  const record = asRecord(task);
  if (!record) return { denied: false, wildcard: false, names: [] };
  const wildcard = record["*"] === "allow" || record["*"] === "ask";
  const names = Object.entries(record)
    .filter(([key, value]) => key !== "*" && (value === "allow" || value === "ask"))
    .map(([key]) => key);
  const denied = !wildcard && names.length === 0;
  return { denied, wildcard, names };
}

function agentDeniesWrite(permission: unknown): boolean {
  if (!permission) return false;
  if (permissionAction(permission, "*") !== "deny") return false;
  return OPENCODE_WRITE_TOOLS.every(
    (tool) => permissionAction(permission, tool) === "deny",
  );
}

function permissionAction(permission: unknown, tool: string): string {
  const value = permissionValue(permission, tool);
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return "ask";
  const star = permissionValue(permission, "*");
  return typeof star === "string" ? star : "missing";
}

function permissionValue(permission: unknown, key: string): unknown {
  const record = asRecord(permission);
  if (!record) return undefined;
  return record[key];
}

function parseAgentConfig(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function sessionIdOf(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return undefined;
  return value;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function publicToolText(
  tool: string | undefined,
  input: Record<string, unknown>,
): string | undefined {
  if (tool === "task") return stringOf(input.description);
  const command = stringOf(input.command) ?? stringOf(input.path) ?? stringOf(input.pattern);
  return command?.slice(0, 500);
}

function modelFrom(raw: unknown): { actual_model?: string; provider_id?: string; variant?: string } | undefined {
  const item = asRecord(raw);
  if (!item) return undefined;
  const id = stringOf(item.id) ?? stringOf(item.modelID);
  const provider = stringOf(item.providerID) ?? stringOf(item.provider_id);
  if (!id && !provider) return undefined;
  return {
    actual_model: provider && id ? provider + "/" + id : id,
    provider_id: provider,
    variant: stringOf(item.variant),
  };
}

function statusFromTool(status?: string) {
  if (status === "running" || status === "pending") return "running";
  if (status === "completed") return "completed";
  if (status === "error") return "failed";
  return "unknown";
}

function statusFromNative(status?: string) {
  if (status === "busy" || status === "compact") return "running";
  if (status === "retry") return "waiting";
  if (status === "idle") return "unknown";
  return "unknown";
}
