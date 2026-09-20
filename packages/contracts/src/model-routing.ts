import { z } from "zod";
import { Id } from "./base.js";
import {
  ReasoningSelectionSchema,
  SupportedAdapters,
  ToolProfileSchema,
  type ToolProfile,
  type ReasoningSelection,
} from "./execution-spec.js";
import { IdentityConfidenceSchema } from "./model-access.js";
import { EffortTransportSchema } from "./model-catalog.js";

export const RoutingRoles = [
  "planner",
  "executor",
  "reviewer",
  "review_fixer",
  "functional_fixer",
] as const;
export type RoutingRole = (typeof RoutingRoles)[number];

export const RoutingSourceSchema = z.enum([
  "task-base",
  "task-override",
  "user-repair",
  "planner-takeover",
  "retry",
  "legacy",
]);
export type RoutingSource = z.infer<typeof RoutingSourceSchema>;

export const RuntimeFlavorSchema = z.enum([
  "profile-native",
  "legacy-agy-native",
  "legacy-managed",
]);
export type RuntimeFlavor = z.infer<typeof RuntimeFlavorSchema>;

export const RepairKindSchema = z.enum(["quality", "functional"]);
export type RepairKind = z.infer<typeof RepairKindSchema>;

export const QualityPhaseSchema = z.enum(["before_human", "after_human"]);

export const DispatchContextSchema = z
  .object({
    purpose: z.enum([
      "planning",
      "implement",
      "plan_self_check",
      "quality_review",
      "planner_takeover",
      "functional_fix",
      "aside",
      "merge_conflict",
      "diagnose",
    ]),
    review_phase: QualityPhaseSchema.optional(),
    repair_kind: RepairKindSchema.optional(),
    repair_batch_id: z.string().optional(),
    assignment_id: z.string().optional(),
    functional_fix_intent: z.boolean().optional(),
    planner_takeover: z.boolean().optional(),
    retry_run_id: z.string().optional(),
    logical_round_id: z.string().optional(),
    associated_run_id: z.string().optional(),
    source_run_id: z.string().optional(),
  })
  .strict();
export type DispatchContext = z.infer<typeof DispatchContextSchema>;

export const FrozenInvocationSchema = z
  .object({
    schema_version: z.literal(1),
    adapterId: z.enum(SupportedAdapters),
    executable: z.string().min(1),
    modelToken: z.string().nullable(),
    effortArgs: z.array(z.string()),
    effortEnv: z.record(z.string(), z.string()),
    transport: EffortTransportSchema,
    reasoning: ReasoningSelectionSchema,
    nativeConfigProfile: z.string().optional(),
    providerScope: z.string().min(1),
    accountScope: z.string().min(1),
    identityConfidence: IdentityConfidenceSchema,
    capabilityRevision: z.string().min(1),
    runtimeFlavor: RuntimeFlavorSchema,
    kimiProvider: z.string().optional(),
    opencodeVariantEncoding: z.enum(["flag", "hash"]).optional(),
    catalogEntryId: z.string().optional(),
    accessModelKey: z.string().min(1),
    observedModelStatus: z.enum(["matched", "unknown", "mismatch"]).optional(),
  })
  .strict();
export type FrozenInvocation = z.infer<typeof FrozenInvocationSchema>;

export const EffectiveInvocationSchema = z
  .object({
    adapterId: z.enum(SupportedAdapters),
    executable: z.string().min(1),
    modelId: z.string().nullable(),
    reasoning: ReasoningSelectionSchema,
    nativeConfigProfile: z.string().optional(),
    providerScope: z.string().min(1),
    accountScope: z.string().min(1),
    capabilityRevision: z.string().min(1),
    runtimeFlavor: RuntimeFlavorSchema,
  })
  .strict();
export type EffectiveInvocation = z.infer<typeof EffectiveInvocationSchema>;

export const RunModelBindingSchema = z
  .object({
    routing_role: z.enum(RoutingRoles),
    execution_spec_revision: z.number().int().nonnegative(),
    routing_source: RoutingSourceSchema,
    logical_round_id: z.string().min(1),
    repair_batch_id: z.string().optional(),
    assignment_id: z.string().optional(),
    effective_invocation: EffectiveInvocationSchema,
    frozen_invocation: FrozenInvocationSchema.optional(),
    invocation_fingerprint: z.string().min(1),
    observed_model: z.string().optional(),
    observed_effort: z.string().optional(),
  })
  .strict();
export type RunModelBinding = z.infer<typeof RunModelBindingSchema>;

export const RepairModelAssignmentSchema = z
  .object({
    id: Id,
    revision: z.number().int().positive(),
    workflow_id: Id,
    batch_id: z.string().min(1),
    kind: RepairKindSchema,
    phase: QualityPhaseSchema.optional(),
    source_review_id: z.string().optional(),
    issue_ids: z.array(z.string()),
    profile: ToolProfileSchema,
    status: z.enum(["pending", "active", "completed", "superseded"]),
    created_at: z.string().min(1),
    created_by: z.literal("human"),
  })
  .strict();
export type RepairModelAssignment = z.infer<typeof RepairModelAssignmentSchema>;

export const RepairModelBatchSchema = z
  .object({
    id: z.string().min(1),
    workflow_id: Id,
    kind: RepairKindSchema,
    phase: QualityPhaseSchema.optional(),
    source_review_id: z.string().optional(),
    issue_ids: z.array(z.string()),
    status: z.enum(["open", "closed"]),
    current_assignment_id: z.string().optional(),
    created_at: z.string().min(1),
    closed_at: z.string().optional(),
  })
  .strict();
export type RepairModelBatch = z.infer<typeof RepairModelBatchSchema>;

export const RepairSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("task-default") }).strict(),
  z.object({ mode: z.literal("planner") }).strict(),
  z.object({ mode: z.literal("executor") }).strict(),
  z
    .object({
      mode: z.literal("custom"),
      profile: ToolProfileSchema,
    })
    .strict(),
]);
export type RepairSelection = z.infer<typeof RepairSelectionSchema>;

export const ModelDefaultsSchema = z
  .object({
    schema_version: z.literal(1),
    revision: z.number().int().nonnegative(),
    plannerProfile: ToolProfileSchema,
    executorProfile: ToolProfileSchema,
    updated_at: z.string().min(1),
    source: z.enum(["legacy-import", "initial-setup", "user"]),
  })
  .strict();
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

export const ResolvedRoleSchema = z
  .object({
    role: z.enum(RoutingRoles),
    profile: ToolProfileSchema,
    source: RoutingSourceSchema,
    inherited_from: z.enum(["planner", "executor"]).optional(),
  })
  .strict();
export type ResolvedRole = z.infer<typeof ResolvedRoleSchema>;

export const ActiveRunSummarySchema = z
  .object({
    run_id: z.string().min(1),
    role: z.enum(RoutingRoles),
    bound_spec_revision: z.number().int().nonnegative(),
    profile: ToolProfileSchema,
    requested: z
      .object({
        adapterId: z.enum(SupportedAdapters),
        modelId: z.string().nullable(),
        reasoning: ReasoningSelectionSchema,
      })
      .strict(),
    observed: z
      .object({
        model: z.string().optional(),
        effort: z.string().optional(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ActiveRunSummary = z.infer<typeof ActiveRunSummarySchema>;

export const ResumeTargetSchema = z
  .object({
    purpose: z.string().min(1),
    stage: z.string().min(1),
    review_phase: QualityPhaseSchema.optional(),
    repair_batch_id: z.string().optional(),
    label: z.string().min(1),
  })
  .strict();
export type ResumeTarget = z.infer<typeof ResumeTargetSchema>;

export const ExecutionSpecGetResponseSchema = z
  .object({
    workflow_id: Id,
    workflow_version: z.number().int().nonnegative(),
    spec_revision: z.number().int().nonnegative(),
    source: z.enum(["task", "legacy"]),
    persisted: z.boolean(),
    spec: z.record(z.string(), z.unknown()),
    resolved_roles: z.record(z.enum(RoutingRoles), ResolvedRoleSchema),
    active_run: ActiveRunSummarySchema.nullable(),
    pending_roles: z.array(z.enum(RoutingRoles)),
    repair_assignments: z.array(RepairModelAssignmentSchema),
    can_edit: z.boolean(),
    resume_target: ResumeTargetSchema.nullable(),
  })
  .strict();
export type ExecutionSpecGetResponse = z.infer<
  typeof ExecutionSpecGetResponseSchema
>;

export const ExecutionSpecWriteRequestSchema = z
  .object({
    request_id: z.string().uuid(),
    expected_spec_revision: z.number().int().nonnegative(),
    planner_profile: ToolProfileSchema,
    executor_profile: ToolProfileSchema,
    role_overrides: z
      .object({
        reviewer: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("inherit") }).strict(),
          z
            .object({
              mode: z.literal("explicit"),
              profile: ToolProfileSchema,
            })
            .strict(),
        ]),
        review_fixer: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("inherit") }).strict(),
          z
            .object({
              mode: z.literal("explicit"),
              profile: ToolProfileSchema,
            })
            .strict(),
        ]),
        functional_fixer: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("inherit") }).strict(),
          z
            .object({
              mode: z.literal("explicit"),
              profile: ToolProfileSchema,
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();
export type ExecutionSpecWriteRequest = z.infer<
  typeof ExecutionSpecWriteRequestSchema
>;

export const FunctionalIssueViewSchema = z
  .object({
    issue: z.object({
      issue_id: Id,
      workflow_id: Id,
      created_seq: z.number().int().positive(),
      description: z.string().min(1),
      status: z.enum([
        "open",
        "queued",
        "fixing",
        "ready_for_retest",
        "confirmed",
      ]),
      created_at: z.string().min(1),
    }),
    batch_id: z.string().nullable(),
    assignment_revision: z.number().int().nonnegative().nullable(),
    assignment_id: z.string().nullable(),
    inherited_profile: ToolProfileSchema.nullable(),
    explicit_profile: ToolProfileSchema.nullable(),
    last_fixer_profile: ToolProfileSchema.nullable(),
  })
  .strict();
export type FunctionalIssueView = z.infer<typeof FunctionalIssueViewSchema>;

export const RepairBatchViewSchema = z
  .object({
    batch: RepairModelBatchSchema,
    assignment: RepairModelAssignmentSchema.nullable(),
    inherited_profile: ToolProfileSchema,
    last_fixer_profile: ToolProfileSchema.nullable(),
    can_edit: z.boolean(),
  })
  .strict();
export type RepairBatchView = z.infer<typeof RepairBatchViewSchema>;

export type SemanticProfileSlice = {
  adapterId: ToolProfile["adapterId"];
  executableRef?: string;
  modelSelection: ToolProfile["modelSelection"];
  modelId?: string;
  providerConfigRef?: string;
  toolsetRef?: string;
  reasoning?: ReasoningSelection;
  nativeConfigProfile?: string;
  selectionKind?: ToolProfile["selectionKind"];
  options: ToolProfile["options"];
};
