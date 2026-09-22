import { StringDecoder } from "node:string_decoder";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  PreparedInvocation,
  RunContext,
} from "../../sdk/src/interface.js";
import {
  parseJsonLine,
  readJsonlSlice,
} from "../../sdk/src/conversation-source.js";

export const MIMO_ADAPTER_ID = "mimo-code";

export interface MimoInstanceBinding {
  workflowId: string;
  runId: string;
  lineageId: string;
  rootSessionId?: string;
  purpose?: string;
  cliVersion?: string;
  eventFilePath?: string;
}

export class MimoConversationSource {
  private buffers = new Map<string, { decoder: StringDecoder; text: string }>();
  private sessionId?: string;
  private targetSessionId?: string;
  private seq = 0;
  private eventFilePath?: string;
  private finished = false;
  private failed = false;
  private errorText?: string;

  constructor(private readonly binding: MimoInstanceBinding) {
    this.targetSessionId = binding.rootSessionId;
    this.sessionId = binding.rootSessionId;
    this.eventFilePath = binding.eventFilePath;
  }

  static fromPrepared(
    input: RunContext,
    prepared: PreparedInvocation,
  ): MimoConversationSource {
    const fromConversation = input.conversationId?.trim();
    const sessionIndex = prepared.args.indexOf("--session");
    const fromArgs =
      sessionIndex >= 0 ? prepared.args[sessionIndex + 1] : undefined;
    return new MimoConversationSource({
      workflowId: input.workflowId,
      runId: input.runId,
      lineageId: input.runId,
      rootSessionId: fromConversation || fromArgs,
      purpose: input.purpose,
    });
  }

  capabilities() {
    return {
      discovery: "unsupported" as const,
      nested_stopping: "unsupported" as const,
      image_input: "unsupported" as const,
      binary_file_input: "unsupported" as const,
      message_injection: "unsupported" as const,
      readonly_delegation: "unsupported" as const,
      allowed_agents: [] as string[],
    };
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
      events.push(...this.decodeLine(line));
    }
    return events;
  }

  async readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (!this.eventFilePath) return [];
    try {
      const slice = await readJsonlSlice({
        filePath: this.eventFilePath,
        offsetBytes: Number(cursor.source_seq ?? "0") || 0,
        fileIdentity: cursor.file_identity,
      });
      const events: NativeConversationEvent[] = [];
      for (const line of slice.lines) {
        events.push(...this.decodeLine(line));
      }
      return events;
    } catch {
      return [];
    }
  }

  async abort(
    target: ConversationStopTarget,
  ): Promise<ConversationStopResult> {
    const targetSession =
      target.native_session_id ?? this.targetSessionId ?? this.sessionId;
    if (targetSession && this.targetSessionId && targetSession !== this.targetSessionId) {
      return {
        conversation_id: target.conversation_id,
        confirmation: "unconfirmed",
        reason: "目标会话不属于当前 MiMo 运行",
      };
    }
    return {
      conversation_id: target.conversation_id,
      confirmation: "unconfirmed",
      reason:
        "MiMo Code 第一版不支持细粒度子会话停止；请使用任务进程树停止",
    };
  }

  isFinished(): boolean {
    return this.finished;
  }

  isFailed(): boolean {
    return this.failed;
  }

  lastError(): string | undefined {
    return this.errorText;
  }

  private nextSeq(): string {
    this.seq += 1;
    return String(this.seq);
  }

  private makeEvent(
    kind: NativeConversationEvent["kind"],
    payload: unknown,
    sessionId?: string,
  ): NativeConversationEvent {
    const session =
      sessionId ?? this.sessionId ?? this.targetSessionId ?? this.binding.runId;
    return {
      source_id: "mimo:json:" + this.binding.runId,
      source_seq: this.nextSeq(),
      root_native_id: this.targetSessionId ?? session,
      session_native_id: session,
      kind,
      payload,
    };
  }

  private decodeLine(line: string): NativeConversationEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const payload = parseJsonLine(trimmed);
    if (payload === undefined) {
      return [this.makeEvent("activity", { kind: "message", text: trimmed })];
    }
    const record = payload as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const part = (record.part ?? {}) as Record<string, unknown>;
    const err = (record.error ?? {}) as Record<string, unknown>;
    const errData = (err.data ?? {}) as Record<string, unknown>;
    const reportedSession =
      typeof record.sessionID === "string"
        ? record.sessionID
        : typeof record.session_id === "string"
          ? record.session_id
          : typeof part.sessionID === "string"
            ? part.sessionID
            : typeof record.id === "string" && type === "session"
              ? record.id
              : undefined;

    if (reportedSession) {
      if (!this.sessionId && !this.targetSessionId) {
        this.sessionId = reportedSession;
        this.targetSessionId = reportedSession;
      }
      // Non-target session events must not affect the current run.
      if (this.targetSessionId && reportedSession !== this.targetSessionId) {
        return [];
      }
    }
    const session = reportedSession ?? this.sessionId ?? this.targetSessionId;

    if (type === "error") {
      const text =
        typeof record.text === "string"
          ? record.text
          : typeof errData.message === "string"
            ? errData.message
            : typeof record.message === "string"
              ? record.message
              : typeof err.name === "string"
                ? err.name
                : "MiMo 运行错误";
      this.errorText = text;
      this.failed = true;
      return [
        this.makeEvent("state", { status: "failed", text }, session),
        this.makeEvent("activity", { kind: "error", text }, session),
      ];
    }

    if (type === "text" || type === "message") {
      const text =
        typeof part.text === "string"
          ? part.text
          : typeof record.text === "string"
            ? record.text
            : typeof record.content === "string"
              ? record.content
              : typeof record.message === "string"
                ? record.message
                : "";
      if (!text) return [];
      return [
        this.makeEvent("activity", { kind: "message", text }, session),
      ];
    }

    if (type === "tool_use" || type === "step_start") {
      const tool =
        typeof part.tool === "string"
          ? part.tool
          : typeof record.tool === "string"
            ? record.tool
            : typeof record.name === "string"
              ? record.name
              : type === "step_start"
                ? "step"
                : "tool";
      return [
        this.makeEvent(
          "activity",
          {
            kind: type === "step_start" ? "event" : "tool",
            tool,
            title: typeof record.title === "string" ? record.title : undefined,
          },
          session,
        ),
      ];
    }

    if (type === "step_finish") {
      // step_finish marks step boundary / stop reason, not necessarily task completion.
      const reason = typeof part.reason === "string" ? part.reason : undefined;
      return [
        this.makeEvent(
          "state",
          { status: reason === "stop" ? "stopped" : "step_finished", reason },
          session,
        ),
      ];
    }

    if (type === "result") {
      this.finished = true;
      return [this.makeEvent("state", { status: "completed" }, session)];
    }

    if (type === "session") {
      return [this.makeEvent("discovered", record, session)];
    }

    return [];
  }
}
