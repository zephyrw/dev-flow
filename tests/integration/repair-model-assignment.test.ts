import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setup } from "../helpers.js";
import { now } from "../../packages/core/src/util.js";
import {
  FlowError,
  inheritRoleOverrides,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import {
  bindRepairAssignment,
  ensureQualityRepairBatch,
  RepairModelService,
} from "../../packages/core/src/repair-model-service.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { FunctionalIssueService } from "../../packages/core/src/functional-issues.js";
import {
  bindProfile,
  buildDispatchContext,
} from "../../packages/core/src/run-profile.js";

let closeStore: (() => void) | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  closeStore?.();
  closeStore = undefined;
});

function planner(modelId = "gpt-6-astra"): ToolProfile {
  return {
    id: "planner",
    revision: 1,
    adapterId: "codex",
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}

function executor(modelId = "gemini-3.7-flash-high"): ToolProfile {
  return {
    id: "executor",
    revision: 1,
    adapterId: "agy",
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}

function cursorGrok(): ToolProfile {
  return {
    id: "cursor-fixer",
    revision: 1,
    adapterId: "cursor-agent",
    modelSelection: "explicit",
    modelId: "cursor-grok-4.6-high",
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}

function openRepair(workflowId: string, init?: Partial<Workflow>) {
  const env = setup();
  closeStore = () => env.store.close();
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: "修复指派",
    request: "修复问题",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "HUMAN_PENDING",
    stage: "functional_retest",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
    ...init,
  };
  env.store.put("workflow", workflowId, workflow.project_id, workflow);
  const spec = {
    schema_version: 2 as const,
    id: "spec-r1",
    revision: 1,
    workflow_id: workflowId,
    plannerProfile: planner(),
    executorProfile: executor(),
    roleOverrides: inheritRoleOverrides(),
    template_id: "native-development",
    template_revision: 3,
    mode: "composite" as const,
    created_at: now(),
  };
  env.store.put("execution_spec", spec.id, workflowId, spec);
  seedVerifiedAccess(env.store, planner());
  seedVerifiedAccess(env.store, executor());
  seedVerifiedAccess(env.store, cursorGrok());
  const specs = new ExecutionSpecService(env.store, env.config);
  const repairs = new RepairModelService(env.store, specs);
  return { ...env, workflow, repairs, specs };
}

function expectCode(run: () => unknown, code: string) {
  try {
    run();
    expect.unreachable("应当抛出 " + code);
  } catch (error) {
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).code).toBe(code);
  }
}

it("IT-F01：人工反馈不选处理者时使用 functional_fixer 默认", () => {
  const env = openRepair("wf-f01");
  const result = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "按钮无响应" }],
    selection: { mode: "task-default" },
    expected_spec_revision: 1,
  });
  expect(result.assignment).toBeUndefined();
  env.store.put("functional_fix_intent", env.workflow.id, env.workflow.id, {
    source: "test",
  });
  const context = buildDispatchContext(
    env.store,
    env.workflow.id,
    "implement",
  );
  const binding = bindProfile(
    env.store,
    env.config,
    env.workflow.id,
    "implement",
    context,
  );
  expect(binding.routing_role).toBe("functional_fixer");
  expect(binding.routing_source).toBe("task-base");
  expect(binding.profile.modelId).toBe("gemini-3.7-flash-high");
});

it("IT-F02：选择规划配置时复制当时 Profile，后续基础槽改变不暗改", () => {
  const env = openRepair("wf-f02");
  const result = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "规划处理" }],
    selection: { mode: "planner" },
    expected_spec_revision: 1,
  });
  expect(result.assignment?.profile.modelId).toBe("gpt-6-astra");
  seedVerifiedAccess(env.store, planner("gpt-changed"));
  env.specs.updateExecutionSpec({
    request_id: randomUUID(),
    workflow_id: env.workflow.id,
    expected_spec_revision: 1,
    planner_profile: planner("gpt-changed"),
    executor_profile: executor(),
    role_overrides: inheritRoleOverrides(),
    accessVerified: true,
  });
  env.store.put("functional_fix_intent", env.workflow.id, env.workflow.id, {
    source: "test",
  });
  const binding = bindProfile(
    env.store,
    env.config,
    env.workflow.id,
    "implement",
    buildDispatchContext(env.store, env.workflow.id, "implement"),
  );
  expect(binding.routing_source).toBe("user-repair");
  expect(binding.profile.modelId).toBe("gpt-6-astra");
});

it("IT-F03：选 Cursor/Grok4.6/high 时保存精确 cursor-grok-4.6-high", () => {
  const env = openRepair("wf-f03");
  const result = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "自定义处理者" }],
    selection: { mode: "custom", profile: cursorGrok() },
    expected_spec_revision: 1,
  });
  expect(result.assignment?.profile.modelId).toBe("cursor-grok-4.6-high");
  expect(result.assignment?.profile.adapterId).toBe("cursor-agent");
});

it("IT-F04：修复暂停或失败重试不把指派标为 completed", () => {
  const env = openRepair("wf-f04", { state: "EXECUTING", stage: "execute" });
  const result = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "失败重试" }],
    selection: { mode: "planner" },
    expected_spec_revision: 1,
  });
  bindRepairAssignment(env.store, env.workflow.id, result.assignment!.id);
  const active = env.store
    .list<any>("repair_model_assignment", env.workflow.id)
    .find((item) => item.status === "active");
  expect(active?.id).toBe(result.assignment!.id);
  expect(active?.status).toBe("active");
});

it("IT-F05：ready_for_retest 后人工否决仍使用原指派", () => {
  const env = openRepair("wf-f05");
  const issues = new FunctionalIssueService(env.store);
  const created = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "复测失败" }],
    selection: { mode: "executor" },
    expected_spec_revision: 1,
  });
  const issueId = created.issue_ids[0]!;
  issues.markFixing(env.workflow.id, issueId);
  issues.markReadyForRetest(env.workflow.id, issueId, "del-1");
  issues.userConfirmIssue(env.workflow.id, issueId, false, "仍失败");
  const current = env.store
    .list<any>("repair_model_assignment", env.workflow.id)
    .find((item) => item.status === "pending" || item.status === "active");
  expect(current?.id).toBe(created.assignment!.id);
  expect(current?.status).not.toBe("completed");
});

it("IT-F06：批次全部 issue confirmed 后指派 completed", () => {
  const env = openRepair("wf-f06");
  const issues = new FunctionalIssueService(env.store);
  const created = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "问题一" }, { description: "问题二" }],
    selection: { mode: "executor" },
    expected_spec_revision: 1,
  });
  for (const issueId of created.issue_ids) {
    issues.markFixing(env.workflow.id, issueId);
    issues.markReadyForRetest(env.workflow.id, issueId, "del-1");
    issues.userConfirmIssue(env.workflow.id, issueId, true);
  }
  const assignment = env.store
    .list<any>("repair_model_assignment", env.workflow.id)
    .find((item) => item.id === created.assignment!.id);
  expect(assignment?.status).toBe("completed");
  const batch = env.store.get<any>("repair_model_batch", created.batch.id);
  expect(batch.status).toBe("closed");
});

it("IT-F07：只确认一个 issue 时指派不完成", () => {
  const env = openRepair("wf-f07");
  const issues = new FunctionalIssueService(env.store);
  const created = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "问题一" }, { description: "问题二" }],
    selection: { mode: "executor" },
    expected_spec_revision: 1,
  });
  const first = created.issue_ids[0]!;
  issues.markFixing(env.workflow.id, first);
  issues.markReadyForRetest(env.workflow.id, first, "del-1");
  issues.userConfirmIssue(env.workflow.id, first, true);
  const assignment = env.store
    .list<any>("repair_model_assignment", env.workflow.id)
    .find((item) => item.id === created.assignment!.id);
  expect(assignment?.status).not.toBe("completed");
});

it("IT-F08：临时指定优先于后来修改的基础默认", () => {
  const env = openRepair("wf-f08");
  env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "覆盖默认" }],
    selection: { mode: "custom", profile: cursorGrok() },
    expected_spec_revision: 1,
  });
  seedVerifiedAccess(env.store, executor("new-executor"));
  seedVerifiedAccess(env.store, executor("task-fixer"));
  env.specs.updateExecutionSpec({
    request_id: randomUUID(),
    workflow_id: env.workflow.id,
    expected_spec_revision: 1,
    planner_profile: planner(),
    executor_profile: executor("new-executor"),
    role_overrides: {
      ...inheritRoleOverrides(),
      functional_fixer: { mode: "explicit", profile: executor("task-fixer") },
    },
    accessVerified: true,
  });
  env.store.put("functional_fix_intent", env.workflow.id, env.workflow.id, {
    source: "test",
  });
  const binding = bindProfile(
    env.store,
    env.config,
    env.workflow.id,
    "implement",
    buildDispatchContext(env.store, env.workflow.id, "implement"),
  );
  expect(binding.routing_source).toBe("user-repair");
  expect(binding.profile.modelId).toBe("cursor-grok-4.6-high");
});

it("IT-F09：记住到后续默认时同事务更新，冲突不半成功", () => {
  const env = openRepair("wf-f09");
  expectCode(
    () =>
      env.repairs.submitFunctionalRepair({
        workflow_id: env.workflow.id,
        request_id: randomUUID(),
        descriptions: [{ description: "记住默认" }],
        selection: { mode: "custom", profile: cursorGrok() },
        expected_spec_revision: 9,
        remember_for_task: true,
      }),
    "SPEC_VERSION_CONFLICT",
  );
  expect(env.store.list("functional_issue", env.workflow.id)).toHaveLength(0);
  expect(env.store.list("repair_model_assignment", env.workflow.id)).toHaveLength(
    0,
  );
  env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "记住默认" }],
    selection: { mode: "custom", profile: cursorGrok() },
    expected_spec_revision: 1,
    remember_for_task: true,
  });
  const spec = env.specs.getLatestSpec(env.workflow.id);
  expect(spec.roleOverrides.functional_fixer.mode).toBe("explicit");
  if (spec.roleOverrides.functional_fixer.mode === "explicit") {
    expect(spec.roleOverrides.functional_fixer.profile.modelId).toBe(
      "cursor-grok-4.6-high",
    );
  }
});

it("IT-F10：跨批选择拒绝，质量 batch id 在同链复核中保持稳定", () => {
  const env = openRepair("wf-f10");
  const first = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "批次一" }],
    selection: { mode: "planner" },
    expected_spec_revision: 1,
  });
  const second = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "批次二" }],
    selection: { mode: "executor" },
    expected_spec_revision: 1,
  });
  expect(first.batch.id).not.toBe(second.batch.id);
  expectCode(
    () =>
      env.repairs.submitFunctionalRepair({
        workflow_id: env.workflow.id,
        request_id: randomUUID(),
        issue_ids: [first.issue_ids[0]!, second.issue_ids[0]!],
        selection: { mode: "planner" },
        expected_spec_revision: 1,
      }),
    "REPAIR_BATCH_MISMATCH",
  );
  const firstQuality = ensureQualityRepairBatch(
    env.store,
    env.workflow.id,
    "before_human",
    "rev-a",
  );
  const secondQuality = ensureQualityRepairBatch(
    env.store,
    env.workflow.id,
    "before_human",
    "rev-b",
  );
  expect(secondQuality.id).toBe(firstQuality.id);
  expect(secondQuality.id).not.toBe("rev-b");
  expect(secondQuality.source_review_id).toBe("rev-b");
});

it("IT-F10：两开放批次互不影响，派发只绑定目标 batch", () => {
  const env = openRepair("wf-f10-dispatch");
  const first = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "批次一待复测" }],
    selection: { mode: "planner" },
    expected_spec_revision: 1,
  });
  const issues = new FunctionalIssueService(env.store);
  issues.markFixing(env.workflow.id, first.issue_ids[0]!);
  issues.markReadyForRetest(env.workflow.id, first.issue_ids[0]!, "del-a");
  const second = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "批次二新报" }],
    selection: { mode: "custom", profile: cursorGrok() },
    expected_spec_revision: 1,
  });
  expect(first.batch.id).not.toBe(second.batch.id);
  const intent = env.store.get<{ batch_id?: string }>(
    "functional_fix_intent",
    env.workflow.id,
  );
  expect(intent?.batch_id).toBe(second.batch.id);
  const binding = bindProfile(
    env.store,
    env.config,
    env.workflow.id,
    "implement",
    buildDispatchContext(env.store, env.workflow.id, "implement"),
  );
  expect(binding.repair_batch_id).toBe(second.batch.id);
  expect(binding.profile.modelId).toBe("cursor-grok-4.6-high");
  expect(
    env.store.get<any>("functional_issue", first.issue_ids[0]!).status,
  ).toBe("ready_for_retest");
  const views = env.repairs.issueViews(env.workflow.id);
  expect(views.find((item) => item.issue.issue_id === first.issue_ids[0])?.batch_id).toBe(
    first.batch.id,
  );
  expect(views.find((item) => item.issue.issue_id === second.issue_ids[0])?.batch_id).toBe(
    second.batch.id,
  );
});

it("指定 review_fixer 后续接 plan_self_check 执行者一致", () => {
  const env = openRepair("wf-r14", { state: "QUEUED", stage: "execute" });
  const fixer = cursorGrok();
  env.store.put("execution_spec", "spec-r1", env.workflow.id, {
    ...env.specs.getLatestSpec(env.workflow.id),
    roleOverrides: {
      ...inheritRoleOverrides(),
      review_fixer: { mode: "explicit", profile: fixer },
    },
  });
  env.store.put("run", "run-fix", env.workflow.id, {
    id: "run-fix",
    workflow_id: env.workflow.id,
    plan_revision: 1,
    adapter: "cursor-agent",
    purpose: "implement",
    routing_role: "review_fixer",
    routing_source: "task-override",
    repair_batch_id: "batch-quality",
    profile: fixer,
    frozen_invocation: {
      schema_version: 1,
      adapterId: "cursor-agent",
      executable: "cursor-agent",
      modelToken: "cursor-grok-4.6-high",
      effortArgs: [],
      effortEnv: {},
      transport: "none",
      reasoning: { mode: "explicit", value: "high" },
      providerScope: "cursor-agent",
      accountScope: "default",
      identityConfidence: "profile-scope",
      capabilityRevision: "run-profile",
      runtimeFlavor: "profile-native",
      accessModelKey: "cursor-grok-4.6-high",
    },
    runtime_flavor: "profile-native",
    execution_spec_id: "spec-r1",
    stage: "execute",
    status: "completed",
    started_at: now(),
    package_hash: "pkg",
  });
  env.store.put("executor_plan_check", env.workflow.id, env.workflow.id, {
    source_run_id: "run-fix",
    status: "queued",
  });
  const binding = bindProfile(
    env.store,
    env.config,
    env.workflow.id,
    "plan_self_check",
    buildDispatchContext(env.store, env.workflow.id, "plan_self_check"),
  );
  expect(binding.routing_role).toBe("review_fixer");
  expect(binding.profile.modelId).toBe("cursor-grok-4.6-high");
  expect(binding.repair_batch_id).toBe("batch-quality");
  expect(binding.frozen_invocation?.modelToken).toBe("cursor-grok-4.6-high");
});

it("R07：未验证 profile 不能指派修复模型", () => {
  const env = openRepair("wf-r07-repair");
  expectCode(
    () =>
      env.repairs.submitFunctionalRepair({
        workflow_id: env.workflow.id,
        request_id: randomUUID(),
        descriptions: [{ description: "未验证指派" }],
        selection: {
          mode: "custom",
          profile: planner("never-verified-fixer"),
        },
        expected_spec_revision: 1,
      }),
    "MODEL_ACCESS_REQUIRED",
  );
  expect(env.store.list("repair_model_assignment", env.workflow.id)).toHaveLength(
    0,
  );
});

it("R07：未验证 profile 不能记为任务默认", () => {
  const env = openRepair("wf-r07-remember");
  expectCode(
    () =>
      env.repairs.submitFunctionalRepair({
        workflow_id: env.workflow.id,
        request_id: randomUUID(),
        descriptions: [{ description: "未验证记住" }],
        selection: {
          mode: "custom",
          profile: planner("never-verified-remember"),
        },
        expected_spec_revision: 1,
        remember_for_task: true,
      }),
    "MODEL_ACCESS_REQUIRED",
  );
  const spec = env.specs.getLatestSpec(env.workflow.id);
  expect(spec.revision).toBe(1);
  expect(spec.roleOverrides.functional_fixer.mode).toBe("inherit");
});


it("修复指派成功回执在任务结束或授权变化后仍可重放，同 ID 改内容拒绝", () => {
  const env = openRepair("wf-assignment-replay");
  const batch = ensureQualityRepairBatch(env.store, env.workflow.id, "before_human", "review-1");
  const request = {
    workflow_id: env.workflow.id, request_id: randomUUID(), batch_id: batch.id,
    expected_assignment_revision: 0, expected_spec_revision: 1,
    selection: { mode: "planner" }, remember_for_task: true,
  };
  const first = env.repairs.assign(request);
  env.store.put("workflow", env.workflow.id, env.workflow.project_id, { ...env.workflow, state: "COMPLETED" });
  for (const entry of env.store.entries<any>("model_access", "codex")) env.store.remove("model_access", entry.id);
  expect(env.repairs.assign(request)).toEqual(first);
  expect(env.store.list("repair_model_assignment", env.workflow.id)).toHaveLength(1);
  expect(env.specs.getLatestSpec(env.workflow.id).revision).toBe(2);
  expectCode(() => env.repairs.assign({ ...request, selection: { mode: "executor" } }), "IDEMPOTENCY_CONFLICT");
});

it.each(["quality", "functional"] as const)("记住 %s 批次只更新对应修复角色", (kind) => {
  const env = openRepair("wf-remember-" + kind);
  const batch = kind === "quality"
    ? ensureQualityRepairBatch(env.store, env.workflow.id, "before_human", "review-1")
    : env.repairs.submitFunctionalRepair({ workflow_id: env.workflow.id, request_id: randomUUID(),
        descriptions: [{ description: "功能问题" }], selection: { mode: "task-default" }, expected_spec_revision: 1 }).batch;
  const receipt = env.repairs.assign({ workflow_id: env.workflow.id, request_id: randomUUID(), batch_id: batch.id,
    expected_assignment_revision: 0, expected_spec_revision: 1, selection: { mode: "planner" }, remember_for_task: true });
  const role = kind === "quality" ? "review_fixer" : "functional_fixer";
  const other = kind === "quality" ? "functional_fixer" : "review_fixer";
  const spec = env.specs.getLatestSpec(env.workflow.id);
  expect(spec.roleOverrides[role]).toEqual({ mode: "explicit", profile: planner() });
  expect(spec.roleOverrides[other].mode).toBe("inherit");
  expect(receipt.pending_roles).toEqual([role]);
  expect(env.repairs.listOpenBatches(env.workflow.id)[0]?.inherited_profile).toEqual(planner());
});

it("记住默认的后半步失败时指派、旧状态和操作收据完整回滚", () => {
  const env = openRepair("wf-assignment-rollback");
  const batch = ensureQualityRepairBatch(env.store, env.workflow.id, "before_human", "review-1");
  env.repairs.assign({ workflow_id: env.workflow.id, request_id: randomUUID(), batch_id: batch.id,
    expected_assignment_revision: 0, expected_spec_revision: 1, selection: { mode: "executor" } });
  const before = env.store.list("repair_model_assignment", env.workflow.id);
  const operations = env.store.list("repair_assignment_operation", env.workflow.id);
  vi.spyOn(env.specs, "updateExecutionSpec").mockImplementation(() => { throw new FlowError("SPEC_VERSION_CONFLICT", "injected failure", 409); });
  expectCode(() => env.repairs.assign({ workflow_id: env.workflow.id, request_id: randomUUID(), batch_id: batch.id,
    expected_assignment_revision: 1, expected_spec_revision: 1, selection: { mode: "planner" }, remember_for_task: true }), "SPEC_VERSION_CONFLICT");
  expect(env.store.list("repair_model_assignment", env.workflow.id)).toEqual(before);
  expect(env.store.list("repair_assignment_operation", env.workflow.id)).toEqual(operations);
  expect(env.specs.getLatestSpec(env.workflow.id).revision).toBe(1);
});

it("task-default 加记住仍校验版本，保留当前 functional_fixer 而不是执行基础槽", () => {
  const env = openRepair("wf-default-remember");
  env.store.put("execution_spec", "spec-r1", env.workflow.id, {
    ...env.specs.getLatestSpec(env.workflow.id),
    roleOverrides: { ...inheritRoleOverrides(), functional_fixer: { mode: "explicit", profile: cursorGrok() } },
  });
  const input = { workflow_id: env.workflow.id, request_id: randomUUID(),
    descriptions: [{ description: "默认处理者" }], selection: { mode: "task-default" as const },
    expected_spec_revision: 0, remember_for_task: true };
  expectCode(() => env.repairs.submitFunctionalRepair(input), "SPEC_VERSION_CONFLICT");
  expect(env.store.list("functional_issue", env.workflow.id)).toHaveLength(0);
  expect(env.store.list("repair_model_batch", env.workflow.id)).toHaveLength(0);
  env.repairs.submitFunctionalRepair({ ...input, expected_spec_revision: 1 });
  expect(env.specs.getLatestSpec(env.workflow.id).roleOverrides.functional_fixer)
    .toEqual({ mode: "explicit", profile: cursorGrok() });
  const issue = new FunctionalIssueService(env.store).createIssue(env.workflow.id, "附加反馈", [], { skipAutoBatch: true });
  env.repairs.attachIssueRepair({ workflow_id: env.workflow.id, request_id: randomUUID(), issue,
    repair_model: { mode: "task-default" }, remember_for_task: true,
    expected_spec_revision: env.specs.getLatestSpec(env.workflow.id).revision });
  expect(env.specs.getLatestSpec(env.workflow.id).roleOverrides.functional_fixer)
    .toEqual({ mode: "explicit", profile: cursorGrok() });
});

it("重新指定批次中的部分问题不会移除其余问题，最后处理者读取冻结绑定", () => {
  const env = openRepair("wf-batch-members");
  const created = env.repairs.submitFunctionalRepair({ workflow_id: env.workflow.id, request_id: randomUUID(),
    descriptions: [{ description: "一" }, { description: "二" }], selection: { mode: "planner" }, expected_spec_revision: 1 });
  const changed = env.repairs.submitFunctionalRepair({ workflow_id: env.workflow.id, request_id: randomUUID(),
    issue_ids: [created.issue_ids[0]!], selection: { mode: "executor" }, expected_spec_revision: 1 });
  expect(changed.batch.issue_ids).toEqual(created.issue_ids);
  expect(changed.assignment?.issue_ids).toEqual(created.issue_ids);
  env.store.put("run", "nested-binding-run", env.workflow.id, { id: "nested-binding-run",
    model_binding: { repair_batch_id: created.batch.id }, profile: cursorGrok(), started_at: now() });
  expect(env.repairs.issueViews(env.workflow.id).every((view) => view.last_fixer_profile?.modelId === cursorGrok().modelId)).toBe(true);
});


it("cleared repair assignments never reuse a batch revision", () => {
  const env = openRepair("wf-assignment-clear-cas");
  const created = env.repairs.submitFunctionalRepair({
    workflow_id: env.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "修复处理者并发编辑" }],
    selection: { mode: "planner" },
    expected_spec_revision: 1,
  });
  expect(created.assignment?.revision).toBe(1);
  const request = {
    workflow_id: env.workflow.id,
    batch_id: created.batch.id,
    expected_spec_revision: 1,
  };
  env.repairs.assign({
    ...request,
    request_id: randomUUID(),
    expected_assignment_revision: 1,
    selection: { mode: "task-default" },
  });
  expect(env.repairs.listOpenBatches(env.workflow.id)[0]?.assignment).toBeNull();
  expect(env.repairs.issueViews(env.workflow.id)[0]?.assignment_revision).toBeNull();
  const replacement = env.repairs.assign({
    ...request,
    request_id: randomUUID(),
    expected_assignment_revision: 0,
    selection: { mode: "custom", profile: cursorGrok() },
  });
  expect(replacement.entity_revision).toBe(2);
  const current = env.repairs.listOpenBatches(env.workflow.id)[0]?.assignment;
  expect(current).toMatchObject({ revision: 2, profile: cursorGrok() });
  expect(current?.id).not.toBe(created.assignment?.id);
  expectCode(() => env.repairs.assign({
    ...request,
    request_id: randomUUID(),
    expected_assignment_revision: 1,
    selection: { mode: "executor" },
  }), "REPAIR_BATCH_MISMATCH");
  expect(env.repairs.listOpenBatches(env.workflow.id)[0]?.assignment).toEqual(current);
  expect(env.store.list("repair_model_assignment", env.workflow.id)).toHaveLength(2);
  expect(env.specs.getLatestSpec(env.workflow.id).revision).toBe(1);
});
