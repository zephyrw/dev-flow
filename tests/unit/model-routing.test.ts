import { describe, expect, it } from "vitest";
import { setup } from "../helpers.js";
import {
  inheritRoleOverrides,
  parseStoredExecutionSpec,
  parseStoredToolProfile,
  ToolProfileSchema,
  type RoleOverrides,
  type ToolProfile,
} from "../../packages/contracts/src/execution-spec.js";
import type {
  DispatchContext,
  RepairModelAssignment,
} from "../../packages/contracts/src/model-routing.js";
import type { Run } from "../../packages/contracts/src/index.js";
import {
  bindProfile,
  profileForRun,
  readEffectiveSpec,
  resolveRoutingPreview,
  resolveRoutingRole,
  semanticSpecHash,
} from "../../packages/core/src/run-profile.js";
import type { Store } from "../../packages/store/src/store.js";
import type { Config } from "../../packages/contracts/src/config.js";

function makeProfile(
  id: string,
  adapterId: "codex" | "agy",
  modelId: string,
  extra: Record<string, unknown> = {},
): ToolProfile {
  return ToolProfileSchema.parse({
    id,
    adapterId,
    modelSelection: "explicit",
    modelId,
    ...extra,
  });
}

function putSpec(
  store: Store,
  workflowId: string,
  revision: number,
  planner: ToolProfile,
  executor: ToolProfile,
  overrides?: RoleOverrides,
) {
  const spec = parseStoredExecutionSpec({
    schema_version: 2,
    id: "spec" + revision,
    revision,
    workflow_id: workflowId,
    plannerProfile: planner,
    executorProfile: executor,
    roleOverrides: overrides ?? inheritRoleOverrides(),
    created_at: "2026-09-18T00:00:00.000Z",
  });
  store.put("execution_spec", spec.id, workflowId, spec);
  return spec;
}

function putAssignment(
  store: Store,
  workflowId: string,
  batchId: string,
  profile: ToolProfile,
  status: RepairModelAssignment["status"] = "active",
) {
  const assignment: RepairModelAssignment = {
    id: "asg1",
    revision: 1,
    workflow_id: workflowId,
    batch_id: batchId,
    kind: "quality",
    issue_ids: ["i1"],
    profile,
    status,
    created_at: "2026-09-18T00:00:00.000Z",
    created_by: "human",
  };
  store.put("repair_model_assignment", assignment.id, workflowId, assignment);
  return assignment;
}

function putRun(
  store: Store,
  workflowId: string,
  run: Partial<Run> & Pick<Run, "id" | "profile">,
) {
  const record: Run = {
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: run.profile!.adapterId,
    purpose: "implement",
    stage: "execute",
    status: "completed",
    started_at: "2026-09-18T00:00:00.000Z",
    package_hash: "pkg",
    ...run,
  };
  store.put("run", record.id, workflowId, record);
  return record;
}

function preview(
  store: Store,
  config: Config,
  workflowId: string,
  context: DispatchContext,
) {
  return resolveRoutingPreview(store, config, workflowId, context);
}

describe("模型路由与配置解析", () => {
  it("UT-M01：无 reasoning 的旧 Profile 可读，且不伪造 explicit effort", () => {
    const parsed = parseStoredToolProfile({
      id: "profile-agy",
      adapterId: "agy",
      modelSelection: "explicit",
      modelId: "gemini-3.7-flash-high",
    });
    expect(parsed.modelId).toBe("gemini-3.7-flash-high");
    expect(parsed.reasoning).toBeUndefined();
    const { store } = setup();
    const run = putRun(store, "wf-m01", {
      id: "run-m01",
      profile: parsed,
    });
    const fromRun = profileForRun(store, run);
    expect(fromRun.reasoning).toBeUndefined();
    expect(fromRun.reasoning).not.toEqual({ mode: "explicit", value: "high" });
  });

  it("UT-M02：explicit 且 modelId 空 → schema 拒绝", () => {
    const result = ToolProfileSchema.safeParse({
      id: "profile-empty",
      adapterId: "agy",
      modelSelection: "explicit",
      modelId: "",
    });
    expect(result.success).toBe(false);
  });

  it("UT-M03：未白名单 options → 拒绝（不要静默忽略）", () => {
    const result = ToolProfileSchema.safeParse({
      id: "profile-opts",
      adapterId: "agy",
      modelSelection: "explicit",
      modelId: "gemini-3.7-flash-high",
      options: { prefixArgs: ["--quiet"], temperature: 0.2 },
    });
    expect(result.success).toBe(false);
  });

  it("UT-M04：reviewer inherit，planner A 改 B → reviewer 解析为 B", () => {
    const { store, config } = setup();
    const workflowId = "wf-m04";
    const plannerA = makeProfile("planner-a", "codex", "gpt-5.5");
    const plannerB = makeProfile("planner-b", "codex", "gpt-6-astra");
    const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
    putSpec(store, workflowId, 1, plannerA, executor);
    putSpec(store, workflowId, 2, plannerB, executor);
    const resolved = preview(store, config, workflowId, {
      purpose: "quality_review",
      review_phase: "before_human",
    });
    expect(resolved.routing_role).toBe("reviewer");
    expect(resolved.inherited_from).toBe("planner");
    expect(resolved.profile.modelId).toBe("gpt-6-astra");
    expect(resolved.routing_source).toBe("task-base");
  });

  it("UT-M05：reviewer 显式 C 保持；inherit 改 explicit 同值时 semantic hash 变化", () => {
    const { store, config } = setup();
    const workflowId = "wf-m05";
    const plannerA = makeProfile("planner-a", "codex", "gpt-5.5");
    const plannerB = makeProfile("planner-b", "codex", "gpt-6-astra");
    const reviewerC = makeProfile("reviewer-c", "codex", "gpt-5.6-sol");
    const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
    const explicitC: RoleOverrides = {
      ...inheritRoleOverrides(),
      reviewer: { mode: "explicit", profile: reviewerC },
    };
    putSpec(store, workflowId, 1, plannerA, executor, explicitC);
    putSpec(store, workflowId, 2, plannerB, executor, explicitC);
    const resolved = preview(store, config, workflowId, {
      purpose: "quality_review",
      review_phase: "after_human",
    });
    expect(resolved.profile.modelId).toBe("gpt-5.6-sol");
    expect(resolved.routing_source).toBe("task-override");
    const inheritHash = semanticSpecHash({
      plannerProfile: plannerA,
      executorProfile: executor,
      roleOverrides: inheritRoleOverrides(),
    });
    const explicitSameHash = semanticSpecHash({
      plannerProfile: plannerA,
      executorProfile: executor,
      roleOverrides: {
        ...inheritRoleOverrides(),
        reviewer: { mode: "explicit", profile: plannerA },
      },
    });
    expect(explicitSameHash).not.toBe(inheritHash);
  });

  it("UT-M06：同工具不同模型均可保存且解析不混淆", () => {
    const { store, config } = setup();
    const workflowId = "wf-m06";
    const high = makeProfile("agy-high", "agy", "gemini-3.7-flash-high");
    const medium = makeProfile("agy-medium", "agy", "gemini-3.7-flash-medium");
    putSpec(store, workflowId, 1, high, medium);
    const planner = preview(store, config, workflowId, { purpose: "planning" });
    const executor = preview(store, config, workflowId, { purpose: "implement" });
    expect(planner.profile.adapterId).toBe("agy");
    expect(executor.profile.adapterId).toBe("agy");
    expect(planner.profile.modelId).toBe("gemini-3.7-flash-high");
    expect(executor.profile.modelId).toBe("gemini-3.7-flash-medium");
    expect(planner.profile.modelId).not.toBe(executor.profile.modelId);
  });

  describe("表 2.4 用途到角色", () => {
    it("普通开发 → executor", () => {
      expect(resolveRoutingRole({ purpose: "implement" })).toBe("executor");
    });

    it("人工前/后审查 → reviewer", () => {
      expect(
        resolveRoutingRole({
          purpose: "quality_review",
          review_phase: "before_human",
        }),
      ).toBe("reviewer");
      expect(
        resolveRoutingRole({
          purpose: "quality_review",
          review_phase: "after_human",
        }),
      ).toBe("reviewer");
    });

    it("普通整改 → review_fixer", () => {
      expect(
        resolveRoutingRole({
          purpose: "implement",
          repair_kind: "quality",
        }),
      ).toBe("review_fixer");
    });

    it("人工问题修复 → functional_fixer", () => {
      expect(
        resolveRoutingRole({
          purpose: "functional_fix",
          functional_fix_intent: true,
        }),
      ).toBe("functional_fixer");
      expect(
        resolveRoutingRole({
          purpose: "implement",
          functional_fix_intent: true,
        }),
      ).toBe("functional_fixer");
    });

    it("planning / aside / diagnose / plan_self_check / merge_conflict", () => {
      expect(resolveRoutingRole({ purpose: "planning" })).toBe("planner");
      expect(resolveRoutingRole({ purpose: "aside" })).toBe("planner");
      expect(resolveRoutingRole({ purpose: "diagnose" })).toBe("reviewer");
      expect(resolveRoutingRole({ purpose: "plan_self_check" })).toBe(
        "executor",
      );
      expect(resolveRoutingRole({ purpose: "merge_conflict" })).toBe("executor");
    });

    it("遗留 quality 记录时只看本轮 dispatch context", () => {
      const { store, config } = setup();
      const workflowId = "wf-ctx";
      const planner = makeProfile("planner-a", "codex", "gpt-6-astra");
      const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
      putSpec(store, workflowId, 1, planner, executor);
      store.put("repair_assignment", workflowId, workflowId, {
        planner: true,
        source: "quality_review",
        phase: "before_human",
      });
      const functional = preview(store, config, workflowId, {
        purpose: "functional_fix",
        functional_fix_intent: true,
      });
      expect(functional.routing_role).toBe("functional_fixer");
      expect(functional.routing_source).not.toBe("planner-takeover");
      const ordinary = preview(store, config, workflowId, {
        purpose: "implement",
      });
      expect(ordinary.routing_role).toBe("executor");
    });

    it("三次接管均解析为 planner", () => {
      const { store, config } = setup();
      const workflowId = "wf-takeover";
      const planner = makeProfile("planner-a", "codex", "gpt-6-astra");
      const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
      putSpec(store, workflowId, 1, planner, executor);
      store.put("repair_assignment", workflowId, workflowId, {
        planner: true,
        source: "quality_review",
        phase: "before_human",
      });
      const byPurpose = preview(store, config, workflowId, {
        purpose: "planner_takeover",
      });
      const byFlag = preview(store, config, workflowId, {
        purpose: "implement",
        repair_kind: "quality",
        planner_takeover: true,
      });
      const byRecord = preview(store, config, workflowId, {
        purpose: "implement",
        repair_kind: "quality",
      });
      expect(byPurpose.routing_role).toBe("planner");
      expect(byFlag.routing_role).toBe("planner");
      expect(byRecord.routing_role).toBe("planner");
      expect(byPurpose.routing_source).toBe("planner-takeover");
      expect(byFlag.routing_source).toBe("planner-takeover");
      expect(byRecord.routing_source).toBe("planner-takeover");
      expect(byPurpose.profile.modelId).toBe("gpt-6-astra");
    });

    it("接管时人工临时指定 C → source user-repair", () => {
      const { store, config } = setup();
      const workflowId = "wf-user-repair";
      const planner = makeProfile("planner-a", "codex", "gpt-6-astra");
      const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
      const assigned = makeProfile("fixer-c", "agy", "gemini-3.7-flash-medium");
      putSpec(store, workflowId, 1, planner, executor);
      store.put("repair_assignment", workflowId, workflowId, {
        planner: true,
        source: "quality_review",
        phase: "before_human",
      });
      const assignment = putAssignment(
        store,
        workflowId,
        "batch-1",
        assigned,
        "pending",
      );
      const resolved = preview(store, config, workflowId, {
        purpose: "implement",
        repair_kind: "quality",
        repair_batch_id: "batch-1",
        planner_takeover: true,
      });
      expect(resolved.routing_source).toBe("user-repair");
      expect(resolved.profile.modelId).toBe("gemini-3.7-flash-medium");
      expect(resolved.assignment_id).toBe(assignment.id);
      expect(store.get("repair_assignment", workflowId)).toMatchObject({
        planner: true,
      });
    });

    it("修改 reviewer 不影响正在修复者", () => {
      const { store, config } = setup();
      const workflowId = "wf-reviewer-isolate";
      const plannerA = makeProfile("planner-a", "codex", "gpt-5.5");
      const plannerB = makeProfile("planner-b", "codex", "gpt-6-astra");
      const reviewerC = makeProfile("reviewer-c", "codex", "gpt-5.6-sol");
      const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
      putSpec(store, workflowId, 1, plannerA, executor);
      store.put("repair_assignment", workflowId, workflowId, {
        planner: true,
        source: "quality_review",
        phase: "before_human",
      });
      const repairBefore = preview(store, config, workflowId, {
        purpose: "implement",
        repair_kind: "quality",
      });
      putSpec(store, workflowId, 2, plannerB, executor, {
        ...inheritRoleOverrides(),
        reviewer: { mode: "explicit", profile: reviewerC },
      });
      const repairAfter = preview(store, config, workflowId, {
        purpose: "implement",
        repair_kind: "quality",
      });
      const nextReview = preview(store, config, workflowId, {
        purpose: "quality_review",
        review_phase: "before_human",
      });
      expect(repairBefore.routing_role).toBe("planner");
      expect(repairAfter.routing_role).toBe("planner");
      expect(repairAfter.profile.modelId).toBe("gpt-6-astra");
      expect(repairAfter.profile.modelId).not.toBe("gpt-5.6-sol");
      expect(nextReview.routing_role).toBe("reviewer");
      expect(nextReview.profile.modelId).toBe("gpt-5.6-sol");
    });

    it("merge_conflict 复用关联 run 的 routing_role", () => {
      const { store, config } = setup();
      const workflowId = "wf-merge";
      const planner = makeProfile("planner-a", "codex", "gpt-6-astra");
      const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
      const fixer = makeProfile("fixer-a", "agy", "gemini-3.7-flash-medium");
      putSpec(store, workflowId, 1, planner, executor);
      putRun(store, workflowId, {
        id: "run-fix",
        purpose: "implement",
        profile: fixer,
        routing_role: "review_fixer",
        routing_source: "task-base",
      });
      const resolved = preview(store, config, workflowId, {
        purpose: "merge_conflict",
        associated_run_id: "run-fix",
      });
      expect(resolved.routing_role).toBe("review_fixer");
      expect(resolved.profile.modelId).toBe("gemini-3.7-flash-medium");
    });
  });

  it("旧任务无 spec → revision=0 persisted false", () => {
    const { store, config } = setup();
    const view = readEffectiveSpec(store, config, "wf-legacy");
    expect(view.persisted).toBe(false);
    expect(view.source).toBe("legacy");
    expect(view.spec.revision).toBe(0);
    expect(view.spec.plannerProfile.adapterId).toBe("codex");
    expect(view.spec.plannerProfile.modelId).toBe(config.models.reviewer);
    expect(view.spec.executorProfile.adapterId).toBe("agy");
    expect(view.spec.executorProfile.modelId).toBe(config.models.executor);
    const reviewerRun = putRun(store, "wf-legacy-review", {
      id: "run-review",
      purpose: "quality_review",
      profile: makeProfile("codex-review", "codex", "codex-auto-review"),
      started_at: "2026-09-18T02:00:00.000Z",
    });
    const projected = readEffectiveSpec(store, config, "wf-legacy-review");
    expect(projected.spec.plannerProfile.modelId).not.toBe(
      reviewerRun.profile?.modelId,
    );
    expect(projected.spec.plannerProfile.modelId).toBe(config.models.reviewer);
  });

  it("retry 复用原 Run，不读最新角色", () => {
    const { store, config } = setup();
    const workflowId = "wf-retry";
    const planner = makeProfile("planner-a", "codex", "gpt-5.5");
    const executorA = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
    const executorB = makeProfile("exec-b", "agy", "gemini-3.7-flash-medium");
    putSpec(store, workflowId, 1, planner, executorA);
    putRun(store, workflowId, {
      id: "run-old",
      purpose: "implement",
      profile: executorA,
      routing_role: "executor",
      routing_source: "task-base",
      execution_spec_id: "spec1",
      execution_spec_revision: 1,
      logical_round_id: "round-old",
    });
    putSpec(store, workflowId, 2, planner, executorB);
    const latest = preview(store, config, workflowId, { purpose: "implement" });
    expect(latest.profile.modelId).toBe("gemini-3.7-flash-medium");
    const retried = preview(store, config, workflowId, {
      purpose: "implement",
      retry_run_id: "run-old",
    });
    expect(retried.routing_source).toBe("retry");
    expect(retried.routing_role).toBe("executor");
    expect(retried.profile.modelId).toBe("gemini-3.7-flash-high");
    expect(retried.logical_round_id).toBe("round-old");
    expect(retried.execution_spec_revision).toBe(1);
  });

  it("bindProfile 只传 purpose 仍可用，且 effort 大小写参与 semantic hash", () => {
    const { store, config } = setup();
    const workflowId = "wf-bind";
    const plannerLow = makeProfile("planner-low", "codex", "gpt-6-astra", {
      reasoning: { mode: "explicit", value: "high" },
    });
    const plannerHigh = makeProfile("planner-high", "codex", "gpt-6-astra", {
      reasoning: { mode: "explicit", value: "High" },
    });
    const executor = makeProfile("exec-a", "agy", "gemini-3.7-flash-high");
    putSpec(store, workflowId, 1, plannerLow, executor);
    const binding = bindProfile(store, config, workflowId, "planning");
    expect(binding.purpose).toBe("planning");
    expect(binding.profile.modelId).toBe("gpt-6-astra");
    expect(binding.routing_role).toBe("planner");
    expect(binding.routing_source).toBe("task-base");
    expect(binding.execution_spec_revision).toBe(1);
    expect(binding.logical_round_id).toMatch(/^round-/);
    expect(
      semanticSpecHash({
        plannerProfile: plannerLow,
        executorProfile: executor,
        roleOverrides: inheritRoleOverrides(),
      }),
    ).not.toBe(
      semanticSpecHash({
        plannerProfile: plannerHigh,
        executorProfile: executor,
        roleOverrides: inheritRoleOverrides(),
      }),
    );
  });
});
