import { z } from "zod";

export const UserInteractionKindSchema = z.enum(["action_required", "question"]);
export type UserInteractionKind = z.infer<typeof UserInteractionKindSchema>;

export const UserInteractionChoiceSchema = z
  .object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(120),
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
    title: z.string().min(1).max(120),
    message: z.string().min(1).max(4000),
    action_label: z.string().min(1).max(40).optional(),
    question: z.string().min(1).max(1000).optional(),
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
  .strict();
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
    request_id: z.string().min(1).max(128),
    action: UserInteractionActionSchema,
    choice_id: z.string().max(64).optional(),
    answer: z.string().max(4000).optional(),
  })
  .strict();
export type UserInteractionResponsePayload = z.infer<
  typeof UserInteractionResponsePayloadSchema
>;

export const UserInteractionResponseInputSchema = z
  .object({
    request_id: z.string().min(1).max(128),
    source_run_id: z.string().min(1),
    root_conversation_id: z.string().optional(),
    expected_generation: z.number().int().optional(),
    action: UserInteractionActionSchema,
    choice_id: z.string().max(64).optional(),
    answer: z.string().max(4000).optional(),
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
  purpose: string;
  role: string;
  request: UserInteractionInput;
  status: UserInteractionStatus;
  created_at: string;
  responded_at?: string;
  response?: UserInteractionResponsePayload;
}
