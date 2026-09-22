import { StringDecoder } from "node:string_decoder";
import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  HostChunk,
  NativeConversationEvent,
  PreparedInvocation,
  RunContext,
} from "../../sdk/src/interface.js";
import {
  applyClaudeSessionInvocation,
  parentAllowsAgentSpawn,
  prepareClaudeSessionScope,
  claudeSessionDirectory,
  type ClaudeSessionScope,
} from "./scoped-hooks.js";
import {
  ClaudeConversationBinder,
  ClaudeConversationSource,
  claudeSourceId,
  claudeSubagentCapabilities,
  decodeClaudeStreamLine,
} from "./conversation-source.js";

export class ClaudeCodeNativeAdapter extends BaseNativeAgentAdapter {
  subagents = claudeSubagentCapabilities({});
  private scopes = new Map<string, ClaudeSessionScope>();
  private sources = new Map<string, ClaudeConversationSource>();
  private binders = new Map<string, ClaudeConversationBinder>();
  private conversationStreams = new Map<
    string,
    { decoder: StringDecoder; buffer: string }
  >();
  private rootIds = new Map<string, string>();
  private streamSeq = new Map<string, number>();

  constructor() {
    super("claude-code", "claude", [
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
    return "claude";
  }

  buildInvocation(input: RunContext, executable: string): PreparedInvocation {
    const inv = super.buildInvocation(input, executable);
    if (!input.outputPath) return inv;
    const scope = this.scopeFor(input);
    const next = applyClaudeSessionInvocation(inv, scope);
    this.subagents = claudeSubagentCapabilities({
      agents: scope.agents,
      agentSpawnAllowed: parentAllowsAgentSpawn(next.args),
    });
    this.sources.set(
      input.runId,
      new ClaudeConversationSource({
        eventsPath: scope.eventsPath,
        agents: scope.agents,
        agentSpawnAllowed: parentAllowsAgentSpawn(next.args),
      }),
    );
    return next;
  }

  decodeConversation(chunk: HostChunk): NativeConversationEvent[] {
    const scopedId = [...this.scopes.keys()][0];
    const runId = chunk.runId ?? scopedId ?? "unbound";
    const key = runId + ":" + chunk.stream;
    const stream = this.conversationStreams.get(key) ?? {
      decoder: new StringDecoder("utf8"),
      buffer: "",
    };
    this.conversationStreams.set(key, stream);
    stream.buffer +=
      typeof chunk.data === "string"
        ? chunk.data
        : stream.decoder.write(chunk.data);
    if (chunk.final) stream.buffer += stream.decoder.end() + "\n";
    const lines = stream.buffer.split("\n");
    stream.buffer = lines.pop() ?? "";
    const binder =
      this.binders.get(runId) ??
      this.binders.set(runId, new ClaudeConversationBinder()).get(runId)!;
    const sourceId = claudeSourceId("stream", runId);
    const events: NativeConversationEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const seq = (this.streamSeq.get(runId) ?? 0) + 1;
      this.streamSeq.set(runId, seq);
      const decoded = decodeClaudeStreamLine(line, {
        sourceId,
        sourceSeq: String(seq),
        sourceKind: "stream",
        rootNativeId: this.rootIds.get(runId),
        occurredAt: chunk.timestamp,
      });
      for (const event of decoded) {
        if (event.kind === "discovered" && !event.agent_native_id) {
          this.rootIds.set(runId, event.root_native_id);
        }
        const source = this.sources.get(runId);
        const payload = event.payload as { agent_transcript_path?: string };
        if (source && event.agent_native_id && payload?.agent_transcript_path) {
          source.registerTranscript(
            event.agent_native_id,
            payload.agent_transcript_path,
          );
        }
        events.push(event);
      }
    }
    return binder.push(events);
  }

  async readConversationEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]> {
    if (cursor.source_id.includes(":hook:")) {
      const runId = cursor.source_id.slice("claude-code:hook:".length);
      return (await this.sources.get(runId)?.readEvents(cursor)) ?? [];
    }
    if (cursor.source_id.includes(":transcript:")) {
      for (const source of this.sources.values()) {
        const events = await source.readEvents(cursor);
        if (events.length) return events;
      }
    }
    return [];
  }

  private scopeFor(input: RunContext): ClaudeSessionScope {
    const existing = this.scopes.get(input.runId);
    if (existing) return existing;
    const scope = prepareClaudeSessionScope(claudeSessionDirectory(input));
    this.scopes.set(input.runId, scope);
    return scope;
  }
}