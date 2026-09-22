import { join } from "node:path";
import type {
  ConversationSourceCursor,
  HostChunk,
  NativeConversationEvent,
} from "../../sdk/src/interface.js";
import {
  CONVERSATION_SOURCE_LIMITS,
  type ConversationRecordSource,
  parseJsonLine,
  readJsonlSlice,
} from "../../sdk/src/conversation-source.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { SubagentCapabilitiesSchema } from "../../../contracts/src/conversation.js";
import {
  AgyNativeRecordSource,
  agyStepSourceId,
  childAssociationFromPublicStep,
  isAgyConversationId,
  isAgyDelegationTool,
  type AgyChildAssociation,
  type AgyNativeStep,
  type AgyStepIdentity,
} from "./native-record-source.js";

export const AGY_PAUSE_ATTRIBUTION =
  "暂停归属：agy 子会话不能按原生 session abort 单独确认，当前 Run 只停止受管进程树；只读委派未验证。";

export interface AgyConversationDecodeContext {
  rootNativeId: string;
}

export function agySubagentCapabilities(cliVersion?: string): SubagentCapabilities {
  return SubagentCapabilitiesSchema.parse({
    discovery: "scoped-record",
    activity: "scoped-record",
    stop: "owned-process-tree",
    resume: "parent-instruction",
    readonly_delegation: "unknown",
    file_input: { text: false, image: false, binary: false },
    cli_version: cliVersion,
    reason: AGY_PAUSE_ATTRIBUTION,
  });
}

export function agyActivityId(identity: AgyStepIdentity): string {
  return agyStepSourceId(identity);
}

function eventBase(
  context: AgyConversationDecodeContext,
  sessionId: string,
  sourceSeq: string,
  kind: NativeConversationEvent["kind"],
  payload: unknown,
  parentId?: string,
): NativeConversationEvent {
  return {
    source_id: `agy:${sessionId}`,
    source_seq: sourceSeq,
    root_native_id: context.rootNativeId,
    session_native_id: sessionId,
    parent_native_id: parentId,
    kind,
    payload,
  };
}

function stepIdentity(
  conversationId: string,
  stepIndex: unknown,
): AgyStepIdentity | undefined {
  if (!isAgyConversationId(conversationId)) return;
  if (typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) || stepIndex < 0)
    return;
  return { conversation_id: conversationId, step_index: stepIndex };
}

function toolName(step: Record<string, unknown>): unknown {
  const info = step.tool_info;
  if (info && typeof info === "object" && !Array.isArray(info)) {
    const named = (info as Record<string, unknown>).name;
    if (typeof named === "string") return named;
  }
  return step.tool_name;
}

function toolInfo(step: Record<string, unknown>): Record<string, unknown> {
  const info = step.tool_info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return {};
  return info as Record<string, unknown>;
}

function publicParameters(info: Record<string, unknown>): Record<string, unknown> {
  const value = info.parameters ?? info.args;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function streamStep(step: AgyNativeStep, info: Record<string, unknown>): AgyNativeStep {
  const output = info.output;
  return {
    ...step,
    output: typeof output === "string" ? output : step.output,
  };
}

function parentStatePayload(status: "waiting" | "running") {
  return { status };
}

function childStatePayload(
  status: "discovered" | "starting" | "running" | "completed" | "failed" | "unknown",
  association: AgyChildAssociation,
) {
  return {
    status,
    spawn_call_id: association.spawn_call_id,
    unread_fields: association.unread_fields,
    unread_reason: association.unread_reason,
  };
}

function delegationEvents(
  context: AgyConversationDecodeContext,
  parentId: string,
  identity: AgyStepIdentity,
  step: Record<string, unknown>,
  association: AgyChildAssociation,
): NativeConversationEvent[] {
  const seq = agyActivityId(identity) + ":" + String(step.state ?? "");
  const childId = association.child_conversation_id;
  const parentWaiting = eventBase(
    context,
    parentId,
    seq + ":parent",
    "state",
    parentStatePayload(step.state === "DONE" || step.state === "ERROR" ? "running" : "waiting"),
  );
  if (!childId) {
    return [
      parentWaiting,
      eventBase(
        context,
        parentId,
        seq + ":unread",
        "discovered",
        {
          spawn_call_id: association.spawn_call_id,
          unread_fields: association.unread_fields,
          unread_reason: association.unread_reason,
        },
      ),
    ];
  }
  const childStatus =
    step.state === "ERROR"
      ? "failed"
      : step.state === "DONE"
        ? "completed"
        : "running";
  const discovered = eventBase(
    context,
    childId,
    seq + ":child",
    "discovered",
    {
      spawn_call_id: association.spawn_call_id,
      title: association.title ?? association.agent_native_id,
    },
    parentId,
  );
  discovered.agent_native_id = association.agent_native_id;
  const childState = eventBase(
    context,
    childId,
    seq + ":child-state",
    "state",
    childStatePayload(childStatus, association),
    parentId,
  );
  childState.agent_native_id = association.agent_native_id;
  return [parentWaiting, discovered, childState];
}

function parentActivity(
  context: AgyConversationDecodeContext,
  identity: AgyStepIdentity,
  step: Record<string, unknown>,
  name: unknown,
): NativeConversationEvent {
  const info = toolInfo(step);
  const params = publicParameters(info);
  const command = params.CommandLine ?? params.command;
  return eventBase(
    context,
    identity.conversation_id,
    agyActivityId(identity) + ":" + String(step.state ?? ""),
    "activity",
    {
      activity_id: agyActivityId(identity),
      title: typeof name === "string" ? name : undefined,
      status: step.state === "ERROR" ? "failed" : step.state === "DONE" ? "completed" : "running",
      kind: step.step_type === "tool" ? "tool" : "event",
      command: typeof command === "string" ? command.slice(0, 32000) : undefined,
    },
  );
}

function decodeInit(
  event: Record<string, unknown>,
  context: AgyConversationDecodeContext,
): NativeConversationEvent[] {
  const session = String(event.conversation_id ?? "");
  if (!isAgyConversationId(session)) return [];
  const init = event.init;
  const model =
    init && typeof init === "object" && !Array.isArray(init)
      ? (init as Record<string, unknown>).model
      : undefined;
  const events = [
    eventBase(context, session, session + ":init", "discovered", {
      status: "discovered",
    }),
    eventBase(context, session, session + ":init-state", "state", {
      status: "running",
    }),
  ];
  if (typeof model === "string" && model) {
    events.push(
      eventBase(context, session, session + ":model", "model", {
        actual_model: model,
        model_source: "native_event",
      }),
    );
  }
  return events;
}

function decodeResult(
  event: Record<string, unknown>,
  context: AgyConversationDecodeContext,
): NativeConversationEvent[] {
  const result = event.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const record = result as Record<string, unknown>;
  const session = String(record.conversation_id ?? event.conversation_id ?? "");
  if (!isAgyConversationId(session)) return [];
  const failed = record.status !== "SUCCESS";
  return [
    eventBase(context, session, session + ":result", "state", {
      status: failed ? "failed" : "completed",
      reason: failed ? "native_error" : undefined,
    }),
  ];
}

function decodeStep(
  event: Record<string, unknown>,
  context: AgyConversationDecodeContext,
): NativeConversationEvent[] {
  const step = event.step_update;
  if (!step || typeof step !== "object" || Array.isArray(step)) return [];
  const record = step as Record<string, unknown>;
  const session = String(record.conversation_id ?? "");
  const identity = stepIdentity(session, record.step_index);
  if (!identity) return [];
  if (record.step_type !== "tool") {
    if (record.step_type === "agent_response" && record.usage) {
      return [
        eventBase(
          context,
          session,
          agyActivityId(identity) + ":quota",
          "quota",
          record.usage,
        ),
      ];
    }
    return [];
  }
  const name = toolName(record);
  const info = toolInfo(record);
  const params = publicParameters(info);
  if (!isAgyDelegationTool(name)) {
    return [parentActivity(context, identity, record, name)];
  }
  const association = childAssociationFromPublicStep(
    identity,
    streamStep(
      {
        call_id: agyActivityId(identity),
        name: String(name),
        parameters: params,
      },
      info,
    ),
  );
  if (!association) return [parentActivity(context, identity, record, name)];
  return delegationEvents(context, session, identity, record, association);
}

export function decodeAgyConversationEvent(
  event: unknown,
  context: AgyConversationDecodeContext,
): NativeConversationEvent[] {
  if (!event || typeof event !== "object" || Array.isArray(event)) return [];
  const record = event as Record<string, unknown>;
  if (record.event === "init") return decodeInit(record, context);
  if (record.event === "result") return decodeResult(record, context);
  if (record.event === "step_update") return decodeStep(record, context);
  return [];
}

export function decodeAgyConversationEvents(
  events: unknown[],
  context: AgyConversationDecodeContext,
): NativeConversationEvent[] {
  return events.flatMap((event) => decodeAgyConversationEvent(event, context));
}

function recordConversationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const id = (value as Record<string, unknown>).conversation_id;
  return isAgyConversationId(id) ? id : undefined;
}

export function agyEventConversationId(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  return (
    recordConversationId(record) ??
    recordConversationId(record.step_update) ??
    recordConversationId(record.result)
  );
}

export class AgyConversationDecoder {
  private buffer = "";
  constructor(private rootNativeId?: string) {}

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
      events.push(...this.decodeLine(line));
    }
    return events;
  }

  private decodeLine(line: string): NativeConversationEvent[] {
    const parsed = parseJsonLine(line);
    const root = this.rootNativeId ?? agyEventConversationId(parsed);
    if (!root) return [];
    this.rootNativeId = root;
    return decodeAgyConversationEvent(parsed, { rootNativeId: root });
  }
}

export class AgyConversationSource implements ConversationRecordSource {
  readonly adapterId = "agy";
  readonly sourceId: string;
  private records: AgyNativeRecordSource;
  constructor(
    private options: {
      profileRoot: string;
      rootNativeId: string;
      streamPath?: string;
      cliVersion?: string;
    },
  ) {
    this.sourceId = `agy:${options.rootNativeId}`;
    this.records = new AgyNativeRecordSource(options.profileRoot);
  }
  capabilities(): SubagentCapabilities {
    return agySubagentCapabilities(this.options.cliVersion);
  }
  recordSource(): AgyNativeRecordSource {
    return this.records;
  }
  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const streamPath = this.options.streamPath;
    if (!streamPath || cursor.source_id !== `agy:${this.options.rootNativeId}`)
      return [];
    const slice = await readJsonlSlice({
      filePath: streamPath,
      offsetBytes: Number(cursor.source_seq ?? "0") || 0,
      fileIdentity: cursor.file_identity,
      maxBytes: CONVERSATION_SOURCE_LIMITS.maxBytesPerRound,
      maxLineBytes: CONVERSATION_SOURCE_LIMITS.maxLineBytes,
    });
    const events: NativeConversationEvent[] = [];
    for (const line of slice.lines) {
      const parsed = parseJsonLine(line);
      events.push(
        ...decodeAgyConversationEvent(parsed, {
          rootNativeId: this.options.rootNativeId,
        }),
      );
    }
    return events;
  }
}

export function agyRecordPath(profileRoot: string, conversationId: string): string {
  return join(
    profileRoot,
    ".gemini",
    "antigravity-cli",
    "conversations",
    conversationId + ".db",
  );
}
