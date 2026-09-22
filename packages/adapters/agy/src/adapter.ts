import { dirname } from "node:path";
import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  ProbeRequest,
  CapabilityReport,
} from "../../sdk/src/interface.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import {
  AGY_PAUSE_ATTRIBUTION,
  AgyConversationDecoder,
  AgyConversationSource,
  agySubagentCapabilities,
} from "./conversation-source.js";

export class AgyNativeCliAdapter extends BaseNativeAgentAdapter {
  subagents: SubagentCapabilities;
  private decoders = new Map<string, AgyConversationDecoder>();
  private sources = new Map<string, AgyConversationSource>();

  constructor(options?: { cliVersion?: string }) {
    super("agy", "agy", [
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
    this.subagents = agySubagentCapabilities(options?.cliVersion);
  }
  getVersionArgs() {
    return ["--version"];
  }
  getProductFingerprint() {
    return "agy|antigravity";
  }
  async probe(input: ProbeRequest): Promise<CapabilityReport> {
    const report = await super.probe(input);
    this.subagents = agySubagentCapabilities(report.version);
    return report;
  }
  bindConversationFile(filePath: string, rootNativeId: string) {
    const source = new AgyConversationSource({
      profileRoot: dirname(filePath),
      rootNativeId,
      streamPath: filePath,
      cliVersion: this.subagents.cli_version,
    });
    this.sources.set(source.sourceId, source);
  }
  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    const key = chunk.runId ?? "unbound";
    let decoder = this.decoders.get(key);
    if (!decoder) {
      decoder = new AgyConversationDecoder();
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
      reason: AGY_PAUSE_ATTRIBUTION,
    };
  }
}
