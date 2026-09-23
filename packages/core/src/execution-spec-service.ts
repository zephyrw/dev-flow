import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import type { Config } from "../../contracts/src/config.js";
import {
  FlowError,
  MutationReceiptSchema,
  RoleOverridesSchema,
  ToolProfileSchema,
  inheritRoleOverrides,
  parseStoredExecutionSpec,
  specMode,
  type ExecutionSpec,
  type ExecutionSpecView,
  type MutationReceipt,
  type RoleBinding,
  type RoleOverrides,
  type Run,
  type SemanticProfileSlice,
  type ToolProfile,
  type Workflow,
} from "../../contracts/src/index.js";
import {
  executorProfileFromConfig,
  plannerProfileFromConfig,
} from "./model-defaults-service.js";
import { readEffectiveSpec } from "./run-profile.js";
import { assertProfilesVerified, collectExplicitProfiles, isModelAccessError } from "./access-guard.js";
import { id, now, objectHash } from "./util.js";

const SPEC_KIND = "execution_spec";
const OPERATION_KIND = "model_config_operation";
const TERMINAL_STATES = new Set([
  "COMMITTED",
  "COMPLETED",
  "COMMIT_PARTIAL",
  "CLEANUP_PENDING",
]);
const PLANNER_PURPOSES = new Set([
  "planning",
  "quality_review",
  "planner_takeover",
  "aside",
  "diagnose",
]);
const EXECUTOR_PURPOSES = new Set([
  "implement",
  "functional_fix",
  "plan_self_check",
  "merge_conflict",
]);

export type UpdateExecutionSpecRequest = {
  request_id: string;
  expected_spec_revision: number;
  workflow_id: string;
  planner_profile: ToolProfile;
  executor_profile: ToolProfile;
  role_overrides: RoleOverrides;
  accessVerified?: boolean;
  expected_version?: unknown;
};

type SpecOperation = {
  id: string;
  operation_type: "save_spec";
  entity_id: string;
  request_id: string;
  request_hash: string;
  status: "prepared" | "awaiting_access" | "ready" | "committed" | "rejected";
  receipt?: MutationReceipt;
  created_at: string;
  updated_at: string;
};

type ParsedSpecWrite = {
  request_id: string;
  expected_spec_revision: number;
  workflow_id: string;
  planner_profile: ToolProfile;
  executor_profile: ToolProfile;
  role_overrides: RoleOverrides;
};

function hasOwn(body: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function rejectAmbiguousVersion(req: UpdateExecutionSpecRequest) {
  if (!hasOwn(req, "expected_version")) return;
  throw new FlowError(
    "AMBIGUOUS_VERSION_FIELD",
    "请使用 expected_spec_revision，不要再传 expected_version",
    422,
  );
}

function parseSpecWrite(req: UpdateExecutionSpecRequest): ParsedSpecWrite {
  rejectAmbiguousVersion(req);
  return {
    request_id: z.string().uuid().parse(req.request_id),
    expected_spec_revision: z
      .number()
      .int()
      .nonnegative()
      .parse(req.expected_spec_revision),
    workflow_id: z.string().min(1).parse(req.workflow_id),
    planner_profile: ToolProfileSchema.parse(req.planner_profile),
    executor_profile: ToolProfileSchema.parse(req.executor_profile),
    role_overrides: RoleOverridesSchema.parse(req.role_overrides),
  };
}

function specOperationId(workflowId: string, requestId: string): string {
  return (
    "op-" +
    objectHash({ type: "save_spec", entity: workflowId, requestId })
  ).slice(0, 80);
}

function hashSpecWrite(parsed: ParsedSpecWrite): string {
  return objectHash({
    expected_spec_revision: parsed.expected_spec_revision,
    planner_profile: parsed.planner_profile,
    executor_profile: parsed.executor_profile,
    role_overrides: parsed.role_overrides,
  });
}

function semanticProfileSlice(profile: ToolProfile): SemanticProfileSlice {
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

function semanticRoleBinding(binding: RoleBinding) {
  if (binding.mode === "inherit") return { mode: "inherit" as const };
  return {
    mode: "explicit" as const,
    profile: semanticProfileSlice(binding.profile),
  };
}

function semanticSpecHash(input: {
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  roleOverrides: RoleOverrides;
}): string {
  return objectHash({
    planner: semanticProfileSlice(input.plannerProfile),
    executor: semanticProfileSlice(input.executorProfile),
    roleOverrides: {
      reviewer: semanticRoleBinding(input.roleOverrides.reviewer),
      review_fixer: semanticRoleBinding(input.roleOverrides.review_fixer),
      functional_fixer: semanticRoleBinding(input.roleOverrides.functional_fixer),
    },
  });
}

function latestByStart(runs: Run[]): Run | undefined {
  return [...runs].sort((a, b) =>
    a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0,
  )[0];
}

function profileFromRuns(runs: Run[], purposes: Set<string>): ToolProfile | undefined {
  const matched = runs.filter(
    (run) => run.profile && run.purpose && purposes.has(run.purpose),
  );
  return latestByStart(matched)?.profile;
}

function assertSameHash(prior: SpecOperation, requestHash: string) {
  if (prior.request_hash === requestHash) return;
  throw new FlowError(
    "IDEMPOTENCY_CONFLICT",
    "同一请求不能修改为不同内容",
    409,
  );
}

export class ExecutionSpecService {
  constructor(
    private store: Store,
    private config?: Config,
  ) {}

  /**
   * 无持久化 spec 时返回 revision=0 的兼容视图，不写库。
   * persisted spec 的 revision 始终 > 0。
   */
  readView(workflowId: string): ExecutionSpecView {
    if (this.config) {
      return readEffectiveSpec(this.store, this.config, workflowId);
    }
    const persisted = this.latestPersisted(workflowId);
    if (persisted) {
      return { persisted: true, source: "task", spec: persisted };
    }
    return {
      persisted: false,
      source: "legacy",
      spec: this.buildLegacySpec(workflowId),
    };
  }

  getLatestSpec(workflowId: string): ExecutionSpecView["spec"] {
    return this.readView(workflowId).spec;
  }

  getSpecByRevision(workflowId: string, revision: number): ExecutionSpec {
    const matched = this.listPersisted(workflowId).find(
      (spec) => spec.revision === revision,
    );
    if (!matched) {
      throw new FlowError(
        "SPEC_REVISION_NOT_FOUND",
        `未找到执行配置修订版本 r${revision}`,
        404,
      );
    }
    return matched;
  }

  updateExecutionSpec(req: UpdateExecutionSpecRequest): MutationReceipt {
    const parsed = parseSpecWrite(req);
    const operationId = specOperationId(parsed.workflow_id, parsed.request_id);
    const requestHash = hashSpecWrite(parsed);
    const prior = this.store.get<SpecOperation>(OPERATION_KIND, operationId);
    if (prior) {
      assertSameHash(prior, requestHash);
      if (prior.status === "committed" && prior.receipt) {
        return MutationReceiptSchema.parse(prior.receipt);
      }
    }
    const workflow = this.requireWorkflow(parsed.workflow_id);
    this.assertEditable(workflow);
    this.assertExpectedRevision(parsed.workflow_id, parsed.expected_spec_revision);
    const currentView = this.readView(parsed.workflow_id);
    const currentSpec = currentView.spec;
    const candidates = collectExplicitProfiles(
      parsed.planner_profile,
      parsed.executor_profile,
      parsed.role_overrides,
    );
    const changedProfiles = candidates.filter((candidate) => {
      if (
        !this.isSameProfile(candidate, currentSpec.plannerProfile) &&
        !this.isSameProfile(candidate, currentSpec.executorProfile) &&
        !Object.values(currentSpec.roleOverrides ?? {}).some(
          (o) => o.mode === "explicit" && this.isSameProfile(candidate, o.profile),
        )
      ) {
        return true;
      }
      return false;
    });
    const profilesToVerify = changedProfiles.length > 0 ? changedProfiles : candidates;
    try {
      assertProfilesVerified(this.store, profilesToVerify);
    } catch (error) {
      if (isModelAccessError(error)) {
        this.recordAwaitingAccess(prior, operationId, parsed, requestHash);
      }
      throw error;
    }
    return this.store.transaction(() =>
      this.commitSpecWrite(parsed, operationId, requestHash, prior),
    );
  }

  private requireWorkflow(workflowId: string): Workflow {
    return this.store.must<Workflow>("workflow", workflowId);
  }

  private assertEditable(workflow: Workflow) {
    if (!TERMINAL_STATES.has(workflow.state)) return;
    throw new FlowError("TASK_TERMINAL", "任务已结束，不能修改配置", 422);
  }

  private assertExpectedRevision(workflowId: string, expected: number) {
    const view = this.readView(workflowId);
    const current = view.persisted ? view.spec.revision : 0;
    if (expected === current) return;
    throw new FlowError("SPEC_VERSION_CONFLICT", "执行配置版本已变化", 409);
  }

  private listPersisted(workflowId: string): ExecutionSpec[] {
    return this.store
      .list<unknown>(SPEC_KIND, workflowId)
      .map((raw) => parseStoredExecutionSpec(raw))
      .sort((a, b) => b.revision - a.revision);
  }

  private latestPersisted(workflowId: string): ExecutionSpec | undefined {
    return this.listPersisted(workflowId)[0];
  }

  private resolveLegacyProfiles(workflowId: string): {
    plannerProfile: ToolProfile;
    executorProfile: ToolProfile;
  } {
    const runs = this.store.list<Run>("run", workflowId);
    return {
      plannerProfile: this.legacyPlannerProfile(runs),
      executorProfile: this.legacyExecutorProfile(runs),
    };
  }

  private legacyPlannerProfile(runs: Run[]): ToolProfile {
    const fromRun = profileFromRuns(runs, PLANNER_PURPOSES);
    if (fromRun) return fromRun;
    return plannerProfileFromConfig(this.config);
  }

  private legacyExecutorProfile(runs: Run[]): ToolProfile {
    const fromRun = profileFromRuns(runs, EXECUTOR_PURPOSES);
    if (fromRun) return fromRun;
    return executorProfileFromConfig(this.config);
  }

  private buildLegacySpec(workflowId: string): ExecutionSpecView["spec"] {
    const { plannerProfile, executorProfile } =
      this.resolveLegacyProfiles(workflowId);
    const roleOverrides = inheritRoleOverrides();
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    return {
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
      created_at: workflow?.created_at ?? now(),
    };
  }

  private recordAwaitingAccess(
    prior: SpecOperation | undefined,
    operationId: string,
    parsed: ParsedSpecWrite,
    requestHash: string,
  ) {
    const record: SpecOperation = {
      id: operationId,
      operation_type: "save_spec",
      entity_id: parsed.workflow_id,
      request_id: parsed.request_id,
      request_hash: requestHash,
      status: "awaiting_access",
      created_at: prior?.created_at ?? now(),
      updated_at: now(),
    };
    this.store.put(OPERATION_KIND, operationId, parsed.workflow_id, record);
  }

  private commitSpecWrite(
    parsed: ParsedSpecWrite,
    operationId: string,
    requestHash: string,
    prior: SpecOperation | undefined,
  ): MutationReceipt {
    const existing = this.store.get<SpecOperation>(OPERATION_KIND, operationId);
    if (existing) {
      assertSameHash(existing, requestHash);
      if (existing.status === "committed" && existing.receipt) {
        return MutationReceiptSchema.parse(existing.receipt);
      }
    }
    const workflow = this.requireWorkflow(parsed.workflow_id);
    this.assertEditable(workflow);
    const view = this.readView(parsed.workflow_id);
    const currentRevision = view.persisted ? view.spec.revision : 0;
    if (parsed.expected_spec_revision !== currentRevision) {
      throw new FlowError("SPEC_VERSION_CONFLICT", "执行配置版本已变化", 409);
    }
    const nextProfiles = {
      plannerProfile: parsed.planner_profile,
      executorProfile: parsed.executor_profile,
      roleOverrides: parsed.role_overrides,
    };
    if (
      view.persisted &&
      semanticSpecHash(view.spec) === semanticSpecHash(nextProfiles)
    ) {
      return this.finishNoOp(
        parsed,
        operationId,
        requestHash,
        prior ?? existing,
        view.spec.revision,
        workflow,
      );
    }
    return this.persistNewRevision(
      parsed,
      operationId,
      requestHash,
      prior ?? existing,
      view,
      nextProfiles,
      workflow,
    );
  }

  private finishNoOp(
    parsed: ParsedSpecWrite,
    operationId: string,
    requestHash: string,
    prior: SpecOperation | undefined,
    revision: number,
    workflow: Workflow,
  ): MutationReceipt {
    const receipt = MutationReceiptSchema.parse({
      operation_id: operationId,
      request_id: parsed.request_id,
      status: "committed",
      entity_revision: revision,
      changed: false,
      effective_from: "next-run",
      current_run_id: workflow.run_id ?? null,
      pending_roles: [],
    });
    this.putCommittedOperation(
      operationId,
      parsed,
      requestHash,
      prior,
      receipt,
    );
    return receipt;
  }

  private persistNewRevision(
    parsed: ParsedSpecWrite,
    operationId: string,
    requestHash: string,
    prior: SpecOperation | undefined,
    view: ExecutionSpecView,
    nextProfiles: {
      plannerProfile: ToolProfile;
      executorProfile: ToolProfile;
      roleOverrides: RoleOverrides;
    },
    workflow: Workflow,
  ): MutationReceipt {
    const nextRevision = (view.persisted ? view.spec.revision : 0) + 1;
    const newSpec = parseStoredExecutionSpec({
      schema_version: 2,
      id: id("spec"),
      revision: nextRevision,
      workflow_id: parsed.workflow_id,
      plannerProfile: nextProfiles.plannerProfile,
      executorProfile: nextProfiles.executorProfile,
      roleOverrides: nextProfiles.roleOverrides,
      template_id: view.spec.template_id,
      template_revision: view.spec.template_revision,
      mode: specMode(nextProfiles),
      created_at: now(),
    });
    this.store.put(SPEC_KIND, newSpec.id, parsed.workflow_id, newSpec);
    this.store.event(
      parsed.workflow_id,
      workflow.project_id,
      "execution_spec_updated",
      {
        spec_id: newSpec.id,
        revision: newSpec.revision,
        previous_revision: view.persisted ? view.spec.revision : 0,
      },
    );
    const receipt = MutationReceiptSchema.parse({
      operation_id: operationId,
      request_id: parsed.request_id,
      status: "committed",
      entity_revision: newSpec.revision,
      changed: true,
      effective_from: "next-run",
      current_run_id: workflow.run_id ?? null,
      pending_roles: this.pendingRoles(view, nextProfiles, workflow),
    });
    this.putCommittedOperation(
      operationId,
      parsed,
      requestHash,
      prior,
      receipt,
    );
    return receipt;
  }

  private isSameProfile(a?: ToolProfile, b?: ToolProfile): boolean {
    if (!a || !b) return a === b;
    return objectHash(semanticProfileSlice(a)) === objectHash(semanticProfileSlice(b));
  }

  private pendingRoles(
    view: ExecutionSpecView,
    nextProfiles: {
      plannerProfile: ToolProfile;
      executorProfile: ToolProfile;
      roleOverrides: RoleOverrides;
    },
    workflow: Workflow,
  ): string[] {
    if (!workflow.run_id) return [];
    const roles: string[] = [];
    if (
      objectHash(semanticProfileSlice(view.spec.plannerProfile)) !==
      objectHash(semanticProfileSlice(nextProfiles.plannerProfile))
    ) {
      roles.push("planner");
    }
    if (
      objectHash(semanticProfileSlice(view.spec.executorProfile)) !==
      objectHash(semanticProfileSlice(nextProfiles.executorProfile))
    ) {
      roles.push("executor");
    }
    for (const role of ["reviewer", "review_fixer", "functional_fixer"] as const) {
      if (
        objectHash(semanticRoleBinding(view.spec.roleOverrides[role])) !==
        objectHash(semanticRoleBinding(nextProfiles.roleOverrides[role]))
      ) {
        roles.push(role);
      }
    }
    return roles;
  }

  private putCommittedOperation(
    operationId: string,
    parsed: ParsedSpecWrite,
    requestHash: string,
    prior: SpecOperation | undefined,
    receipt: MutationReceipt,
  ) {
    const record: SpecOperation = {
      id: operationId,
      operation_type: "save_spec",
      entity_id: parsed.workflow_id,
      request_id: parsed.request_id,
      request_hash: requestHash,
      status: "committed",
      receipt,
      created_at: prior?.created_at ?? now(),
      updated_at: now(),
    };
    this.store.put(OPERATION_KIND, operationId, parsed.workflow_id, record);
  }
}
