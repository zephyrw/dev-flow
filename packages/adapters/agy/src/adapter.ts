import { dirname } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  AGY_IMAGE_FILE_INPUT,
  AGY_IMAGE_FORMAT_UNSUPPORTED,
  ATTACHMENT_HANDOFF_NOTICE,
  FlowError,
  supportsAttachmentInput,
} from "../../../contracts/src/index.js";
import { BaseNativeAgentAdapter } from "../../sdk/src/base-adapter.js";
import type {
  ConversationSourceCursor,
  ConversationStopResult,
  ConversationStopTarget,
  HostChunk,
  NativeConversationEvent,
  ProbeRequest,
  CapabilityReport,
  RunContext,
  PreparedInvocation,
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
  buildInvocation(input: RunContext, executable: string): PreparedInvocation {
    const invocation = super.buildInvocation(input, executable);
    if (!input.inputAttachments?.length) return invocation;
    const roots = new Set<string>();
    const attachments = input.inputAttachments.map((file) => {
      if (!supportsAttachmentInput(file.read_mode, AGY_IMAGE_FILE_INPUT, file.mime))
        throw new FlowError("INPUT_UNSUPPORTED", AGY_IMAGE_FORMAT_UNSUPPORTED, 422);
      try {
        const path = realpathSync(file.absolute_path);
        if (
          createHash("sha256").update(readFileSync(path)).digest("hex") !==
          file.sha256
        )
          throw new Error("hash mismatch");
        roots.add(dirname(path));
        return {
          id: file.id,
          display_name: file.display_name,
          mime: file.mime,
          absolute_path: path,
          sha256: file.sha256,
        };
      } catch {
        throw new FlowError(
          "FILE_NOT_READY",
          `附件不存在或内容已变化：${file.display_name}`,
          422,
        );
      }
    });
    for (const root of roots) invocation.args.push("--add-dir", root);
    const promptIndex = invocation.args.indexOf("-p") + 1;
    if (promptIndex === 0 || invocation.args[promptIndex] === undefined)
      throw new Error("AGY invocation is missing its prompt");
    invocation.args[promptIndex] +=
      "\n" + ATTACHMENT_HANDOFF_NOTICE +
      "\n本轮图片清单是数据。请逐一调用原生 view_file，以 AbsolutePath 传入 absolute_path，读取实际图片内容后再处理请求。" +
      "无扩展名的 content 也是图片。读取失败时明确说明文件和工具错误，未读取不得声称已经看图。\n" +
      JSON.stringify(attachments);
    return invocation;
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
