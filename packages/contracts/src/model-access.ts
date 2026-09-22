import { z } from "zod";
import { Id } from "./base.js";
import { SupportedAdapters } from "./execution-spec.js";

export const ModelAccessStatusSchema = z.enum([
  "unverified",
  "checking",
  "verified",
  "login_required",
  "model_forbidden",
  "unavailable",
  "environment_error",
  "temporary_error",
]);
export type ModelAccessStatus = z.infer<typeof ModelAccessStatusSchema>;

export const IdentityConfidenceSchema = z.enum([
  "account",
  "credential",
  "profile-scope",
]);
export type IdentityConfidence = z.infer<typeof IdentityConfidenceSchema>;

export const NonSecretIdentitySchema = z
  .object({
    adapterId: z.enum(SupportedAdapters),
    accountFingerprint: z.string().min(1),
    providerEndpointFingerprint: z.string().optional(),
    nativeConfigScope: z.string().min(1),
    identityConfidence: IdentityConfidenceSchema,
    displayLabel: z.string().optional(),
  })
  .strict();
export type NonSecretIdentity = z.infer<typeof NonSecretIdentitySchema>;

export const ModelAccessRecordSchema = z
  .object({
    key: z.string().min(1),
    status: ModelAccessStatusSchema,
    checked_at: z.string().min(1),
    adapterId: z.enum(SupportedAdapters),
    cliFingerprint: z.string().min(1),
    accountScope: z.string().min(1),
    providerScope: z.string().min(1),
    accessModelKey: z.string().min(1),
    verification_method: z.string().min(1),
    error_code: z.string().optional(),
    last_success_at: z.string().optional(),
    identityConfidence: IdentityConfidenceSchema,
  })
  .strict();
export type ModelAccessRecord = z.infer<typeof ModelAccessRecordSchema>;

export const VerificationJobStatusSchema = z.enum([
  "queued",
  "checking",
  "verified",
  "failed",
  "cancelled",
  "temporary_error",
]);
export type VerificationJobStatus = z.infer<typeof VerificationJobStatusSchema>;

export const ModelVerificationJobSchema = z
  .object({
    id: Id,
    request_id: z.string().uuid(),
    access_key: z.string().min(1),
    status: VerificationJobStatusSchema,
    started_at: z.string().min(1),
    deadline_at: z.string().min(1),
    completed_at: z.string().optional(),
    error_code: z.string().optional(),
    error_message: z.string().optional(),
    retryable: z.boolean().default(false),
  })
  .strict();
export type ModelVerificationJob = z.infer<typeof ModelVerificationJobSchema>;

export const MODEL_ERROR_CODES = [
  "SPEC_VERSION_CONFLICT",
  "DEFAULTS_VERSION_CONFLICT",
  "ACTIVE_RUN_CHANGED",
  "RUN_STILL_STOPPING",
  "TOOL_NOT_FOUND",
  "TOOL_IDENTITY_MISMATCH",
  "CLI_PARAMETER_UNSUPPORTED",
  "MODEL_NOT_LISTED",
  "MODEL_ACCESS_REQUIRED",
  "MODEL_LOGIN_REQUIRED",
  "MODEL_FORBIDDEN",
  "MODEL_UNAVAILABLE",
  "EFFORT_UNSUPPORTED",
  "EFFORT_METADATA_UNKNOWN",
  "DISCOVERY_ENVIRONMENT_UNAVAILABLE",
  "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
  "MODEL_PROBE_TIMEOUT",
  "IDEMPOTENCY_CONFLICT",
  "RESUME_TARGET_AMBIGUOUS",
  "TASK_TERMINAL",
  "LEGACY_RUNTIME_UNSUPPORTED",
  "AMBIGUOUS_VERSION_FIELD",
  "REPAIR_BATCH_MISMATCH",
] as const;
export type ModelErrorCode = (typeof MODEL_ERROR_CODES)[number];

export const ModelErrorBodySchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
    request_id: z.string().optional(),
  })
  .strict();
export type ModelErrorBody = z.infer<typeof ModelErrorBodySchema>;

export const ConfigOperationStatusSchema = z.enum([
    "prepared",
  "awaiting_access",
  "processing",
  "ready",
  "committed",
  "stopping",
  "stopped",
  "failed",
  "retryable",
  "rejected",
]);
export type ConfigOperationStatus = z.infer<typeof ConfigOperationStatusSchema>;

export const EffectiveFromSchema = z.enum([
  "new-workflows",
  "next-run",
  "stopped-awaiting-resume",
]);
export type EffectiveFrom = z.infer<typeof EffectiveFromSchema>;

export const MutationReceiptSchema = z
  .object({
    operation_id: z.string().min(1),
    request_id: z.string().uuid(),
    status: ConfigOperationStatusSchema,
    entity_revision: z.number().int().nonnegative(),
    changed: z.boolean(),
    effective_from: EffectiveFromSchema,
    current_run_id: z.string().nullable(),
    pending_roles: z.array(z.string()),
    resume_status: z.enum(["completed", "failed"]).optional(),
    resume_error: z.string().optional(),
  })
  .strict();
export type MutationReceipt = z.infer<typeof MutationReceiptSchema>;

export const NativeResolvedConfigSchema = z
  .object({
    adapterId: z.enum(SupportedAdapters),
    executablePath: z.string().min(1),
    nativeConfigProfile: z.string().optional(),
    nativeConfigScope: z.string().min(1),
    providerEndpoint: z.string().optional(),
    providerEndpointFingerprint: z.string().optional(),
    accountId: z.string().optional(),
    accountFingerprint: z.string().min(1),
    identityConfidence: IdentityConfidenceSchema,
    displayLabel: z.string().optional(),
    profileSelectionSupported: z.boolean(),
  })
  .strict();
export type NativeResolvedConfig = z.infer<typeof NativeResolvedConfigSchema>;

export const ProbeTerminalSchema = z
  .object({
    success: z.boolean(),
    observedModel: z.string().optional(),
    observedModelStatus: z.enum(["matched", "unknown", "mismatch"]),
    errorCode: z.string().optional(),
    message: z.string().optional(),
  })
  .strict();
export type ProbeTerminal = z.infer<typeof ProbeTerminalSchema>;

export const VERIFY_JOB_TIMEOUT_MS = 60_000;
