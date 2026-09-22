import { z } from "zod";
import nodeCrypto from "node:crypto";
import { Id } from "./base.js";

export const SessionBindingStateSchema = z.enum([
  "reserved",
  "bound",
  "needs_reconcile",
  "unavailable",
  "retired",
]);
export type SessionBindingState = z.infer<typeof SessionBindingStateSchema>;

export const SessionBindingKeySchema = z
  .object({
    workflow_id: Id,
    adapter_id: z.string().min(1),
    host_id: z.string().min(1),
    client_scope_id: z.string().min(1),
    provider_account_scope: z.string().min(1),
    canonical_model_id: z.string().min(1),
    workspace_identity: z.string().min(1),
  })
  .strict();
export type SessionBindingKey = z.infer<typeof SessionBindingKeySchema>;

/**
 * 依据 CW-D00 / §3.1 规范计算统一会话绑定键：
 * 有序字段固定为：workflow_id / adapter_id / host_id / client_scope_id / provider_account_scope / canonical_model_id / workspace_identity
 * 使用版本前缀及固定字段顺序的 JSON 数组序列化后 SHA256 作为键，禁止直接 join('::')
 */
export function computeSessionBindingKey(key: SessionBindingKey): string {
  const payload = JSON.stringify([
    "v1",
    key.workflow_id,
    key.adapter_id,
    key.host_id,
    key.client_scope_id,
    key.provider_account_scope,
    key.canonical_model_id,
    key.workspace_identity,
  ]);
  return nodeCrypto.createHash("sha256").update(payload).digest("hex");
}

export interface SessionOwnerKeyInput {
  adapter_id: string;
  host_id: string;
  client_scope_id: string;
  provider_account_scope: string;
  conversation_id: string;
}

/**
 * 同一个原生根的所有权键：adapter_id / host_id / client_scope_id / provider_account_scope / conversation_id
 * 不含 workflow_id 和模型
 */
export function computeSessionOwnerKey(input: SessionOwnerKeyInput): string {
  const payload = JSON.stringify([
    "owner:v1",
    input.adapter_id,
    input.host_id,
    input.client_scope_id,
    input.provider_account_scope,
    input.conversation_id,
  ]);
  return nodeCrypto.createHash("sha256").update(payload).digest("hex");
}

export const SessionBindingSchema = z
  .object({
    id: Id,
    workflow_id: Id,
    adapter_id: z.string().min(1),
    host_id: z.string().min(1),
    client_scope_id: z.string().min(1),
    provider_account_scope: z.string().min(1),
    canonical_model_id: z.string().min(1),
    workspace_identity: z.string().min(1),
    conversation_id: z.string().optional(),
    owner_key: z.string().optional(),
    native_project_id: z.string().optional(),
    workspace_root: z.string().min(1),
    source_root: z.string().min(1),
    repo_id: z.string().min(1),
    worktree_path: z.string().optional(),
    branch: z.string().optional(),
    revision: z.number().int().positive().default(1),
    generation: z.number().int().positive().default(1),
    state: SessionBindingStateSchema.default("reserved"),
    reconcile_reason: z.string().optional(),
    original_dispatch_id: z.string().optional(),
    first_run_id: z.string().optional(),
    latest_run_id: z.string().optional(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .refine(
    (data) => {
      if (data.state === "bound") {
        return typeof data.conversation_id === "string" && data.conversation_id.trim().length > 0;
      }
      return true;
    },
    { message: "bound 状态必须具有非空 conversation_id", path: ["conversation_id"] },
  );
export type SessionBinding = z.infer<typeof SessionBindingSchema>;

/**
 * 依据 CW2-D00 / CW2-D06 / §3.2 / §9.1 规范：
 * adopt 请求严格固定为：request_id / expected_workflow_version / expected_control_revision / expected_binding_revision / profile_ref:{id,revision} / workspace_id / conversation_id
 * 严禁客户端提供 adapter/host/account/model/root/source 作为权威输入，伪造字段在 strict 校验下直接返回 400
 */
export const SessionBindingAdoptInputSchema = z
  .object({
    request_id: z.string().min(1),
    expected_workflow_version: z.number().int().nonnegative().default(0),
    expected_control_revision: z.number().int().nonnegative().default(0),
    expected_binding_revision: z.number().int().nonnegative().default(0),
    profile_ref: z
      .object({
        id: z.string().min(1),
        revision: z.number().int().positive().default(1),
      })
      .strict(),
    workspace_id: z.string().min(1),
    conversation_id: z.string().min(1),
  })
  .strict();
export type SessionBindingAdoptInput = z.infer<typeof SessionBindingAdoptInputSchema>;

/**
 * 依据 CW2-D00 / §3.2 规范：会话列表信封响应
 * 必须返回 workflow_id/workflow_version/binding_strategy/migration_pending/bindings/current_binding_id?
 */
export const SessionBindingsEnvelopeSchema = z
  .object({
    workflow_id: Id,
    workflow_version: z.number().int().positive().default(1),
    control_revision: z.number().int().nonnegative().default(0),
    binding_strategy: z.enum(["unified", "legacy"]).default("unified"),
    migration_pending: z.boolean().default(false),
    bindings: z.array(SessionBindingSchema),
    current_binding_id: Id.optional(),
  })
  .strict();
export type SessionBindingsEnvelope = z.infer<typeof SessionBindingsEnvelopeSchema>;

/**
 * 依据 CW2-D06 / §9.2 规范：会话绑定修复 Apply 输入
 */
export const SessionBindingRepairApplyInputSchema = z
  .object({
    request_id: z.string().min(1),
    expected_workflow_version: z.number().int().positive(),
    expected_control_revision: z.number().int().positive(),
    source_digest: z.string().min(1),
    selections: z
      .array(
        z
          .object({
            candidate_id: z.string().min(1),
            expected_binding_revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type SessionBindingRepairApplyInput = z.infer<
  typeof SessionBindingRepairApplyInputSchema
>;

/**
 * 依据 CW2-D06 / §9.3 规范：会话绑定修复 Rollback 输入
 */
export const SessionBindingRepairRollbackInputSchema = z
  .object({
    request_id: z.string().min(1),
    migration_id: z.string().min(1),
    expected_workflow_version: z.number().int().positive(),
    expected_control_revision: z.number().int().positive(),
    expected_binding_revisions: z
      .array(
        z
          .object({
            binding_id: z.string().min(1),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type SessionBindingRepairRollbackInput = z.infer<
  typeof SessionBindingRepairRollbackInputSchema
>;

/**
 * 依据 CW2-D07 / §10.1 规范：
 * 响应固定携带 workflow_id/binding_id/binding_revision/conversation_id/cwd/target_shell/status/reason/executable/args/safe_env/copy_script/managed_writer_state/dispatch_enabled/observed_at
 * 移除危险的 command_line 兜底
 */
export const SessionBindingResumeInstructionsSchema = z
  .object({
    workflow_id: Id,
    binding_id: Id,
    binding_revision: z.number().int().positive().default(1),
    conversation_id: z.string().min(1),
    cwd: z.string().min(1),
    target_shell: z.literal("powershell-windows").default("powershell-windows"),
    status: z.enum(["supported", "unsupported", "identity_unverified"]).default("supported"),
    reason: z.string().optional(),
    executable: z.string().optional(),
    args: z.array(z.string()).default([]),
    safe_env: z.record(z.string(), z.string()).default({}),
    copy_script: z.string().optional(),
    managed_writer_state: z.enum(["idle", "active", "unknown"]).default("idle"),
    dispatch_enabled: z.boolean().default(false),
    observed_at: z.string().min(1),
    adapter_id: z.string().optional(),
    notice: z.string().optional(),
  })
  .strict();
export type SessionBindingResumeInstructions = z.infer<
  typeof SessionBindingResumeInstructionsSchema
>;
