import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  PreparedInvocation,
  RunContext,
} from "../../sdk/src/interface.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import {
  applyQoderConstrainedDelegation,
  QoderConversationDecoder,
  QoderConversationSource,
  qoderSubagentCapabilities,
} from "./conversation-source.js";

export class QoderNativeAdapter extends BaseNativeAgentAdapter {
  subagents: SubagentCapabilities = qoderSubagentCapabilities();
  private decoders = new Map<string, QoderConversationDecoder>();
  private sources = new Map<string, QoderConversationSource>();

  constructor() {
    super("qoder", "qoder", [
      ...(process.env.LOCALAPPDATA
        ? [
            process.env.LOCALAPPDATA + "/agy/bin",
            process.env.LOCALAPPDATA + "/cursor-agent",
          ]
        : []),
      ...(process.env.APPDATA ? [process.env.APPDATA + "/npm"] : []),
      ...(process.env.HOME ? [process.env.HOME + "/.local/bin"] : []),
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ]);
  }
  getVersionArgs() {
    return ["--version"];
  }
  getProductFingerprint() {
    return "qoder";
  }
  buildInvocation(input: RunContext, executable: string): PreparedInvocation {
    return applyQoderConstrainedDelegation(
      super.buildInvocation(input, executable),
      input.purpose,
    );
  }
  bindConversationFile(filePath: string, rootNativeId: string) {
    const source = new QoderConversationSource({ filePath, rootNativeId });
    this.sources.set(source.sourceId, source);
  }
  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    const key = chunk.runId ?? "unbound";
    let decoder = this.decoders.get(key);
    if (!decoder) {
      decoder = new QoderConversationDecoder(`qoder:stream:${key}`);
      this.decoders.set(key, decoder);
    }
    return decoder.push(chunk);
  }
  async readConversationEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const source = this.sources.get(cursor.source_id);
    if (!source) return [];
    return source.readEvents(cursor);
  }
  async stopConversation(
    target: ConversationStopTarget,
  ): Promise<ConversationStopResult> {
    return {
      conversation_id: target.conversation_id,
      confirmation: "owned_process_tree",
      reason: "Qoder 无独立原生会话 abort，仅能停止本次受管进程树",
    };
  }
}
