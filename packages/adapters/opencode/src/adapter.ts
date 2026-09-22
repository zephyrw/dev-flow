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
import { OpenCodeConversationSource } from "./conversation-source.js";

export class OpenCodeNativeAdapter extends BaseNativeAgentAdapter {
  subagents?: SubagentCapabilities;
  private conversationSource?: OpenCodeConversationSource;

  constructor() {
    super("opencode", "opencode", [
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
    return "opencode";
  }
  async prepare(input: RunContext): Promise<PreparedInvocation> {
    const invocation = await super.prepare(input);
    this.conversationSource = OpenCodeConversationSource.fromPrepared(
      input,
      invocation,
    );
    this.subagents = this.conversationSource.capabilities();
    return invocation;
  }
  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    return this.conversationSource?.decodeChunk(chunk) ?? [];
  }
  async readConversationEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    return this.conversationSource?.readEvents(cursor) ?? [];
  }
  async stopConversation(
    target: ConversationStopTarget,
  ): Promise<ConversationStopResult> {
    if (!this.conversationSource)
      return {
        conversation_id: target.conversation_id,
        confirmation: "unconfirmed",
        reason: "未绑定当前 OpenCode 实例",
      };
    return this.conversationSource.abort(target);
  }
}
