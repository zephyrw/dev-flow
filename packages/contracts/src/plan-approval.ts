import { z } from "zod";
import { Id } from "./base.js";

export const ApprovedExecutionInstructionsSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    text: z.string(),
    text_hash: z.string().min(1),
    scope: z.literal("approved-plan").default("approved-plan"),
  })
  .strict();
export type ApprovedExecutionInstructions = z.infer<
  typeof ApprovedExecutionInstructionsSchema
>;

export const PlanApprovalRecordV2Schema = z
  .object({
    schema_version: z.literal(2).default(2),
    workflow_id: Id,
    plan_revision: z.number().int().positive(),
    revision: z.number().int().positive(),
    plan_hash: z.string().min(1),
    document_hash: z.string().nullable().optional(),
    request_id: z.string().min(1),
    approved_at: z.string().min(1),
    proof: z.string().optional(),
    execution_instructions: ApprovedExecutionInstructionsSchema,
  })
  .strict();
export type PlanApprovalRecordV2 = z.infer<typeof PlanApprovalRecordV2Schema>;

export const RunApprovalRefSchema = z
  .object({
    approval_id: z.string().min(1),
    plan_revision: z.number().int().positive(),
    plan_hash: z.string().min(1),
    instructions_hash: z.string().min(1),
  })
  .strict();
export type RunApprovalRef = z.infer<typeof RunApprovalRefSchema>;

export const PlanApprovalBindingV2Schema = z
  .object({
    workflow_id: Id,
    action: z.literal("approve"),
    version: z.number().int().nonnegative(),
    plan_revision: z.number().int().positive(),
    plan_hash: z.string().min(1),
    snapshot_id: z.string().nullable().optional(),
    environment_revision: z.number().int().nonnegative().optional(),
    extra: z
      .object({
        execution_instructions_hash: z.string().optional(),
      })
      .optional(),
  })
  .strict();
export type PlanApprovalBindingV2 = z.infer<typeof PlanApprovalBindingV2Schema>;

export const PlanApprovalRequestV2Schema = z
  .object({
    schema_version: z.union([z.literal(1), z.literal(2)]).default(2),
    request_id: z.string().min(1),
    binding: PlanApprovalBindingV2Schema,
    execution_instructions: z
      .object({
        text: z.string().max(20000),
        scope: z.literal("approved-plan").default("approved-plan"),
      })
      .optional(),
  })
  .strict();
export type PlanApprovalRequestV2 = z.infer<typeof PlanApprovalRequestV2Schema>;

export const PlanApprovalResponseSchema = z
  .object({
    workflow_id: Id,
    approval: PlanApprovalRecordV2Schema,
    request_id: z.string().min(1),
    transitioned: z.boolean(),
  })
  .strict();
export type PlanApprovalResponse = z.infer<typeof PlanApprovalResponseSchema>;

export interface ExecutionInstructionPayload {
  approval_id: string;
  plan_revision: number;
  plan_hash: string;
  text: string;
  text_hash: string;
  scope: "approved-plan";
}

export function normalizeInstructionsText(rawText?: string | null): string {
  if (rawText === undefined || rawText === null) return "";
  const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized.length > 20000) {
    throw new Error(`执行指令文本过长: 最大允许 20000 字符, 当前 ${normalized.length} 字符`);
  }
  return normalized;
}

