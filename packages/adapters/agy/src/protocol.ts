import { StringDecoder } from "node:string_decoder";
import { FlowError } from "../../../contracts/src/index.js";
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(
    private emit: (event: Record<string, unknown>) => void,
    private limit = 4 * 1024 * 1024,
  ) {}
  push(chunk: Buffer | string) {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drain(false);
  }
  finish() {
    this.buffer += this.decoder.end();
    this.drain(true);
  }
  private drain(final: boolean) {
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, "");
      this.buffer = this.buffer.slice(i + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.buffer) > this.limit)
      throw new FlowError("PROTOCOL_OVERSIZE", "流式事件超过限制");
    if (final && this.buffer.trim()) {
      this.line(this.buffer);
      this.buffer = "";
    }
  }
  private line(line: string) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.limit)
      throw new FlowError("PROTOCOL_OVERSIZE", "流式事件超过限制");
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new FlowError("PROTOCOL_INVALID", "无效 JSONL 事件");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new FlowError("PROTOCOL_INVALID", "事件必须是对象");
    this.emit(parsed as Record<string, unknown>);
  }
}
export class AgyProtocol {
  conversation?: string;
  result?: Record<string, unknown>;
  initialized = false;
  constructor(
    private expectedModel: string,
    private expectedConversation?: string,
  ) {}
  accept(event: Record<string, unknown>) {
    if (event.event === "init") {
      if (this.initialized)
        throw new FlowError("PROTOCOL_DUPLICATE_INIT", "重复 init");
      this.initialized = true;
      const init = event.init as Record<string, unknown>;
      if (init?.model !== this.expectedModel)
        throw new FlowError("MODEL_MISMATCH", "实际模型与指定模型不符或未报告");
      this.conversation = String(event.conversation_id ?? "");
      if (
        !this.conversation ||
        (this.expectedConversation &&
          this.conversation !== this.expectedConversation)
      )
        throw new FlowError("CONVERSATION_MISMATCH", "实际会话不一致");
    } else if (event.event === "step_update") {
      const step = event.step_update as Record<string, unknown>;
      if (
        !this.initialized ||
        this.result ||
        step?.conversation_id !== this.conversation
      )
        throw new FlowError(
          "CONVERSATION_MISMATCH",
          "过程事件不属于当前有效会话",
        );
    } else if (event.event === "result") {
      if (this.result)
        throw new FlowError("PROTOCOL_DUPLICATE_RESULT", "重复 result");
      this.result = event.result as Record<string, unknown>;
      if (this.result?.conversation_id !== this.conversation)
        throw new FlowError("CONVERSATION_MISMATCH", "结束会话不一致");
    }
  }
  success(exit: number | null) {
    return (
      this.initialized &&
      !!this.result &&
      this.result.status === "SUCCESS" &&
      !(
        Array.isArray(this.result.denied_actions) &&
        this.result.denied_actions.length
      ) &&
      exit === 0
    );
  }
}
