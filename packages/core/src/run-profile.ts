import type { Store } from "../../store/src/store.js";
import type { Config } from "../../contracts/src/config.js";
import {
  requireCondition,
  resolveTaskModel,
  type Plan,
  type Run,
} from "../../contracts/src/index.js";
import {
  ExecutionSpecSchema,
  SupportedAdapters,
  ToolProfileSchema,
  type ToolProfile,
  type ExecutionSpec,
} from "../../contracts/src/execution-spec.js";

export type RunPurpose =
  | "planning"
  | "implement"
  | "plan_self_check"
  | "quality_review"
  | "planner_takeover"
  | "functional_fix"
  | "aside"
  | "merge_conflict";
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
    .list<ExecutionSpec>("execution_spec", workflowId)
    .sort((a, b) => b.revision - a.revision)[0];
  return spec && ExecutionSpecSchema.parse(spec);
}
export function bindProfile(
  store: Store,
  config: Config,
  workflowId: string,
  purpose: RunPurpose,
) {
  const spec = latestSpec(store, workflowId);
  const isTakeover =
    store.get<{ planner: boolean }>("repair_assignment", workflowId)?.planner ===
    true;
  const planner =
    ["planning", "quality_review", "planner_takeover", "aside"].includes(
      purpose,
    ) ||
    ((purpose === "plan_self_check" || purpose === "merge_conflict") &&
      isTakeover);
  const profile: ToolProfile = spec
    ? planner
      ? spec.plannerProfile
      : spec.executorProfile
    : ToolProfileSchema.parse({
        id: planner ? "legacy-planner" : "legacy-executor",
        adapterId: planner ? "codex" : "agy",
        executableRef: planner
          ? config.models.codex_executable
          : config.models.agy_executable,
        modelSelection: "explicit",
        modelId: planner ? config.models.reviewer : config.models.executor,
      });
  return { purpose, execution_spec_id: spec?.id, profile };
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
  return ToolProfileSchema.parse(run.profile);
}
export function isLegacyProtocol(run?: Pick<Run, "protocol"> | null, plan?: Plan) {
  if (run?.protocol === "lightweight") return false;
  if (run?.protocol === "legacy") return true;
  return plan ? resolveTaskModel(plan) !== "native-v2" : false;
}
