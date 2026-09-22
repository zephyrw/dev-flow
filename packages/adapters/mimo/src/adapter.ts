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
import { MimoConversationSource } from "./conversation-source.js";

export class MimoCodeNativeAdapter extends BaseNativeAgentAdapter {
  private conversationSource?: MimoConversationSource;

  constructor() {
    super("mimo-code", "mimo", [
      ...(process.env.LOCALAPPDATA
        ? [
            process.env.LOCALAPPDATA + "/npm",
            process.env.LOCALAPPDATA + "/Programs/mimo",
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
    return "mimo";
  }

  async prepare(input: RunContext): Promise<PreparedInvocation> {
    const invocation = await super.prepare(input);
    this.conversationSource = MimoConversationSource.fromPrepared(
      input,
      invocation,
    );
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
    if (!this.conversationSource) {
      return {
        conversation_id: target.conversation_id,
        confirmation: "unconfirmed",
        reason: "未绑定当前 MiMo Code 实例",
      };
    }
    return this.conversationSource.abort(target);
  }
}
