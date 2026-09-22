import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  PreparedInputAttachments,
} from "../../sdk/src/interface.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import type { ResolvedInputAttachment } from "../../../contracts/src/conversation-input.js";
import {
  CursorConversationDecoder,
  CursorConversationSource,
  cursorSubagentCapabilities,
  prepareCursorInputAttachments,
} from "./conversation-source.js";

export class CursorAgentNativeAdapter extends BaseNativeAgentAdapter {
  subagents: SubagentCapabilities = cursorSubagentCapabilities();
  private decoders = new Map<string, CursorConversationDecoder>();
  private sources = new Map<string, CursorConversationSource>();

  constructor() {
    super("cursor-agent", "agent", [
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
    return "cursor|agent";
  }
  bindConversationFile(filePath: string, rootNativeId: string) {
    const source = new CursorConversationSource({ filePath, rootNativeId });
    this.sources.set(source.sourceId, source);
  }
  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    const key = chunk.runId ?? "unbound";
    let decoder = this.decoders.get(key);
    if (!decoder) {
      decoder = new CursorConversationDecoder(`cursor-agent:stream:${key}`);
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
  prepareInputAttachments(
    attachments: ResolvedInputAttachment[],
  ): Promise<PreparedInputAttachments> {
    return prepareCursorInputAttachments(attachments);
  }
  async stopConversation(
    target: ConversationStopTarget,
  ): Promise<ConversationStopResult> {
    return {
      conversation_id: target.conversation_id,
      confirmation: "owned_process_tree",
      reason: "cursor-agent 无独立原生会话 abort，仅能停止本次受管进程树",
    };
  }
}
