import { z } from "zod";
import { Id } from "./base.js";
import { FrozenInvocationSchema } from "./model-routing.js";

// 恢复决策类型
export const RecoveryDecisionSchema = z.enum([
  "exact_resume",
  "recreate_root",
  "preserve_completed",
  "manual_required",
  "superseded",
]);
export type RecoveryDecision = z.infer<typeof RecoveryDecisionSchema>;

// 恢复项生命周期进度状态
export const RecoveryProgressStateSchema = z.enum([
  "preserved",
  "resume_pending",
  "recreate_pending",
  "waiting_dependency",
  "waiting_access",
  "delivery_pending",
  "delivery_unknown",
  "running_observed",
  "manual_required",
  "superseded",
  "completed",
]);
export type RecoveryProgressState = z.infer<typeof RecoveryProgressStateSchema>;

// 执行时间预算 (AGF-D07)
export const ExecutionBudgetSchema = z.object({
  execution_budget_ms: z.number().int().nonnegative(),
  consumed_ms: z.number().int().nonnegative().default(0),
  remaining_ms: z.number().int().nonnegative(),
  frozen_at: z.string().min(1),
});
export type ExecutionBudget = z.infer<typeof ExecutionBudgetSchema>;

// 不可变源检查点 (AGF-D07 Source Checkpoint)
export const AgySourceCheckpointSchema = z.object({
  checkpoint_id: Id,
  workflow_id: Id,
  source_run_id: Id,
  source_account_id: Id,
  source_auth_epoch: z.number().int().positive(),
  frozen_invocation: FrozenInvocationSchema,
  profile_id: z.string().optional(),
  purpose: z.string().optional(),
  routing_role: z.string().optional(),
  review_phase: z.string().optional(),
  logical_round: z.number().int().nonnegative().default(0),
  assignment_id: z.string().optional(),
  repair_batch_id: z.string().optional(),
  original_conversation_id: z.string().optional(),
  parent_id: z.string().optional(),
  child_ids: z.array(z.string()).default([]),
  control_generation: z.number().int().nonnegative().default(0),
  plan_revision: z.number().int().nonnegative().default(1),
  policy_revision: z.number().int().nonnegative().default(1),
  workspace_checkpoint_ref: z.string().optional(),
  recreation_policy: z.enum(["exact_only", "recreate_after_confirmed_unavailable"]).default("exact_only"),
  budget: ExecutionBudgetSchema,
  created_at: z.string().min(1),
});
export type AgySourceCheckpoint = z.infer<typeof AgySourceCheckpointSchema>;

// 不可变目标恢复清单 (AGF-D07 Recovery Manifest)
export const AgyRecoveryManifestSchema = z.object({
  manifest_id: z.string().min(1), // 格式: operation_id:source_run_id:logical_work_id
  operation_id: Id,
  source_checkpoint_id: Id,
  source_run_id: Id,
  logical_work_id: z.string().min(1),
  target_account_id: Id,
  target_auth_epoch: z.number().int().positive(),
  recreation_policy: z.enum(["exact_only", "recreate_after_confirmed_unavailable"]),
  created_at: z.string().min(1),
});
export type AgyRecoveryManifest = z.infer<typeof AgyRecoveryManifestSchema>;

// 恢复进展 (AGF-D07 Recovery Progress)
export const AgyRecoveryProgressSchema = z.object({
  recovery_id: Id,
  manifest_id: z.string().min(1),
  operation_id: Id,
  source_run_id: Id,
  revision: z.number().int().positive().default(1),
  decision: RecoveryDecisionSchema,
  target_run_id: Id.optional(),
  delivery_id: z.string().optional(),
  state: RecoveryProgressStateSchema,
  last_native_cursor: z.string().optional(),
  reason: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
});
export type AgyRecoveryProgress = z.infer<typeof AgyRecoveryProgressSchema>;

// 显式会话续接参数 (AGF-D09)
export const AccountRecoveryContinuationSchema = z.object({
  recovery_id: Id,
  target_run_id: Id.optional(),
  manifest_revision: z.number().int().positive().default(1),
  decision: RecoveryDecisionSchema,
  original_conversation_id: z.string().optional(),
  source_account_id: Id,
  source_auth_epoch: z.number().int().positive(),
  target_account_id: Id,
  target_auth_epoch: z.number().int().positive(),
  frozen_invocation_digest: z.string().min(1),
  workspace_ref: z.string().optional(),
  permission_scope: z.string().optional(),
  remaining_budget_ms: z.number().int().nonnegative(),
});
export type AccountRecoveryContinuation = z.infer<typeof AccountRecoveryContinuationSchema>;

// Stored with an aside session; main tasks store the same payload as pending_model_retry.
export const AccountRecoveryRetrySchema = z.object({
  retry_run_id: Id,
  logical_round_id: Id,
  account_recovery: z.object({
    recovery_id: Id.optional(),
    frozen_invocation: FrozenInvocationSchema,
    continuation: AccountRecoveryContinuationSchema.optional(),
    remaining_budget_ms: z.number().int().nonnegative().optional(),
  }),
});
export type AccountRecoveryRetry = z.infer<typeof AccountRecoveryRetrySchema>;
