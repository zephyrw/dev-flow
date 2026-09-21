import type { Store } from "../../store/src/store.js";
import type { Config } from "../../contracts/src/config.js";
import {
  FlowError,
  requireCondition,
  resolveTaskModel,
  type Run,
  type Plan,
} from "../../contracts/src/index.js";
import {
  inheritRoleOverrides,
  parseStoredExecutionSpec,
  parseStoredToolProfile,
  specMode,
  SupportedAdapters,
  ToolProfileSchema,
  type ExecutionSpec,
  type ExecutionSpecView,
  type RoleBinding,
  type RoleOverrides,
  type ToolProfile,
} from "../../contracts/src/execution-spec.js";
import { RunModelBindingSchema } from "../../contracts/src/model-routing.js";
import type {
  DispatchContext,
  FrozenInvocation,
  RepairKind,
  RepairModelAssignment,
  RepairModelBatch,
  RuntimeFlavor,
  RoutingRole,
  RoutingSource,
} from "../../contracts/src/model-routing.js";
import type { ModelCatalog, ModelEntry } from "../../contracts/src/model-catalog.js";
import { buildFrozenInvocation, selectionCapabilityFromCatalog } from "../../adapters/sdk/src/frozen-invocation.js";
import { ModelCatalogService } from "./model-catalog-service.js";
import { ModelAccessService } from "./model-access-service.js";
import { assertAccountModelRetryAccess, type PendingModelRetry } from "./model-retry.js";
import { id, objectHash } from "./util.js";

export type RunPurpose =
  | "planning"
  | "implement"
  | "plan_self_check"
  | "quality_review"
  | "planner_takeover"
  | "functional_fix"
  | "aside"
  | "merge_conflict"
  | "diagnose";

export type RoutingPreview = {
  purpose: DispatchContext["purpose"];
  routing_role: RoutingRole;
  profile: ToolProfile;
  routing_source: RoutingSource;
  inherited_from?: "planner" | "executor";
  execution_spec_id?: string;
  execution_spec_revision: number;
  logical_round_id: string;
  repair_batch_id?: string;
  assignment_id?: string;
  frozen_invocation?: FrozenInvocation;
  semanticHash: string;
};

type PlannerTakeoverRecord = {
  planner?: boolean;
  source?: string;
  phase?: string;
};

const PLANNER_RUN_PURPOSES = new Set([
  "planning",
  "planner_takeover",
  "aside",
]);
const EXECUTOR_RUN_PURPOSES = new Set([
  "implement",
  "functional_fix",
  "plan_self_check",
  "merge_conflict",
]);

export function resolveProfile(
  store: Store,
  profileId = "profile-agy",
): ToolProfile {
  const saved = store.get<ToolProfile>("tool_profile", profileId);
  if (saved) return ToolProfileSchema.parse(saved);
  const adapter = SupportedAdapters.find(
    (a) => profileId === a || profileId === "profile-" + a,
  );
  requireCondition(
    adapter,
    "PROFILE_NOT_FOUND",
    "未知工具配置：" + profileId,
    422,
  );
  return ToolProfileSchema.parse({ id: profileId, adapterId: adapter });
}

export function latestSpec(
  store: Store,
  workflowId: string,
): ExecutionSpec | undefined {
  const spec = store
    .list<unknown>("execution_spec", workflowId)
    .map((raw) => parseStoredExecutionSpec(raw))
    .sort((a, b) => b.revision - a.revision)[0];
  return spec;
}

export function bindProfile(
  store: Store,
  config: Config,
  workflowId: string,
  purpose: RunPurpose,
  context: Partial<DispatchContext> = {},
  retryOverride?: PendingModelRetry,
) {
  const preview = resolveRoutingPreview(store, config, workflowId, {
    ...context,
    purpose,
  }, retryOverride);
  const flavor = resolveRuntimeFlavor(
    store,
    workflowId,
    preview.profile.adapterId,
    purpose,
  );
  const frozen = preview.frozen_invocation
    ? { ...preview.frozen_invocation, runtimeFlavor: flavor }
    : freezeDispatchInvocation(store, preview.profile, flavor);
  if (retryOverride?.account_recovery) {
    new ModelAccessService(store).assertFrozenAccess(preview.profile, frozen);
  } else if (context.retry_run_id) {
    assertAccountModelRetryAccess(store, workflowId, context.retry_run_id);
  }
  const fingerprint = invocationFingerprintFromFrozen(
    frozen,
    workflowWorkspaceIdentity(store, workflowId),
    permissionCategoryForPurpose(purpose),
  );
  const modelBinding = RunModelBindingSchema.parse({
    routing_role: preview.routing_role,
    routing_source: preview.routing_source,
    execution_spec_revision: preview.execution_spec_revision,
    logical_round_id: preview.logical_round_id,
    ...(preview.repair_batch_id ? { repair_batch_id: preview.repair_batch_id } : {}),
    ...(preview.assignment_id ? { assignment_id: preview.assignment_id } : {}),
    effective_invocation: {
      adapterId: frozen.adapterId,
      executable: frozen.executable,
      modelId: frozen.modelToken,
      reasoning: frozen.reasoning,
      ...(frozen.nativeConfigProfile ? { nativeConfigProfile: frozen.nativeConfigProfile } : {}),
      providerScope: frozen.providerScope,
      accountScope: frozen.accountScope,
      capabilityRevision: frozen.capabilityRevision,
      runtimeFlavor: frozen.runtimeFlavor,
    },
    frozen_invocation: frozen,
    invocation_fingerprint: fingerprint,
  });
  return {
    purpose,
    execution_spec_id: preview.execution_spec_id,
    profile: preview.profile,
    routing_role: preview.routing_role,
    routing_source: preview.routing_source,
    execution_spec_revision: preview.execution_spec_revision,
    logical_round_id: preview.logical_round_id,
    invocation_fingerprint: fingerprint,
    model_binding: modelBinding,
    runtime_flavor: flavor,
    protocol: protocolForFlavor(flavor),
    frozen_invocation: frozen,
    ...(preview.repair_batch_id
      ? { repair_batch_id: preview.repair_batch_id }
      : {}),
    ...(preview.assignment_id ? { assignment_id: preview.assignment_id } : {}),
  };
}

export function profileForRun(store: Store, run: Run): ToolProfile {
  requireCondition(
    run.profile,
    "RUN_PROFILE_MISSING",
    "执行轮次缺少固定工具配置",
  );
  if (run.execution_spec_id) {
    const spec = store.must<ExecutionSpec>(
      "execution_spec",
      run.execution_spec_id,
    );
    requireCondition(
      spec.workflow_id === run.workflow_id,
      "SPEC_BINDING_INVALID",
      "配置不属于当前任务",
    );
  }
  return parseStoredToolProfile(run.profile);
}

export function resolveRoutingRole(context: DispatchContext): RoutingRole {
  switch (context.purpose) {
    case "planning":
    case "planner_takeover":
    case "aside":
      return "planner";
    case "quality_review":
    case "diagnose":
      return "reviewer";
    case "plan_self_check":
    case "merge_conflict":
      return "executor";
    case "functional_fix":
      return "functional_fixer";
    case "implement":
      return resolveImplementRole(context);
  }
}

export function semanticSpecHash(spec: {
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  roleOverrides?: RoleOverrides;
}): string {
  const overrides = spec.roleOverrides ?? inheritRoleOverrides();
  return objectHash({
    plannerProfile: semanticProfileSlice(spec.plannerProfile),
    executorProfile: semanticProfileSlice(spec.executorProfile),
    roleOverrides: {
      reviewer: semanticOverrideSlice(overrides.reviewer),
      review_fixer: semanticOverrideSlice(overrides.review_fixer),
      functional_fixer: semanticOverrideSlice(overrides.functional_fixer),
    },
  });
}

export function readEffectiveSpec(
  store: Store,
  config: Config,
  workflowId: string,
): ExecutionSpecView {
  const spec = latestSpec(store, workflowId);
  if (spec) return toPersistedView(spec);
  return projectLegacySpec(store, config, workflowId);
}

export function resolveRoutingPreview(
  store: Store,
  config: Config,
  workflowId: string,
  context: DispatchContext,
  retryOverride?: PendingModelRetry,
): RoutingPreview {
  const view = readEffectiveSpec(store, config, workflowId);
  const retry = retryPreview(store, workflowId, context, view.spec.revision, retryOverride);
  if (retry) return withPreviewHash(retry);
  const continuation = sourceContinuationPreview(
    store,
    workflowId,
    context,
    view,
  );
  if (continuation) return withPreviewHash(continuation);
  const merge = mergeConflictPreview(store, workflowId, context, view);
  if (merge) return withPreviewHash(merge);
  return withPreviewHash(resolveFreshPreview(store, workflowId, context, view));
}

function resolveImplementRole(context: DispatchContext): RoutingRole {
  if (context.repair_kind === "quality") return "review_fixer";
  if (context.functional_fix_intent) return "functional_fixer";
  return "executor";
}

function semanticProfileSlice(profile: ToolProfile) {
  return {
    adapterId: profile.adapterId,
    executableRef: profile.executableRef,
    modelSelection: profile.modelSelection,
    modelId: profile.modelId,
    providerConfigRef: profile.providerConfigRef,
    toolsetRef: profile.toolsetRef,
    reasoning: profile.reasoning,
    nativeConfigProfile: profile.nativeConfigProfile,
    selectionKind: profile.selectionKind,
    options: profile.options ?? {},
  };
}

function semanticOverrideSlice(binding: RoleBinding) {
  if (binding.mode === "inherit") return { mode: "inherit" as const };
  return {
    mode: "explicit" as const,
    profile: semanticProfileSlice(binding.profile),
  };
}

function toPersistedView(spec: ExecutionSpec): ExecutionSpecView {
  return {
    persisted: true,
    source: "task",
    spec: {
      schema_version: 2,
      id: spec.id,
      revision: spec.revision,
      workflow_id: spec.workflow_id,
      plannerProfile: spec.plannerProfile,
      executorProfile: spec.executorProfile,
      roleOverrides: spec.roleOverrides,
      template_id: spec.template_id,
      template_revision: spec.template_revision,
      mode: spec.mode,
      created_at: spec.created_at,
      ...(spec.source_defaults_revision !== undefined
        ? { source_defaults_revision: spec.source_defaults_revision }
        : {}),
    },
  };
}

function projectLegacySpec(
  store: Store,
  config: Config,
  workflowId: string,
): ExecutionSpecView {
  const plannerProfile =
    latestRunProfile(store, workflowId, PLANNER_RUN_PURPOSES) ??
    configPlannerProfile(config);
  const executorProfile =
    latestRunProfile(store, workflowId, EXECUTOR_RUN_PURPOSES) ??
    configExecutorProfile(config);
  const roleOverrides = inheritRoleOverrides();
  return {
    persisted: false,
    source: "legacy",
    spec: {
      schema_version: 2,
      id: "legacy-" + workflowId,
      revision: 0,
      workflow_id: workflowId,
      plannerProfile,
      executorProfile,
      roleOverrides,
      template_id: "native-development",
      template_revision: 3,
      mode: specMode({ plannerProfile, executorProfile, roleOverrides }),
      created_at: workflowCreatedAt(store, workflowId),
    },
  };
}

function configPlannerProfile(config: Config): ToolProfile {
  return ToolProfileSchema.parse({
    id: "legacy-planner",
    adapterId: "codex",
    executableRef: config.models.codex_executable,
    modelSelection: "explicit",
    modelId: config.models.reviewer,
    reasoning: { mode: "explicit", value: config.models.effort },
  });
}

function configExecutorProfile(config: Config): ToolProfile {
  return ToolProfileSchema.parse({
    id: "legacy-executor",
    adapterId: "agy",
    executableRef: config.models.agy_executable,
    modelSelection: "explicit",
    modelId: config.models.executor,
    reasoning: { mode: "explicit", value: config.models.effort },
  });
}

function workflowCreatedAt(store: Store, workflowId: string): string {
  const workflow = store.get<{ created_at?: string }>("workflow", workflowId);
  return workflow?.created_at ?? "1970-01-01T00:00:00.000Z";
}

function latestRunProfile(
  store: Store,
  workflowId: string,
  purposes: Set<string>,
): ToolProfile | undefined {
  const runs = store
    .list<Run>("run", workflowId)
    .filter((run) => purposes.has(run.purpose ?? "") && run.profile)
    .sort((a, b) => compareStartedAtDesc(a.started_at, b.started_at));
  const run = runs[0];
  if (!run?.profile) return undefined;
  return parseStoredToolProfile(run.profile);
}

function compareStartedAtDesc(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function retryPreview(
  store: Store,
  workflowId: string,
  context: DispatchContext,
  fallbackRevision: number,
  retryOverride?: PendingModelRetry,
): Omit<RoutingPreview, "semanticHash"> | undefined {
  if (!context.retry_run_id) return undefined;
  const run = store.get<Run>("run", context.retry_run_id);
  requireCondition(run, "RUN_NOT_FOUND", "重试找不到原执行轮次", 404);
  requireCondition(
    run.workflow_id === workflowId,
    "SPEC_BINDING_INVALID",
    "配置不属于当前任务",
  );
  requireCondition(
    run.profile,
    "RUN_PROFILE_MISSING",
    "执行轮次缺少固定工具配置",
  );
  const preview = previewFromFrozenRun(run, context, "retry", fallbackRevision);
  const pending = retryOverride ?? store.get<PendingModelRetry>("pending_model_retry", workflowId);
  if (pending?.retry_run_id === run.id && pending.account_recovery) {
    preview.frozen_invocation = pending.account_recovery.frozen_invocation;
  }
  return preview;
}

function mergeConflictPreview(
  store: Store,
  workflowId: string,
  context: DispatchContext,
  view: ExecutionSpecView,
): Omit<RoutingPreview, "semanticHash"> | undefined {
  if (context.purpose !== "merge_conflict" || !context.associated_run_id) {
    return undefined;
  }
  const run = store.get<Run>("run", context.associated_run_id);
  if (!run || run.workflow_id !== workflowId || !run.profile) return undefined;
  return previewFromFrozenRun(
    run,
    context,
    run.routing_source ?? taskSource(view.persisted),
    view.spec.revision,
  );
}

function sourceContinuationPreview(
  store: Store,
  workflowId: string,
  context: DispatchContext,
  view: ExecutionSpecView,
): Omit<RoutingPreview, "semanticHash"> | undefined {
  if (context.purpose !== "plan_self_check") return undefined;
  const sourceId = context.source_run_id;
  if (!sourceId) return undefined;
  const run = store.get<Run>("run", sourceId);
  if (!run || run.workflow_id !== workflowId || !run.profile) return undefined;
  return previewFromFrozenRun(
    run,
    {
      ...context,
      repair_batch_id: context.repair_batch_id ?? run.repair_batch_id,
    },
    run.routing_source ?? taskSource(view.persisted),
    view.spec.revision,
  );
}

function previewFromFrozenRun(
  run: Run,
  context: DispatchContext,
  source: RoutingSource,
  fallbackRevision: number,
): Omit<RoutingPreview, "semanticHash"> {
  const profile = parseStoredToolProfile(run.profile);
  const flavor = run.runtime_flavor ?? "profile-native";
  return {
    purpose: context.purpose,
    routing_role: run.routing_role ?? "executor",
    profile,
    routing_source: source,
    execution_spec_id: run.execution_spec_id,
    execution_spec_revision:
      run.execution_spec_revision ?? fallbackRevision,
    logical_round_id:
      context.logical_round_id ?? run.logical_round_id ?? run.id,
    repair_batch_id: context.repair_batch_id ?? run.repair_batch_id,
    assignment_id: context.assignment_id ?? run.assignment_id,
    frozen_invocation:
      run.frozen_invocation ?? frozenInvocationFromProfile(profile, flavor),
  };
}

function resolveFreshPreview(
  store: Store,
  workflowId: string,
  context: DispatchContext,
  view: ExecutionSpecView,
): Omit<RoutingPreview, "semanticHash"> {
  const naturalRole = resolveRoutingRole(context);
  const assignment = canUseUserRepair(context)
    ? matchingRepairAssignment(store, workflowId, context.repair_batch_id!)
    : undefined;
  if (assignment) {
    return {
      purpose: context.purpose,
      routing_role: naturalRole,
      profile: parseStoredToolProfile(assignment.profile),
      routing_source: "user-repair",
      execution_spec_id: persistedSpecId(view),
      execution_spec_revision: view.spec.revision,
      logical_round_id: context.logical_round_id ?? id("round"),
      repair_batch_id: context.repair_batch_id,
      assignment_id: assignment.id,
    };
  }
  if (canUsePlannerTakeover(store, workflowId, context, naturalRole)) {
    return {
      purpose: context.purpose,
      routing_role: "planner",
      profile: view.spec.plannerProfile,
      routing_source: "planner-takeover",
      execution_spec_id: persistedSpecId(view),
      execution_spec_revision: view.spec.revision,
      logical_round_id: context.logical_round_id ?? id("round"),
      repair_batch_id: context.repair_batch_id,
    };
  }
  const resolved = resolveTaskRole(view, naturalRole);
  return {
    purpose: context.purpose,
    routing_role: naturalRole,
    profile: resolved.profile,
    routing_source: resolved.source,
    inherited_from: resolved.inherited_from,
    execution_spec_id: persistedSpecId(view),
    execution_spec_revision: view.spec.revision,
    logical_round_id: context.logical_round_id ?? id("round"),
    repair_batch_id: context.repair_batch_id,
  };
}

function canUseUserRepair(context: DispatchContext): boolean {
  if (!context.repair_batch_id) return false;
  return (
    context.purpose === "implement" ||
    context.purpose === "functional_fix" ||
    context.purpose === "planner_takeover" ||
    context.purpose === "merge_conflict"
  );
}

function matchingRepairAssignment(
  store: Store,
  workflowId: string,
  batchId: string,
): RepairModelAssignment | undefined {
  const matched = store
    .list<RepairModelAssignment>("repair_model_assignment", workflowId)
    .filter(
      (item) =>
        item.batch_id === batchId &&
        (item.status === "pending" || item.status === "active"),
    );
  matched.sort((a, b) => b.revision - a.revision);
  return matched[0];
}

function canUsePlannerTakeover(
  store: Store,
  workflowId: string,
  context: DispatchContext,
  naturalRole: RoutingRole,
): boolean {
  if (naturalRole === "reviewer") return false;
  if (
    context.purpose === "planning" ||
    context.purpose === "aside" ||
    context.purpose === "plan_self_check" ||
    context.purpose === "diagnose" ||
    context.purpose === "quality_review"
  ) {
    return false;
  }
  if (context.planner_takeover) return true;
  if (context.purpose === "planner_takeover") return true;
  if (context.purpose === "functional_fix" || context.functional_fix_intent) {
    return false;
  }
  const assignment = store.get<PlannerTakeoverRecord>(
    "repair_assignment",
    workflowId,
  );
  if (assignment?.planner !== true) return false;
  return context.repair_kind === "quality" || naturalRole === "review_fixer";
}

function resolveTaskRole(
  view: ExecutionSpecView,
  role: RoutingRole,
): {
  profile: ToolProfile;
  source: RoutingSource;
  inherited_from?: "planner" | "executor";
} {
  const source = taskSource(view.persisted);
  if (role === "planner") {
    return { profile: view.spec.plannerProfile, source };
  }
  if (role === "executor") {
    return { profile: view.spec.executorProfile, source };
  }
  const binding = view.spec.roleOverrides[role];
  if (binding.mode === "explicit") {
    return {
      profile: binding.profile,
      source: view.persisted ? "task-override" : "legacy",
    };
  }
  if (role === "reviewer") {
    return {
      profile: view.spec.plannerProfile,
      source,
      inherited_from: "planner",
    };
  }
  return {
    profile: view.spec.executorProfile,
    source,
    inherited_from: "executor",
  };
}

function taskSource(persisted: boolean): RoutingSource {
  return persisted ? "task-base" : "legacy";
}

function persistedSpecId(view: ExecutionSpecView): string | undefined {
  return view.persisted ? view.spec.id : undefined;
}

function withPreviewHash(
  preview: Omit<RoutingPreview, "semanticHash">,
): RoutingPreview {
  return {
    ...preview,
    semanticHash: objectHash({
      routing_role: preview.routing_role,
      routing_source: preview.routing_source,
      profile: semanticProfileSlice(preview.profile),
      assignment_id: preview.assignment_id,
      repair_batch_id: preview.repair_batch_id,
      execution_spec_id: preview.execution_spec_id,
      execution_spec_revision: preview.execution_spec_revision,
    }),
  };
}

export function permissionCategoryForPurpose(
  purpose: string,
): "read-only" | "write" {
  if (
    purpose === "planning" ||
    purpose === "quality_review" ||
    purpose === "aside" ||
    purpose === "diagnose"
  ) {
    return "read-only";
  }
  return "write";
}

export function invocationFingerprintFromProfile(
  profile: ToolProfile,
  workspaceIdentity: string,
  permissionCategory: "read-only" | "write",
): string {
  return objectHash({
    adapterId: profile.adapterId,
    executable: profile.executableRef ?? profile.adapterId,
    nativeConfigProfile: profile.nativeConfigProfile ?? "",
    providerScope: profile.providerConfigRef ?? profile.adapterId,
    accountScope: profile.nativeConfigProfile ?? "default",
    modelId: profile.modelId ?? null,
    reasoning: profile.reasoning ?? { mode: "native-default" },
    workspaceIdentity,
    permissionCategory,
  });
}

export function invocationFingerprintFromFrozen(
  frozen: FrozenInvocation,
  workspaceIdentity: unknown,
  permissionCategory: "read-only" | "write",
): string {
  return objectHash({
    adapterId: frozen.adapterId,
    executable: frozen.executable,
    nativeConfigProfile: frozen.nativeConfigProfile ?? "",
    providerScope: frozen.providerScope,
    accountScope: frozen.accountScope,
    modelToken: frozen.modelToken,
    reasoning: frozen.reasoning,
    transport: frozen.transport,
    effortArgs: frozen.effortArgs,
    effortEnv: frozen.effortEnv,
    kimiProvider: frozen.kimiProvider,
    opencodeVariantEncoding: frozen.opencodeVariantEncoding,
    workspaceIdentity,
    permissionCategory,
  });
}

export function workflowWorkspaceIdentity(store: Store, workflowId: string) {
  const workspaces = store.list<{ repo_id: string; root: string }>("workspace", workflowId);
  if (workspaces.length) return { workflowId, roots: workspaces.map((w) => [w.repo_id, w.root]).sort((a, b) => a[0]!.localeCompare(b[0]!)) };
  const roots = store.get<{ roots: Record<string, string> }>("entry_context", workflowId)?.roots;
  if (roots) return { workflowId, roots: Object.entries(roots).sort(([a], [b]) => a.localeCompare(b)) };
  const workflow = store.get<{ project_id: string }>("workflow", workflowId);
  const project = workflow && store.get<{ repositories: Array<{ id: string; path: string }> }>("project", workflow.project_id);
  return { workflowId, roots: (project?.repositories ?? []).map((r) => [r.id, r.path]).sort((a, b) => a[0]!.localeCompare(b[0]!)) };
}

export function protocolForFlavor(
  flavor: RuntimeFlavor,
): "lightweight" | "legacy" {
  return flavor === "legacy-managed" ? "legacy" : "lightweight";
}

export function resolveRuntimeFlavor(
  _store: Store,
  _workflowId: string,
  _adapterId: ToolProfile["adapterId"],
  _purpose: RunPurpose,
): RuntimeFlavor {
  return "profile-native";
}

export function buildDispatchContext(
  store: Store,
  workflowId: string,
  purpose: RunPurpose,
): Partial<DispatchContext> {
  const retry = store.get<PendingModelRetry>(
    "pending_model_retry",
    workflowId,
  );
  if (retry?.retry_run_id && !["aside", "diagnose", "merge_conflict"].includes(purpose)) {
    return {
      retry_run_id: retry.retry_run_id,
      logical_round_id: retry.logical_round_id,
    };
  }
  if (purpose === "quality_review") {
    const intent = store.get<{ phase?: string }>(
      "plan_check_review_intent",
      workflowId,
    );
    return intent?.phase === "after_human"
      ? { review_phase: "after_human" }
      : { review_phase: "before_human" };
  }
  return repairDispatchContext(store, workflowId, purpose);
}

function repairDispatchContext(
  store: Store,
  workflowId: string,
  purpose: RunPurpose,
): Partial<DispatchContext> {
  if (
    purpose === "planning" ||
    purpose === "aside" ||
    purpose === "diagnose"
  ) {
    return {};
  }
  if (purpose === "plan_self_check") {
    return planSelfCheckDispatch(store, workflowId);
  }
  if (purpose === "implement" || purpose === "functional_fix") {
    const functional = functionalFixDispatch(store, workflowId);
    if (functional) return functional;
  }
  const takeover = store.get<{ planner?: boolean; source?: string }>(
    "repair_assignment",
    workflowId,
  );
  const qualityBatchId = findOpenBatchId(store, workflowId, "quality");
  if (purpose === "planner_takeover" || takeover?.planner) {
    return {
      planner_takeover: true,
      repair_kind: "quality",
      repair_batch_id: qualityBatchId,
    };
  }
  if (qualityBatchId || takeover?.source === "quality_review") {
    return {
      repair_kind: "quality",
      repair_batch_id: qualityBatchId,
    };
  }
  return {};
}

function functionalFixDispatch(
  store: Store,
  workflowId: string,
): Partial<DispatchContext> | undefined {
  const intent = store.get<{ batch_id?: string }>(
    "functional_fix_intent",
    workflowId,
  );
  if (!intent) return undefined;
  return {
    functional_fix_intent: true,
    repair_kind: "functional",
    repair_batch_id:
      intent.batch_id ?? batchForOpenFunctionalIssues(store, workflowId),
  };
}

function planSelfCheckDispatch(
  store: Store,
  workflowId: string,
): Partial<DispatchContext> {
  const pending = store.get<{ source_run_id?: string }>(
    "executor_plan_check",
    workflowId,
  );
  if (!pending?.source_run_id) return {};
  const source = store.get<Run>("run", pending.source_run_id);
  if (!source || source.workflow_id !== workflowId) {
    return { source_run_id: pending.source_run_id };
  }
  return {
    source_run_id: pending.source_run_id,
    repair_batch_id: source.repair_batch_id,
    assignment_id: source.assignment_id,
    planner_takeover:
      source.purpose === "planner_takeover" ||
      source.routing_source === "planner-takeover",
    repair_kind: source.repair_batch_id ? inferRepairKind(store, source) : undefined,
  };
}

function inferRepairKind(store: Store, run: Run): RepairKind | undefined {
  if (!run.repair_batch_id) return undefined;
  const batch = store.get<RepairModelBatch>(
    "repair_model_batch",
    run.repair_batch_id,
  );
  return batch?.kind;
}

function findOpenBatchId(
  store: Store,
  workflowId: string,
  kind: RepairKind,
): string | undefined {
  const matched = store
    .list<RepairModelBatch>("repair_model_batch", workflowId)
    .find((batch) => batch.status === "open" && batch.kind === kind);
  return matched?.id;
}

function batchForOpenFunctionalIssues(
  store: Store,
  workflowId: string,
): string | undefined {
  const openIds = new Set(
    store
      .list<{ issue_id: string; status: string }>(
        "functional_issue",
        workflowId,
      )
      .filter((issue) => issue.status === "open" || issue.status === "queued")
      .map((issue) => issue.issue_id),
  );
  if (!openIds.size) return undefined;
  const matched = store
    .list<RepairModelBatch>("repair_model_batch", workflowId)
    .filter(
      (batch) =>
        batch.status === "open" &&
        batch.kind === "functional" &&
        batch.issue_ids.some((issueId) => openIds.has(issueId)),
    );
  matched.sort((left, right) =>
    left.created_at < right.created_at
      ? 1
      : left.created_at > right.created_at
        ? -1
        : 0,
  );
  return matched[0]?.id;
}

function freezeDispatchInvocation(
  store: Store,
  profile: ToolProfile,
  flavor: RuntimeFlavor,
): FrozenInvocation {
  const catalog = new ModelCatalogService(store);
  const access = new ModelAccessService(store, { catalog });
  const native = access.resolveNativeConfig(profile);
  const cached = catalog.readCached({
    adapterId: profile.adapterId,
    executablePath: native.executablePath,
    nativeConfigScope: native.nativeConfigScope,
    accountFingerprint: native.accountFingerprint,
    providerFingerprint: native.providerEndpointFingerprint,
  });
  const catalogEntry = entryForProfile(cached, profile);
  return buildFrozenInvocation(
    profile,
    catalogEntry,
    selectionCapabilityFromCatalog(cached, catalogEntry),
    native,
    flavor,
  );
}

function entryForProfile(
  catalog: ModelCatalog | undefined,
  profile: ToolProfile,
): ModelEntry | undefined {
  const wanted = profile.modelId?.trim();
  if (!catalog || !wanted) return undefined;
  return catalog.entries.find(
    (entry) =>
      entry.nativeId === wanted ||
      entry.accessModelKey === wanted ||
      entry.entryId === wanted,
  );
}

export function frozenInvocationFromProfile(
  profile: ToolProfile,
  flavor: RuntimeFlavor,
): FrozenInvocation {
  const reasoning = profile.reasoning ?? { mode: "native-default" as const };
  const effort = effortPartsFromProfile(
    profile,
    reasoning.mode === "explicit" ? reasoning.value : undefined,
  );
  return {
    schema_version: 1,
    adapterId: profile.adapterId,
    executable: profile.executableRef ?? profile.adapterId,
    modelToken: profile.modelId ?? null,
    effortArgs: effort.effortArgs,
    effortEnv: effort.effortEnv,
    transport: effort.transport,
    reasoning,
    ...(profile.nativeConfigProfile
      ? { nativeConfigProfile: profile.nativeConfigProfile }
      : {}),
    providerScope: profile.providerConfigRef ?? profile.adapterId,
    accountScope: profile.nativeConfigProfile ?? "default",
    identityConfidence: "profile-scope",
    capabilityRevision: "run-profile",
    runtimeFlavor: flavor,
    accessModelKey: profile.modelId ?? profile.adapterId,
  };
}

function effortPartsFromProfile(
  profile: ToolProfile,
  explicit?: string,
): {
  effortArgs: string[];
  effortEnv: Record<string, string>;
  transport: FrozenInvocation["transport"];
} {
  if (!explicit) {
    return { effortArgs: [], effortEnv: {}, transport: "none" };
  }
  switch (profile.adapterId) {
    case "agy":
    case "claude-code":
      return {
        effortArgs: ["--effort", explicit],
        effortEnv:
          profile.adapterId === "claude-code"
            ? { CLAUDE_CODE_EFFORT_LEVEL: explicit }
            : {},
        transport: "flag",
      };
    case "codex":
      return {
        effortArgs: ["-c", `model_reasoning_effort="${explicit}"`],
        effortEnv: {},
        transport: "config",
      };
    case "grok-build":
    case "qoder":
      return {
        effortArgs: ["--reasoning-effort", explicit],
        effortEnv: {},
        transport: "flag",
      };
    case "kimi-code":
      return {
        effortArgs: [],
        effortEnv: { KIMI_MODEL_THINKING_EFFORT: explicit },
        transport: "env",
      };
    case "opencode":
      return {
        effortArgs: ["--variant", explicit],
        effortEnv: {},
        transport: "variant-flag",
      };
    default:
      return { effortArgs: [], effortEnv: {}, transport: "none" };
  }
}

export function runLauncherSelection(run: Run) {
  const frozen = run.frozen_invocation;
  const profile = run.profile;
  return {
    executable:
      frozen?.executable ||
      profile?.executableRef ||
      profile?.adapterId ||
      "",
    modelToken: frozen?.modelToken ?? profile?.modelId ?? null,
    effortArgs: frozen?.effortArgs ?? [],
    effortEnv: frozen?.effortEnv ?? {},
    fingerprint: run.invocation_fingerprint,
  };
}

export function conversationMatchesRun(
  stored:
    | {
        id?: string;
        fingerprint?: string;
        family?: string;
      }
    | undefined,
  run: Run,
  family: string,
): boolean {
  if (!stored?.id) return false;
  if (stored.family && stored.family !== family) return false;
  const storedFingerprint = stored.fingerprint;
  const runFingerprint = run.invocation_fingerprint;
  if (storedFingerprint || runFingerprint) {
    return storedFingerprint === runFingerprint;
  }
  return true;
}
export function isLegacyProtocol(run?: Pick<Run, "protocol"> | null, plan?: Plan) {
  if (run?.protocol === "lightweight") return false;
  if (run?.protocol === "legacy") return true;
  return plan ? resolveTaskModel(plan) !== "native-v2" : false;
}
