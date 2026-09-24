import { createHash } from "node:crypto";
import {
  type UserInteractionInput,
  type UserInteractionTarget,
  type UserInteractionResponseInput,
  UserInteractionInputSchema,
} from "../../contracts/src/user-interaction.js";

/**
 * 敏感凭据脱敏正则：检测常见的 token, secret, password, bearer, key 等
 */
const SENSITIVE_PATTERN =
  /(bearer\s+[a-zA-Z0-9_\-\.]+)|((?:token|secret|password|access_token|refresh_token|api_key|code|auth)[=:]\s*['"]?[a-zA-Z0-9_\-\.]+['"]?)/gi;

export function maskSensitiveText(text: string): string {
  if (!text) return "";
  return text.replace(SENSITIVE_PATTERN, "[REDACTED]");
}

/**
 * F05: 对目标 URL 进行安全净化
 * 必须剥离 username, password, query 参数 (?...) 和 fragment (#...)
 * 仅保留安全协议 (http/https) + host + pathname
 */
export function sanitizeInteractionTarget(
  target?: UserInteractionTarget,
): UserInteractionTarget | undefined {
  if (!target) return undefined;

  let sanitizedUrl: string | undefined = undefined;
  if (target.url) {
    try {
      const parsed = new URL(target.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        sanitizedUrl = parsed.toString();
      }
    } catch {
      sanitizedUrl = undefined;
    }
  }

  const hint = target.connection_hint
    ? maskSensitiveText(target.connection_hint.trim()).slice(0, 256)
    : undefined;

  if (!sanitizedUrl && target.tab_id === undefined && !hint) {
    return undefined;
  }

  return {
    url: sanitizedUrl,
    tab_id: target.tab_id,
    connection_hint: hint,
  };
}

export interface FallbackInteractionContext {
  summary?: string;
  questions?: string[];
  notes?: string;
}

/**
 * F04 / F05 / F06: 安全解析与归一化请求
 * 保留有用摘要、说明与提问，不因损坏附件丢弃整个求助
 */
export function normalizeInteractionInput(
  rawInput?: unknown,
  fallback?: FallbackInteractionContext,
): UserInteractionInput {
  if (rawInput && typeof rawInput === "object") {
    const parsed = UserInteractionInputSchema.safeParse(rawInput);
    if (parsed.success) {
      const data = parsed.data;
      return {
        ...data,
        title: maskSensitiveText(data.title),
        question: data.question ? maskSensitiveText(data.question) : undefined,
        choices: data.choices?.map((choice) => ({
          ...choice,
          label: maskSensitiveText(choice.label),
        })),
        message: maskSensitiveText(data.message),
        resume_note: data.resume_note
          ? maskSensitiveText(data.resume_note)
          : undefined,
        target: sanitizeInteractionTarget(data.target),
      };
    }
    // A malformed optional target/choice must not erase the model's question.
    const raw = rawInput as Record<string, unknown>;
    const safeText = (value: unknown) =>
      typeof value === "string" ? maskSensitiveText(value.trim()) : "";
    const message =
      safeText(raw.message) ||
      fallback?.summary ||
      fallback?.notes ||
      "执行模型需要用户协助";
    const question = safeText(raw.question);
    if (raw.kind === "question" || question) {
      return {
        kind: "question",
        title: (safeText(raw.title) || "请回答执行提问").slice(0, 120),
        message: maskSensitiveText(message).slice(0, 4000),
        question: (question || message).slice(0, 1000),
        allow_free_text: true,
        resume_note: safeText(raw.resume_note).slice(0, 4000) || undefined,
      };
    }
    fallback = {
      ...fallback,
      summary: safeText(raw.message) || fallback?.summary,
      notes: safeText(raw.resume_note) || fallback?.notes,
    };
  }

  // 降级处理：优先使用 questions
  const questions = (fallback?.questions ?? [])
    .map((q) => q.trim())
    .filter(Boolean);
  const summary = fallback?.summary?.trim() || "";
  const notes = fallback?.notes?.trim() || "";
  if (!questions.length && notes && !summary) questions.push(notes);

  if (questions.length > 0) {
    const combinedQuestion =
      questions.length === 1
        ? questions[0] || ""
        : questions.map((q, idx) => `${idx + 1}. ${q}`).join("\n");

    const messageText = summary || notes || "执行模型需要用户协助决策";
    return {
      kind: "question",
      title: "请回答执行提问",
      message: maskSensitiveText(messageText).slice(0, 4000),
      question: maskSensitiveText(combinedQuestion || "请确认决策").slice(
        0,
        1000,
      ),
      allow_free_text: true,
      resume_note: notes ? maskSensitiveText(notes).slice(0, 4000) : undefined,
    };
  }

  // 如果没有具体提问，但有 notes 或 summary，尝试判断是提问还是操作
  const fallbackMessage =
    summary ||
    notes ||
    "执行模型需要用户在界面中完成必要操作，完成后请点击确认继续。";

  return {
    kind: "action_required",
    title: "请完成操作协助",
    message: maskSensitiveText(fallbackMessage).slice(0, 4000),
    action_label: "我已完成，继续",
    resume_note: notes ? maskSensitiveText(notes).slice(0, 4000) : undefined,
  };
}

/**
 * F04: 服务端语义校验
 */
export function validateInteractionResponse(
  request: UserInteractionInput,
  response: {
    action: string;
    choice_id?: string;
    answer?: string;
  },
): { valid: boolean; error?: string } {
  const { action, choice_id, answer } = response;
  const trimmedAnswer = typeof answer === "string" ? answer.trim() : "";
  const trimmedChoiceId = typeof choice_id === "string" ? choice_id.trim() : "";

  if (action === "cancel") {
    return { valid: true };
  }

  if (request.kind === "action_required") {
    if (action !== "confirm") {
      return {
        valid: false,
        error: "操作类交互只接受 'confirm' 或 'cancel' 操作",
      };
    }
    return { valid: true };
  }

  if (request.kind === "question") {
    if (action !== "answer") {
      return {
        valid: false,
        error: "提问类交互只接受 'answer' 或 'cancel' 操作",
      };
    }

    const validChoiceIds = new Set((request.choices ?? []).map((c) => c.id));
    if (trimmedChoiceId && !validChoiceIds.has(trimmedChoiceId)) {
      return {
        valid: false,
        error: `选择的选项 '${trimmedChoiceId}' 不属于当前问题候选列表`,
      };
    }

    if (request.allow_free_text === false) {
      if (!trimmedChoiceId) {
        return {
          valid: false,
          error: "当前问题禁止自由文本输入，必须选择一个有效选项",
        };
      }
      return { valid: true };
    }

    // 允许自由输入时，必须至少有有效 choice 或非空 answer
    if (!trimmedChoiceId && !trimmedAnswer) {
      return {
        valid: false,
        error: "回答内容不能为空，请选择选项或输入文字说明",
      };
    }

    return { valid: true };
  }

  return { valid: false, error: "未知的交互类型" };
}

/**
 * F03: 计算规范化决策指纹，用于幂等冲突校验
 */
export function computeInteractionResponseFingerprint(
  workflowId: string,
  interactionId: string,
  input: UserInteractionResponseInput,
): string {
  const normalized = {
    workflow_id: workflowId,
    interaction_id: interactionId,
    source_run_id: input.source_run_id.trim(),
    action: input.action,
    choice_id: input.choice_id ? input.choice_id.trim() : "",
    answer: input.answer ? input.answer.trim() : "",
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
