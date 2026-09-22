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
  CodexConversationDecoder,
  CodexConversationSource,
  collectInstalledCodexCliVersion,
  codexSubagentCapabilities,
} from "./conversation-source.js";

export class CodexNativeAdapter extends BaseNativeAgentAdapter {
  subagents: SubagentCapabilities;
  private decoders = new Map<string, CodexConversationDecoder>();
  private sources = new Map<string, CodexConversationSource>();

  constructor(options?: { cliVersion?: string }) {
    super("codex", "codex", [
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
    const version = options?.cliVersion ?? collectInstalledCodexCliVersion();
    this.subagents = codexSubagentCapabilities(version);
  }
  getVersionArgs() {
    return ["--version"];
  }
  getProductFingerprint() {
    return "codex";
  }
  async probe(input: ProbeRequest): Promise<CapabilityReport> {
    const report = await super.probe(input);
    this.subagents = codexSubagentCapabilities(report.version);
    return report;
  }
  bindConversationFile(
    filePath: string,
    rootNativeId: string,
    sessionNativeId?: string,
    parentNativeId?: string,
  ) {
    const source = new CodexConversationSource(
      { filePath, rootNativeId, sessionNativeId, parentNativeId },
      this.subagents.cli_version,
    );
    this.sources.set(source.sourceId, source);
  }
  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    const key = chunk.runId ?? "unbound";
    let decoder = this.decoders.get(key);
    if (!decoder) {
      decoder = new CodexConversationDecoder(`codex:stream:${key}`);
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
      reason:
        "仅能停止本次受管 exec 进程树；不能把 root PID 退出当成独立线程已退出，app-server 不用于控制 exec 外部进程",
    };
  }
}
