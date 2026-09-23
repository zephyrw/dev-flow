import { z } from "zod";
import {
  ActiveRunSummarySchema,
  Id,
  RepairModelAssignmentSchema,
  ResumeTargetSchema,
  ResolvedRoleSchema,
  RoleOverridesSchema,
  RoutingRoles,
  ToolProfileSchema,
  inheritRoleOverrides,
  parseStoredToolProfile,
  type RepairModelAssignment,
  type ResolvedRole,
  type ResumeTarget,
  type RoleOverrides,
  type RoutingRole,
  type Run,
  type ToolProfile,
  type Workflow,
} from "../../contracts/src/index.js";
import type { Engine } from "./engine.js";
import type { ExecutionSpecService } from "./execution-spec-service.js";

const TERMINAL_STATES = new Set([
  "COMMITTED",
  "COMPLETED",
  "COMMIT_PARTIAL",
  "CLEANUP_PENDING",
]);

export const SpecTabItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    role: z.string(),
    inheritable: z.boolean(),
    defaultSource: z.enum(["planner", "executor"]).optional(),
  })
  .strict();
export type SpecTabItem = z.infer<typeof SpecTabItemSchema>;

export const HttpExecutionSpecGetResponseSchema = z
  .object({
    workflow_id: Id,
    workflow_version: z.number().int().nonnegative(),
    spec_revision: z.number().int().nonnegative(),
    source: z.enum(["task", "legacy"]),
    spec: z
      .object({
        schema_version: z.literal(2),
        id: z.string(),
        revision: z.number().int().nonnegative(),
        workflow_id: Id,
        plannerProfile: ToolProfileSchema,
        executorProfile: ToolProfileSchema,
        roleOverrides: RoleOverridesSchema,
        template_id: z.string(),
        template_revision: z.number().int().positive(),
        mode: z.enum(["single_tool", "composite"]),
        created_at: z.string().min(1),
        source_defaults_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    resolved_roles: z.record(z.enum(RoutingRoles), ResolvedRoleSchema),
    active_run: ActiveRunSummarySchema.nullable(),
    pending_roles: z.array(z.enum(RoutingRoles)),
    repair_assignments: z.array(RepairModelAssignmentSchema),
    can_edit: z.boolean(),
    resume_target: ResumeTargetSchema.nullable(),
    configured_tabs: z.array(SpecTabItemSchema).optional(),
    active_tab_role: z.string().optional(),
  })
  .strict();

export type HttpExecutionSpecGetResponse = z.infer<
  typeof HttpExecutionSpecGetResponseSchema
>;

function overrideRole(
  role: "reviewer" | "review_fixer" | "functional_fixer",
  specSource: ResolvedRole["source"],
  binding: RoleOverrides[typeof role],
  inherited: ToolProfile,
  inheritedFrom: "planner" | "executor",
): ResolvedRole {
  if (binding.mode === "explicit") {
    return {
      role,
      profile: binding.profile,
      source: specSource === "legacy" ? "legacy" : "task-override",
    };
  }
  return {
    role,
    profile: inherited,
    source: specSource,
    inherited_from: inheritedFrom,
  };
}

export function resolveSpecRoles(
  spec: HttpExecutionSpecGetResponse["spec"],
  persisted: boolean,
): Record<RoutingRole, ResolvedRole> {
  const source: ResolvedRole["source"] = persisted ? "task-base" : "legacy";
  const overrides = spec.roleOverrides ?? inheritRoleOverrides();
  return {
    planner: { role: "planner", profile: spec.plannerProfile, source },
    executor: { role: "executor", profile: spec.executorProfile, source },
    reviewer: overrideRole(
      "reviewer",
      source,
      overrides.reviewer,
      spec.plannerProfile,
      "planner",
    ),
    review_fixer: overrideRole(
      "review_fixer",
      source,
      overrides.review_fixer,
      spec.executorProfile,
      "executor",
    ),
    functional_fixer: overrideRole(
      "functional_fixer",
      source,
      overrides.functional_fixer,
      spec.executorProfile,
      "executor",
    ),
  };
}

function purposeToRole(purpose?: string): RoutingRole {
  if (
    purpose === "planning" ||
    purpose === "planner_takeover" ||
    purpose === "aside"
  ) {
    return "planner";
  }
  if (purpose === "quality_review" || purpose === "diagnose") return "reviewer";
  if (purpose === "functional_fix") return "functional_fixer";
  return "executor";
}

function toActiveRun(
  run: Run | undefined,
): HttpExecutionSpecGetResponse["active_run"] {
  if (!run?.profile) return null;
  const profile = parseStoredToolProfile(run.profile);
  const role = run.routing_role ?? purposeToRole(run.purpose);
  const reasoning = profile.reasoning ?? { mode: "native-default" as const };
  return ActiveRunSummarySchema.parse({
    run_id: run.id,
    role,
    bound_spec_revision: run.execution_spec_revision ?? 0,
    profile,
    requested: {
      adapterId: profile.adapterId,
      modelId: profile.modelId ?? null,
      reasoning,
    },
    observed: run.model_binding?.observed_model
      ? {
          model: run.model_binding.observed_model,
          effort: run.model_binding.observed_effort,
        }
      : null,
  });
}

function pendingRolesFor(
  workflow: Workflow,
  specRevision: number,
  active: HttpExecutionSpecGetResponse["active_run"],
): RoutingRole[] {
  if (!workflow.run_id || !active) return [];
  if (active.bound_spec_revision === specRevision) return [];
  return [active.role];
}

function resumeLabel(purpose: string, stage: string): string {
  if (purpose === "planning" || stage === "planning") return "继续规划";
  if (purpose === "quality_review" || stage.includes("review")) return "继续审查";
  if (purpose === "functional_fix") return "继续修复";
  return "继续开发";
}

function toResumeTarget(
  workflow: Workflow,
  interruption: Record<string, unknown> | undefined,
): ResumeTarget | null {
  if (!["STOPPED", "STOPPING"].includes(workflow.state)) return null;
  const stage = String(interruption?.prior_stage ?? workflow.stage);
  const purpose = String(interruption?.prior_purpose ?? stage);
  return ResumeTargetSchema.parse({
    purpose,
    stage,
    review_phase: interruption?.review_phase,
    repair_batch_id: interruption?.repair_batch_id,
    label: resumeLabel(purpose, stage),
  });
}

export function readResumeTarget(
  engine: Engine,
  workflowId: string,
): ResumeTarget | null {
  const workflow = engine.get(workflowId);
  const interruption = engine.store.get<Record<string, unknown>>(
    "interruption",
    workflowId,
  );
  return toResumeTarget(workflow, interruption);
}

export function buildExecutionSpecResponse(
  engine: Engine,
  workflowId: string,
  specs: ExecutionSpecService,
): HttpExecutionSpecGetResponse {
  const workflow = engine.get(workflowId);
  const view = specs.readView(workflowId);
  const activeRun = workflow.run_id
    ? engine.store.get<Run>("run", workflow.run_id)
    : undefined;
  const active = toActiveRun(activeRun);
  const assignments = engine.store
    .list<RepairModelAssignment>("repair_model_assignment", workflowId)
    .filter((item) => item.status === "pending" || item.status === "active");
  const interruption = engine.store.get<Record<string, unknown>>(
    "interruption",
    workflowId,
  );

  const configuredTabs: SpecTabItem[] = [
    { id: "planner", label: "规划", role: "planner", inheritable: false },
    { id: "executor", label: "执行", role: "executor", inheritable: false },
  ];
  if (workflow.quality_policy_version !== 2 && view.spec.roleOverrides) {
    if (view.spec.roleOverrides.reviewer?.mode === "explicit" || active?.role === "reviewer") {
      configuredTabs.push({
        id: "reviewer",
        label: "代码审查",
        role: "reviewer",
        inheritable: true,
        defaultSource: "planner",
      });
    }
    if (view.spec.roleOverrides.review_fixer?.mode === "explicit" || active?.role === "review_fixer") {
      configuredTabs.push({
        id: "review_fixer",
        label: "审查修复",
        role: "review_fixer",
        inheritable: true,
        defaultSource: "executor",
      });
    }
    if (view.spec.roleOverrides.functional_fixer?.mode === "explicit" || active?.role === "functional_fixer") {
      configuredTabs.push({
        id: "functional_fixer",
        label: "功能修复",
        role: "functional_fixer",
        inheritable: true,
        defaultSource: "executor",
      });
    }
  }

  return HttpExecutionSpecGetResponseSchema.parse({
    workflow_id: workflow.id,
    workflow_version: workflow.version,
    spec_revision: view.spec.revision,
    source: view.source,
    spec: view.spec,
    resolved_roles: resolveSpecRoles(view.spec, view.persisted),
    active_run: active,
    pending_roles: pendingRolesFor(workflow, view.spec.revision, active),
    repair_assignments: assignments,
    can_edit: !TERMINAL_STATES.has(workflow.state),
    resume_target: toResumeTarget(workflow, interruption),
    configured_tabs: configuredTabs,
    active_tab_role: active?.role ?? "planner",
  });
}
