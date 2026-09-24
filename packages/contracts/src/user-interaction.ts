import { z } from "zod";

export const UserInteractionKindSchema = z.enum(["action_required", "question"]);
export type UserInteractionKind = z.infer<typeof UserInteractionKindSchema>;

const NonEmptyTrimmedString = (min = 1, max = 4000) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= min, { message: "内容不能为空或纯空白" })
    .refine((s) => s.length <= max, { message: `长度不能超过 ${max} 个字符` });

export const UserInteractionChoiceSchema = z
  .object({
    id: NonEmptyTrimmedString(1, 64),
    label: NonEmptyTrimmedString(1, 120),
  })
  .strict();
export type UserInteractionChoice = z.infer<typeof UserInteractionChoiceSchema>;

export const UserInteractionTargetSchema = z
  .object({
    url: z
      .string()
      .max(2048)
      .refine(
        (val) => {
          try {
            const parsed = new URL(val);
            return parsed.protocol === "http:" || parsed.protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "必须是安全的 http 或 https URL" },
      )
      .optional(),
    tab_id: z.number().int().positive().optional(),
    connection_hint: z.string().max(256).optional(),
  })
  .strict();
export type UserInteractionTarget = z.infer<typeof UserInteractionTargetSchema>;

export const UserInteractionInputSchema = z
  .object({
    kind: UserInteractionKindSchema,
    title: NonEmptyTrimmedString(1, 120),
    message: NonEmptyTrimmedString(1, 4000),
    action_label: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 40, { message: "操作标签长度不能超过 40" })
      .optional(),
    question: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 1000, { message: "提问正文长度不能超过 1000" })
      .optional(),
    choices: z
      .array(UserInteractionChoiceSchema)
      .max(8)
      .refine(
        (choices) => {
          const ids = choices.map((c) => c.id);
          return new Set(ids).size === ids.length;
        },
        { message: "选项 ID 必须唯一" },
      )
      .optional(),
    allow_free_text: z.boolean().optional(),
    target: UserInteractionTargetSchema.optional(),
    resume_note: z.string().max(4000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.kind === "question") {
      if (!data.question || data.question.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["question"],
          message: "提问类交互必须包含非空的提问正文 (question)",
        });
      }
      const hasFreeText = data.allow_free_text !== false;
      const hasChoices = Array.isArray(data.choices) && data.choices.length > 0;
      if (!hasFreeText && !hasChoices) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["choices"],
          message: "当禁止自由文本输入时，必须提供至少一个选项供用户选择",
        });
      }
    }
  });
export type UserInteractionInput = z.infer<typeof UserInteractionInputSchema>;

export const UserInteractionStatusSchema = z.enum([
  "pending",
  "answered",
  "cancelled",
  "superseded",
]);
export type UserInteractionStatus = z.infer<typeof UserInteractionStatusSchema>;

export const UserInteractionActionSchema = z.enum(["confirm", "answer", "cancel"]);
export type UserInteractionAction = z.infer<typeof UserInteractionActionSchema>;

export const UserInteractionResponsePayloadSchema = z
  .object({
    request_id: NonEmptyTrimmedString(1, 128),
    action: UserInteractionActionSchema,
    choice_id: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 64, { message: "选项 ID 长度不能超过 64" })
      .optional(),
    answer: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 4000, { message: "回答内容长度不能超过 4000" })
      .optional(),
  })
  .strict();
export type UserInteractionResponsePayload = z.infer<
  typeof UserInteractionResponsePayloadSchema
>;

export const UserInteractionResponseInputSchema = z
  .object({
    request_id: NonEmptyTrimmedString(1, 128),
    source_run_id: NonEmptyTrimmedString(1, 128),
    source_plan_revision: z.number().int().positive().optional(),
    root_conversation_id: z.string().optional(),
    expected_generation: z.number().int().optional(),
    native_session_id: z.string().optional(),
    action: UserInteractionActionSchema,
    choice_id: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 64, { message: "选项 ID 长度不能超过 64" })
      .optional(),
    answer: z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length <= 4000, { message: "回答内容长度不能超过 4000" })
      .optional(),
  })
  .strict();
export type UserInteractionResponseInput = z.infer<
  typeof UserInteractionResponseInputSchema
>;

export interface UserInteractionRecord {
  id: string;
  workflow_id: string;
  source_run_id: string;
  source_plan_revision: number;
  root_conversation_id?: string;
  source_generation?: number;
  native_session_id?: string;
  purpose: string;
  role: string;
  request: UserInteractionInput;
  status: UserInteractionStatus;
  created_at: string;
  responded_at?: string;
  response?: UserInteractionResponsePayload;
}

export interface UserInteractionReceipt {
  id: string;
  workflow_id: string;
  interaction_id: string;
  request_id: string;
  fingerprint: string;
  status: "queued" | "cancelled";
  created_at: string;
  payload: UserInteractionResponsePayload;
}
