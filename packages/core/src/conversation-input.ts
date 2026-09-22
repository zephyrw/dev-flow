import {
  CONVERSATION_FILE_LIMITS,
  DEFAULT_ATTACHMENT_PROMPT,
  type ConversationInputMode,
  type ConversationRuntimeDisplay,
  type ConversationSendState,
} from "../../contracts/src/conversation-input.js";

export const ASIDE_COMMANDS = ["btw", "side"] as const;
export type AsideCommand = (typeof ASIDE_COMMANDS)[number];

export interface ParsedConversationInput {
  mode: ConversationInputMode;
  command?: AsideCommand;
  text: string;
  original_text: string;
  empty_question: boolean;
  escaped: boolean;
}

const ASIDE_COMMAND_SET = new Set<string>(ASIDE_COMMANDS);

function isCodeFenceStart(text: string): boolean {
  return text.startsWith("```") || text.startsWith("~~~");
}

function readLeadingCommand(
  text: string,
): { command: string; body: string } | undefined {
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([A-Za-z]+)(\s+|$)/.exec(text);
  if (!match?.[1]) return undefined;
  const command = match[1].toLowerCase();
  if (!ASIDE_COMMAND_SET.has(command)) return undefined;
  return { command, body: text.slice(match[0].length) };
}

export function parseConversationInput(text: string): ParsedConversationInput {
  const original_text = text;
  const trimmed = text.trimStart();
  if (!trimmed || isCodeFenceStart(trimmed)) {
    return {
      mode: "formal",
      text,
      original_text,
      empty_question: false,
      escaped: false,
    };
  }
  if (trimmed.startsWith("\\/")) {
    const unescaped = trimmed.slice(1);
    const escapedCommand = readLeadingCommand(unescaped);
    if (escapedCommand) {
      return {
        mode: "formal",
        text: unescaped,
        original_text,
        empty_question: false,
        escaped: true,
      };
    }
  }
  const aside = readLeadingCommand(trimmed);
  if (!aside) {
    return {
      mode: "formal",
      text,
      original_text,
      empty_question: false,
      escaped: false,
    };
  }
  const body = aside.body;
  return {
    mode: "aside",
    command: aside.command as AsideCommand,
    text: body,
    original_text,
    empty_question: body.trim().length === 0,
    escaped: false,
  };
}

export function conversationCommandSuggestions(text: string): AsideCommand[] {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return [];
  if (trimmed.startsWith("\\/")) return [];
  const token = trimmed.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  if (!token) return [...ASIDE_COMMANDS];
  return ASIDE_COMMANDS.filter((command) => command.startsWith(token));
}

export function validateClientConversationMode(
  text: string,
  clientMode?: ConversationInputMode,
): ParsedConversationInput {
  const parsed = parseConversationInput(text);
  if (clientMode && clientMode !== parsed.mode) {
    return parsed;
  }
  return parsed;
}

interface RuntimeDisplayInput {
  actual_model?: string;
  requested_model?: string;
  actual_effort?: string;
  requested_effort?: string;
  effort?: string;
  supports_effort?: boolean;
}

function displayValue(
  actual: string | undefined,
  requested: string | undefined,
  missing: "unreported" | "not_applicable",
  requestedSuffix: string,
): { label: string; source: ConversationRuntimeDisplay["model_source"] } {
  if (actual?.trim()) return { label: actual.trim(), source: "actual" };
  if (requested?.trim())
    return { label: `${requested.trim()}${requestedSuffix}`, source: "requested" };
  if (missing === "not_applicable")
    return { label: "不适用", source: "not_applicable" };
  return { label: "未报告", source: "unreported" };
}

export function resolveConversationRuntimeDisplay(
  input: RuntimeDisplayInput,
): ConversationRuntimeDisplay {
  const model = displayValue(
    input.actual_model,
    input.requested_model,
    "unreported",
    "（请求）",
  );
  const effortCapable = input.supports_effort !== false;
  const actualEffort = input.actual_effort ?? input.effort;
  const effort = effortCapable
    ? displayValue(
        actualEffort,
        input.requested_effort,
        "unreported",
        "（请求）",
      )
    : { label: "思考强度未报告", source: "not_applicable" as const };
  if (!effortCapable) {
    return {
      model_label: model.label === "未报告" ? "工具默认，实际未报告" : model.label,
      effort_label: "不适用",
      model_source: model.source,
      effort_source: "not_applicable",
    };
  }
  return {
    model_label:
      model.label === "未报告" ? "工具默认，实际未报告" : model.label,
    effort_label:
      effort.source === "unreported" ? "思考强度未报告" : effort.label,
    model_source: model.source,
    effort_source: effort.source,
  };
}

interface AttachmentSendInput {
  status: string;
  supported: boolean;
}

export function evaluateConversationSend(params: {
  text: string;
  attachments?: AttachmentSendInput[];
  parsed?: ParsedConversationInput;
}): ConversationSendState {
  const attachments = params.attachments ?? [];
  const parsed = params.parsed ?? parseConversationInput(params.text);
  const ready = attachments.filter((item) => item.status === "ready");
  const blocked = attachments.find(
    (item) =>
      item.status === "uploading" ||
      item.status === "pending" ||
      item.status === "failed" ||
      !item.supported,
  );
  if (blocked) {
    if (!blocked.supported)
      return { can_send: false, reason: "当前工具无法读取此附件类型" };
    if (blocked.status === "failed")
      return { can_send: false, reason: "附件上传失败，请重试或移除" };
    return { can_send: false, reason: "附件仍在上传中" };
  }
  if (attachments.length > CONVERSATION_FILE_LIMITS.maxFilesPerMessage)
    return { can_send: false, reason: "每条消息最多 10 个附件" };
  if (parsed.mode === "aside") {
    if (parsed.empty_question)
      return { can_send: false, reason: "请输入临时问题" };
    return { can_send: true };
  }
  if (parsed.text.trim()) return { can_send: true };
  if (ready.length > 0)
    return { can_send: true, default_text: DEFAULT_ATTACHMENT_PROMPT };
  return { can_send: false, reason: "请输入内容或添加附件" };
}
