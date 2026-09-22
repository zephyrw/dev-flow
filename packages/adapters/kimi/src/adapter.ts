import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  PreparedInputAttachments,
  ProbeRequest,
  RunContext,
} from "../../sdk/src/interface.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import type { ResolvedInputAttachment } from "../../../contracts/src/conversation-input.js";
import {
  KimiBoundConversationSource,
  KimiStreamDecoder,
  isKimiSessionId,
  kimiBoundSourceId,
  kimiDefaultHome,
  kimiSessionDirectory,
  kimiStreamSourceId,
  kimiSubagentCapabilities,
  parseKimiBoundSourceId,
  prepareKimiInputAttachments,
} from "./conversation-source.js";

export class KimiCodeNativeAdapter extends BaseNativeAgentAdapter {
  subagents: SubagentCapabilities = kimiSubagentCapabilities();
  private conversationStreams = new Map<string, KimiStreamDecoder>();
  private sources = new Map<string, KimiBoundConversationSource>();
  private lastBound?: { homeDir: string; workspaceRoot: string };

  constructor() {
    super("kimi-code", "kimi", [
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
    return "kimi";
  }

  async probe(input: ProbeRequest) {
    const report = await super.probe(input);
    report.capabilities.readOnlySession = false; // CW-D09: 当前已知无只读方案
    this.subagents = kimiSubagentCapabilities({ cli_version: report.version });
    return report;
  }

  async prepare(input: RunContext) {
    const prepared = await super.prepare(input);
    const workspaceRoot = Object.values(input.workspaceRoots)[0];
    if (workspaceRoot) {
      this.lastBound = {
        homeDir: kimiDefaultHome(),
        workspaceRoot,
      };
    }
    const sessionId = input.conversationId;
    if (workspaceRoot && sessionId && isKimiSessionId(sessionId)) {
      this.bindBoundSession(
        kimiSessionDirectory(kimiDefaultHome(), workspaceRoot, sessionId),
        sessionId,
      );
    }
    return prepared;
  }

  bindBoundSession(sessionDir: string, sessionId: string) {
    const source = new KimiBoundConversationSource({
      sessionDir,
      sessionId,
      rootNativeId: sessionId,
    });
    this.sources.set(source.sourceId, source);
    this.sources.set(kimiBoundSourceId("wire", sessionId, "main"), source);
  }

  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    const runId = chunk.runId ?? "unbound";
    const decoder =
      this.conversationStreams.get(runId) ??
      new KimiStreamDecoder(kimiStreamSourceId(runId));
    this.conversationStreams.set(runId, decoder);
    return decoder.pushChunk(chunk);
  }

  async readConversationEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    const parsed = parseKimiBoundSourceId(cursor.source_id);
    if (!parsed) return [];
    const source =
      this.sources.get(kimiBoundSourceId("session", parsed.sessionId)) ??
      this.sourceFromLastBound(parsed.sessionId);
    if (!source) return [];
    return source.readEvents(cursor);
  }

  prepareInputAttachments(
    attachments: ResolvedInputAttachment[],
  ): Promise<PreparedInputAttachments> {
    return prepareKimiInputAttachments(attachments);
  }

  async stopConversation(
    target: ConversationStopTarget,
  ): Promise<ConversationStopResult> {
    return {
      conversation_id: target.conversation_id,
      confirmation: "owned_process_tree",
      reason:
        "kimi-code print 模式子代理与主会话同进程，无独立 abort；仅能停止本次受管进程树。agent_id 不能当作 --session 使用",
    };
  }

  private sourceFromLastBound(sessionId: string): KimiBoundConversationSource | undefined {
    if (!this.lastBound) return undefined;
    const source = new KimiBoundConversationSource({
      sessionDir: kimiSessionDirectory(
        this.lastBound.homeDir,
        this.lastBound.workspaceRoot,
        sessionId,
      ),
      sessionId,
      rootNativeId: sessionId,
    });
    this.sources.set(source.sourceId, source);
    return source;
  }
}
