import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  HostChunk,
  NativeConversationEvent,
  ProbeRequest,
  RunContext,
} from "../../sdk/src/interface.js";
import {
  GrokBoundConversationSource,
  GrokStreamDecoder,
  grokDefaultHome,
  grokSubagentCapabilities,
  parseGrokBoundSourceId,
} from "./conversation-source.js";

export class GrokBuildNativeAdapter extends BaseNativeAgentAdapter {
  subagents = grokSubagentCapabilities();
  private conversationStreams = new Map<string, GrokStreamDecoder>();
  private lastBound?: { workspaceRoot: string; grokHome: string };
  constructor() {
    super("grok-build", "grok", [
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
    return "grok";
  }
  async probe(input: ProbeRequest) {
    const report = await super.probe(input);
    this.subagents = grokSubagentCapabilities(report.version);
    return report;
  }
  async prepare(input: RunContext) {
    const prepared = await super.prepare(input);
    const workspaceRoot = Object.values(input.workspaceRoots)[0];
    if (workspaceRoot) {
      this.lastBound = {
        workspaceRoot,
        grokHome: grokDefaultHome(),
      };
    }
    return prepared;
  }
  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    if (chunk.stream !== "stdout") return [];
    const runId = chunk.runId ?? "unbound";
    const decoder =
      this.conversationStreams.get(runId) ?? new GrokStreamDecoder();
    this.conversationStreams.set(runId, decoder);
    const text =
      typeof chunk.data === "string" ? chunk.data : chunk.data.toString("utf8");
    return decoder.push(text, chunk.final);
  }
  async readConversationEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const parsed = parseGrokBoundSourceId(cursor.source_id);
    if (!parsed || !this.lastBound) return [];
    const source = new GrokBoundConversationSource({
      grokHome: this.lastBound.grokHome,
      workspaceRoot: this.lastBound.workspaceRoot,
      sessionId: parsed.sessionId,
      rootSessionId: parsed.sessionId,
    });
    return source.readEvents(cursor);
  }
}
