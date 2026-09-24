import { z } from "zod";
import { Id } from "./base.js";

export const AccountStateSchema = z.enum([
  "pending_quota",
  "ready",
  "waiting_quota",
  "reauth_required",
  "disabled",
  "incompatible",
]);
export type AccountState = z.infer<typeof AccountStateSchema>;

export const WindowKindSchema = z.enum(["five_hour", "weekly"]);
export type WindowKind = z.infer<typeof WindowKindSchema>;

export const WindowStatusSchema = z.enum([
  "observed",
  "missing",
  "unsupported",
]);
export type WindowStatus = z.infer<typeof WindowStatusSchema>;

export const QuotaWindowSchema = z.object({
  kind: WindowKindSchema,
  duration_minutes: z.union([z.literal(300), z.literal(10080)]),
  remaining_fraction: z.number().min(0).max(1).nullable(),
  reset_at: z.string().nullable(),
  observed_at: z.string().min(1),
  status: WindowStatusSchema,
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

export const AgyAccountIdentitySchema = z.object({
  subject: z.string().optional(),
  email: z.string().email(),
  verified_at: z.string().min(1),
});
export type AgyAccountIdentity = z.infer<typeof AgyAccountIdentitySchema>;

export const MetadataStatusSchema = z.enum([
  "verified",
  "unverified",
  "unrecognized",
]);
export type MetadataStatus = z.infer<typeof MetadataStatusSchema>;

export const AgyAccountAuthSchema = z.object({
  has_refresh_credential: z.boolean().nullable().default(null),
  metadata_status: MetadataStatusSchema.default("unverified"),
  access_expires_at: z.string().optional(),
  refresh_expires_at: z.string().optional(),
  refresh_expiry_source: z.enum(["not_provided", "provider_reported"]),
  last_authenticated_request_at: z.string().optional(),
  last_refresh_verified_at: z.string().optional(),
  last_auth_error: z.string().optional(),
  email: z.string().optional(),
  subject: z.string().optional(),
});
export type AgyAccountAuth = z.infer<typeof AgyAccountAuthSchema>;

export const AgyAccountSchema = z.object({
  id: Id,
  realm_id: z.string().min(1),
  revision: z.number().int().positive().default(1),
  alias: z.string().min(1),
  identity: AgyAccountIdentitySchema,
  secret_ref: z.string().min(1),
  credential_revision: z.number().int().positive().default(1),
  state: AccountStateSchema,
  enrolled_at: z.string().min(1),
  enrollment_completed_at: z.string().optional(),
  last_used_at: z.string().optional(),
  disabled_reason: z.string().optional(),
  state_before_disabled: AccountStateSchema.optional(),
  auth: AgyAccountAuthSchema,
});
export type AgyAccount = z.infer<typeof AgyAccountSchema>;

export const AgyQuotaSnapshotSchema = z.object({
  id: Id,
  realm_id: z.string().min(1),
  account_id: Id,
  auth_epoch: z.number().int().positive(),
  pool_id: z.string().min(1),
  model_ids: z.array(z.string()),
  plan_tier: z.string().optional(),
  source: z.enum(["official_cli_usage", "official_cli_event"]),
  cli_version: z.string().min(1),
  parser_revision: z.number().int().positive().default(1),
  executable_fingerprint: z.string().optional(),
  capability_verified: z.boolean().optional(),
  observed_at: z.string().min(1),
  windows: z.array(QuotaWindowSchema),
  exhausted: z
    .object({
      window: z.union([WindowKindSchema, z.literal("unknown")]),
      observed_at: z.string().min(1),
    })
    .optional(),
});
export type AgyQuotaSnapshot = z.infer<typeof AgyQuotaSnapshotSchema>;

export const AgyAccountPolicySchema = z.object({
  workflow_id: Id,
  revision: z.number().int().positive().default(1),
  auto_switch: z.boolean().nullable().default(null),
  allowed_account_ids: z.array(Id).nullable().default(null),
  recreation_policy: z
    .enum(["exact_only", "recreate_after_confirmed_unavailable"])
    .default("exact_only"),
  night_pool: z.enum(["normal", "strict"]).default("normal"),
  created_at: z.string().min(1),
});
export type AgyAccountPolicy = z.infer<typeof AgyAccountPolicySchema>;

// Updates must preserve absent values; entity defaults are only for creation.
export const AgyAccountPolicyPatchSchema = z.object({
  auto_switch: z.boolean().nullable().optional(),
  allowed_account_ids: z.array(Id).nullable().optional(),
  recreation_policy: z.enum(["exact_only", "recreate_after_confirmed_unavailable"]).optional(),
  night_pool: z.enum(["normal", "strict"]).optional(),
}).strict();

export const ServiceStateSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
  "blocked",
]);
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const AgyRealmSchema = z.object({
  realm_id: z.string().min(1),
  owner: z.string().min(1),
  active_account_id: Id.nullable(),
  auth_epoch: z.number().int().nonnegative().default(0),
  phase: z.string().default("idle"),
  revision: z.number().int().positive().default(1),
  pending_operation_id: Id.nullable().optional(),
  service_state: ServiceStateSchema.default("stopped"),
  desired_enabled: z.boolean().default(false),
  control_generation: z.number().int().nonnegative().default(0),
  active_secret_ref: z.string().optional(),
  last_capture_at: z.string().optional(),
  last_error: z.string().optional(),
});
export type AgyRealm = z.infer<typeof AgyRealmSchema>;

export const AgyAccountSettingsSchema = z.object({
  realm_id: z.string().min(1),
  revision: z.number().int().positive().default(1),
  standalone_model_id: z.string().nullable().default(null),
  workflow_auto_switch: z.boolean().default(true),
  pause_managed_for_manual_switch: z.boolean().default(true),
  switch_gap_seconds: z.number().int().positive().default(3),
  reset_clock_skew_seconds: z.number().int().nonnegative().default(60),
  probe_timeout_seconds: z.number().int().positive().default(30),
  switch_timeout_seconds: z.number().int().positive().default(300),
  max_candidates_per_operation: z.number().int().positive().default(20),
  local_snapshot_stale_hours: z.number().int().positive().default(24),
  maintenance: z
    .object({
      timezone: z.string().default("Asia/Shanghai"),
      local_report_time: z.string().default("17:30"),
      night_start: z.string().default("20:00"),
      night_end: z.string().default("08:00"),
      refresh_verified_max_age_hours: z.number().int().positive().default(24),
      auto_network_check: z.literal(false).default(false),
    })
    .prefault({}),
  updated_at: z.string().min(1),
});
export type AgyAccountSettings = z.infer<typeof AgyAccountSettingsSchema>;

export const AgyAccountSettingsPatchSchema = z.object({
  standalone_model_id: z.string().nullable().optional(),
  workflow_auto_switch: z.boolean().optional(),
  pause_managed_for_manual_switch: z.boolean().optional(),
  switch_gap_seconds: z.number().int().positive().optional(),
  reset_clock_skew_seconds: z.number().int().nonnegative().optional(),
  probe_timeout_seconds: z.number().int().positive().optional(),
  switch_timeout_seconds: z.number().int().positive().optional(),
  max_candidates_per_operation: z.number().int().positive().optional(),
  local_snapshot_stale_hours: z.number().int().positive().optional(),
  maintenance: z.object({
    timezone: z.string().optional(),
    local_report_time: z.string().optional(),
    night_start: z.string().optional(),
    night_end: z.string().optional(),
    refresh_verified_max_age_hours: z.number().int().positive().optional(),
    auto_network_check: z.literal(false).optional(),
  }).strict().optional(),
}).strict();
export type AgyAccountSettingsPatch = z.infer<typeof AgyAccountSettingsPatchSchema>;

export const UsageKindSchema = z.enum(["execution", "probe", "login"]);
export type UsageKind = z.infer<typeof UsageKindSchema>;

export const UsagePermitStatusSchema = z.enum([
  "issued",
  "started",
  "released",
]);
export type UsagePermitStatus = z.infer<typeof UsagePermitStatusSchema>;

export const AgyUsagePermitSchema = z.object({
  permit_id: Id,
  realm_id: z.string().min(1),
  account_id: Id,
  auth_epoch: z.number().int().positive(),
  consumer_id: z.string().min(1),
  usage_kind: UsageKindSchema,
  status: UsagePermitStatusSchema,
  process_id: z.number().int().positive().optional(),
  issued_at: z.string().min(1),
  released_at: z.string().optional(),
  realm_revision: z.number().int().positive().optional(),
  required_pool_ids: z.array(z.string()).default([]),
  allowed_account_ids: z.array(Id).nullable().default(null),
  policy_revision: z.number().int().nonnegative().optional(),
});
export type AgyUsagePermit = z.infer<typeof AgyUsagePermitSchema>;

export const OperationKindSchema = z.enum([
  "enroll",
  "reauth",
  "probe",
  "switch",
  "maintenance",
  "cancel",
  "delete",
  "start",
  "stop",
  "capability_check",
]);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const OperationTriggerSchema = z.enum([
  "manual_auto",
  "manual_explicit",
  "workflow_quota",
  "workflow_auth",
  "enrollment",
  "maintenance",
]);
export type OperationTrigger = z.infer<typeof OperationTriggerSchema>;

export const OperationSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }),
  z.object({ mode: z.literal("explicit"), account_id: Id }),
]);
export type OperationSelection = z.infer<typeof OperationSelectionSchema>;

export const AgyAccountOperationSchema = z.object({
  operation_id: Id,
  realm_id: z.string().min(1),
  revision: z.number().int().positive().default(1),
  kind: OperationKindSchema,
  trigger: OperationTriggerSchema,
  selection: OperationSelectionSchema,
  target_account_id: Id.optional(),
  before_account_id: Id.optional(),
  before_auth_epoch: z.number().int().nonnegative().optional(),
  attempted_account_ids: z.array(Id).default([]),
  required_pool_ids: z.array(z.string()).default([]),
  phase: z.string().default("pending"),
  required_model_ids: z.array(z.string()).default([]),
  control_generation: z.number().int().nonnegative().default(0),
  request_id: z.string().min(1),
  error: z.string().optional(),
  workflow_id: Id.optional(),
  run_id: Id.optional(),
  source_run_id: Id.optional(),
  original_operation_id: Id.optional(),
  created_at: z.string().min(1),
  completed_at: z.string().optional(),
  deadline_at: z.string().optional(),
  request_digest: z.string().optional(),
  expected_settings_revision: z.number().int().positive().optional(),
  expected_account_revision: z.number().int().positive().optional(),
  model_id: z.string().optional(),
  account_id: Id.optional(),
  alias: z.string().optional(),
  mode: z.enum(["login", "capture_current"]).optional(),
  expected_identity: z.string().optional(),
  selected_account_ids: z.array(Id).default([]),
  allowed_account_ids: z.array(Id).nullable().default(null),
  night_pool: z.enum(["normal", "strict"]).default("normal"),
  before_secret_ref: z.string().optional(),
  installed_secret_ref: z.string().optional(),
  install_target_ref: z.string().optional(),
  install_target_account_id: Id.optional(),
  install_epoch: z.number().int().positive().optional(),
  candidate_ids: z.array(Id).default([]),
  candidate_results: z
    .array(
      z.object({
        account_id: Id,
        weekly: z.number(),
        verified_at: z.string(),
        verified_model_ids: z.array(z.string()).default([]),
        credential_revision: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
  consumer_refs: z
    .array(
      z.object({
        consumer_id: z.string(),
        saved_ref: z.unknown(),
        delivered: z.boolean().default(false),
      }),
    )
    .default([]),
  cancel_requested: z.boolean().default(false),
  result: z.record(z.string(), z.unknown()).optional(),
  external_processes: z
    .array(z.object({ pid: z.number(), exe_path: z.string() }))
    .default([]),
  retry_at: z.string().optional(),
  retry_count: z.number().int().nonnegative().default(0),
  source_event_key: z.string().optional(),
});
export type AgyAccountOperation = z.infer<typeof AgyAccountOperationSchema>;

export const AgyDomainWaitSchema = z.object({
  realm_id: z.string().min(1),
  blocked_window: z.union([WindowKindSchema, z.literal("unknown")]).optional(),
  next_eligible_at: z.string().min(1).nullable(),
  source_epoch: z.number().int().nonnegative(),
  target_workflow_version: z.number().int().optional(),
  reason: z.string().min(1),
  created_at: z.string().min(1),
  operation_id: Id.optional(),
  control_generation: z.number().int().nonnegative().optional(),
});
export type AgyDomainWait = z.infer<typeof AgyDomainWaitSchema>;

export const AgyRunBindingSchema = z.object({
  realm_id: z.string().min(1),
  account_id: Id,
  auth_epoch: z.number().int().positive(),
  account_policy_revision: z.number().int().positive(),
  credential_revision_at_start: z.number().int().positive(),
  account_settings_revision_at_start: z.number().int().positive(),
  permit_id: Id,
  source_run_id: Id.optional(),
  recovery_id: Id.optional(),
});
export type AgyRunBinding = z.infer<typeof AgyRunBindingSchema>;

export const AgyAccountAuditSchema = z.object({
  audit_id: Id,
  realm_id: z.string().min(1),
  event_seq: z.number().int().positive(),
  account_id: Id.optional(),
  operation_id: Id.optional(),
  action: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string().min(1),
});
export type AgyAccountAudit = z.infer<typeof AgyAccountAuditSchema>;

// 安全 DTO（严格不含 secret_ref 等凭据信息）
export const AgyAccountDtoSchema = AgyAccountSchema.omit({
  secret_ref: true,
});
export type AgyAccountDto = z.infer<typeof AgyAccountDtoSchema>;

// 能力状态与投影 (AGF-D01)
export const CapabilityStatusSchema = z.enum(["verified", "unverified", "unsupported"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const CapabilityItemSchema = z.object({
  status: CapabilityStatusSchema,
  reason: z.string().optional(),
  cli_version: z.string().optional(),
  cli_sha256: z.string().optional(),
  host_version: z.string().optional(),
  parser_revision: z.number().int().nonnegative().optional(),
  verified_at: z.string().optional(),
});
export type CapabilityItem = z.infer<typeof CapabilityItemSchema>;

export const AgyAccountCapabilitiesSchema = z.object({
  identity: CapabilityItemSchema,
  dual_quota: CapabilityItemSchema,
  interactive_login: CapabilityItemSchema,
  noninteractive_auth: CapabilityItemSchema,
  auth_metadata: CapabilityItemSchema,
  owned_aux_job: CapabilityItemSchema,
  exact_resume: CapabilityItemSchema,
  confirmed_session_unavailable: CapabilityItemSchema,
  subagent_observation: CapabilityItemSchema,
  workspace_preservation: CapabilityItemSchema,
});
export type AgyAccountCapabilities = z.infer<typeof AgyAccountCapabilitiesSchema>;

// 辅助执行租约 (AGF-D02)
export const AgyAuxiliaryLeaseSchema = z.object({
  lease_id: Id,
  realm_id: z.string().min(1),
  operation_id: Id,
  control_generation: z.number().int().nonnegative(),
  auth_epoch: z.number().int().nonnegative(),
  usage_kind: UsageKindSchema,
  expected_credential_ref: z.string().optional(),
  job_id: z.string().optional(),
  issued_at: z.string().min(1),
  released_at: z.string().optional(),
});
export type AgyAuxiliaryLease = z.infer<typeof AgyAuxiliaryLeaseSchema>;

// 刷新事实观测 (AGF-D04)
export const AgyRefreshObservationSchema = z.object({
  observation_id: Id,
  account_id: Id,
  auth_epoch: z.number().int().positive(),
  lease_id: Id.optional(),
  permit_id: Id.optional(),
  cli_version: z.string().min(1),
  parser_revision: z.number().int().positive().default(1),
  before_access_expires_at: z.string().optional(),
  after_access_expires_at: z.string().optional(),
  success: z.boolean(),
  observed_at: z.string().min(1),
});
export type AgyRefreshObservation = z.infer<typeof AgyRefreshObservationSchema>;

// 持久待处理需求 (AGF-D05 FIFO批次调度)
export const DemandStatusSchema = z.enum([
  "waiting",
  "selected",
  "deferred",
  "completed",
  "cancelled",
  "superseded",
]);
export type DemandStatus = z.infer<typeof DemandStatusSchema>;

export const AgyPendingDemandSchema = z.object({
  demand_id: Id,
  revision: z.number().int().positive().default(1),
  demand_generation: z.number().int().positive().default(1),
  consumed_wake_key: z.string().optional(),
  consumer_id: z.string().min(1),
  opaque_recovery_ref: z.unknown().optional(),
  first_wait_at: z.string().min(1),
  fairness_key: z.string().min(1),
  source_revision: z.number().int().nonnegative().default(1),
  policy_revision: z.number().int().nonnegative().default(1),
  settings_revision: z.number().int().nonnegative().default(1),
  control_generation: z.number().int().nonnegative().default(0),
  required_model_keys: z.array(z.string()).default([]),
  required_pool_ids: z.array(z.string()).default([]),
  allowed_account_ids: z.array(Id).nullable().default(null),
  night_pool: z.enum(["normal", "strict"]).default("normal"),
  status: DemandStatusSchema.default("waiting"),
  wake_at: z.string().nullable().default(null),
  last_reason: z.string().optional(),
});
export type AgyPendingDemand = z.infer<typeof AgyPendingDemandSchema>;

// 恢复批次 (AGF-D05)
export const RecoveryBatchStatusSchema = z.enum([
  "planned",
  "quiescing",
  "activating",
  "committed",
  "failed",
  "cancelled",
]);
export type RecoveryBatchStatus = z.infer<typeof RecoveryBatchStatusSchema>;

export const AgyRecoveryBatchSchema = z.object({
  batch_id: Id,
  operation_id: Id,
  revision: z.number().int().positive().default(1),
  anchor_demand_id: Id,
  selected_demand_ids: z.array(Id),
  deferred_demand_ids: z.array(Id),
  candidate_account_ids: z.array(Id),
  committed_account_id: Id.optional(),
  status: RecoveryBatchStatusSchema.default("planned"),
  created_at: z.string().min(1),
  completed_at: z.string().optional(),
});
export type AgyRecoveryBatch = z.infer<typeof AgyRecoveryBatchSchema>;

export const FinalAccountCommitSchema = z.object({
  commit_id: Id,
  operation_id: Id,
  realm_id: z.string().min(1),
  outcome: z.enum(["switched", "restored"]),
  account_id: Id,
  secret_ref: z.string().min(1),
  credential_revision: z.number().int().nonnegative().optional(),
  auth_epoch: z.number().int().nonnegative(),
  control_generation: z.number().int().nonnegative(),
  committed_at: z.string().min(1),
  selected_batch_id: Id.optional(),
  stopped_job_ids: z.array(z.string()).default([]),
});
export type FinalAccountCommit = z.infer<typeof FinalAccountCommitSchema>;
export const RefreshEvidenceSchema = z.object({
  evidence_id: Id,
  realm_id: z.string().min(1),
  account_id: Id,
  auth_epoch: z.number().int().nonnegative(),
  credential_revision: z.number().int().nonnegative().optional(),
  permit_id: z.string().optional(),
  lease_id: z.string().optional(),
  observed_at: z.string().min(1),
  previous_expiry: z.string().nullable().optional(),
  new_expiry: z.string().nullable().optional(),
  protocol_verified: z.boolean().default(true),
  non_interactive: z.boolean().default(true),
  secret_ref: z.string().min(1),
  evidence_version: z.number().int().positive().default(1),
});
export type RefreshEvidence = z.infer<typeof RefreshEvidenceSchema>;
