import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setup, prepared } from "../helpers.js";
import { now } from "../../packages/core/src/util.js";
import {
  FlowError,
  inheritRoleOverrides,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { ModelSwitchService } from "../../packages/core/src/model-switch-service.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import {
  invocationFingerprintFromProfile,
  permissionCategoryForPurpose,
  bindProfile,
  buildDispatchContext,
  conversationMatchesRun,
} from "../../packages/core/src/run-profile.js";
import {
  conversationLineageKey,
  sessionFamily,
} from "../../packages/runtime/src/profile-runtime.js";
import {
  resolveResumeTarget,
  resumeApproved,
} from "../../packages/runtime/src/recovery.js";
import { BEFORE_HUMAN_REVIEW_STAGE } from "../../packages/core/src/plan-self-check.js";

let closeStore: (() => void) | undefined;

afterEach(() => {
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

function executor(
  modelId = "gemini-3.7-flash-high",
  extra: Partial<ToolProfile> = {},
): ToolProfile {
  return {
    id: extra.id ?? "executor",
    revision: extra.revision ?? 1,
    adapterId: extra.adapterId ?? "agy",
    modelSelection: "explicit",
    modelId,
    reasoning: extra.reasoning ?? { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: extra.options ?? {},
    nativeConfigProfile: extra.nativeConfigProfile,
    executableRef: extra.executableRef,
  };
}

function putSpec(store: ReturnType<typeof setup>["store"], workflowId: string, revision: number, exec = executor()) {
  store.put("execution_spec", "spec-r" + revision, workflowId, {
    schema_version: 2,
    id: "spec-r" + revision,
    revision,
    workflow_id: workflowId,
    plannerProfile: planner(),
    executorProfile: exec,
    roleOverrides: inheritRoleOverrides(),
    template_id: "native-development",
    template_revision: 3,
    mode: "composite",
    created_at: now(),
  });
}

function fingerprintOf(profile: ToolProfile, purpose = "implement") {
  return invocationFingerprintFromProfile(
    profile,
    "wf-session",
    permissionCategoryForPurpose(purpose),
  );
}

it("IT-R08/R09：换模型或 effort 会改变指纹，产生新会话", () => {
  const sameTool = executor("model-a");
  const otherModel = executor("model-b");
  const otherEffort = executor("model-a", {
    reasoning: { mode: "explicit", value: "xhigh" },
  });
  expect(fingerprintOf(sameTool)).not.toBe(fingerprintOf(otherModel));
  expect(fingerprintOf(sameTool)).not.toBe(fingerprintOf(otherEffort));
});

it("IT-R10/R11：实际参数不变或只改 label/revision 时指纹相同", () => {
  const base = executor("model-a", { id: "exec-a", revision: 1 });
  const relabeled = executor("model-a", { id: "exec-renamed", revision: 9 });
  expect(fingerprintOf(base)).toBe(fingerprintOf(relabeled));
});

it("IT-R12：A→B→A 只续最近会话，不翻出旧 A", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const family = sessionFamily("implement", "run-1");
  const key = conversationLineageKey("wf-session", family);
  const a = fingerprintOf(executor("model-a"));
  const b = fingerprintOf(executor("model-b"));
  env.store.put("native_conversation", key, "wf-session", {
    id: "conv-a-old",
    fingerprint: a,
    run_id: "run-a",
  });
  env.store.put("native_conversation", key, "wf-session", {
    id: "conv-b",
    fingerprint: b,
    run_id: "run-b",
  });
  const latest = env.store.get<{ id: string; fingerprint: string }>(
    "native_conversation",
    key,
  );
  expect(latest?.id).toBe("conv-b");
  expect(latest?.fingerprint).not.toBe(a);
});

it("审查会话按轮次隔离，规划与执行隔离", () => {
  expect(sessionFamily("quality_review", "run-1")).not.toBe(
    sessionFamily("quality_review", "run-2"),
  );
  expect(sessionFamily("planning", "run-p")).not.toBe(
    sessionFamily("implement", "run-e"),
  );
  expect(conversationLineageKey("wf-a", "execution")).not.toBe(
    conversationLineageKey("wf-b", "execution"),
  );
});

it("IT-R13/R14/R15/R16：暂停后按 interruption 恢复到原用途", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  s.store.put("interruption", s.workflow.id, s.workflow.id, {
    prior_state: "REVIEWING",
    prior_stage: BEFORE_HUMAN_REVIEW_STAGE,
    prior_purpose: "quality_review",
    review_phase: "before_human",
    prior_run_id: "run-test",
  });
  s.engine.transition(s.workflow.id, ["EXECUTING"], "STOPPED", "stopped");
  const review = resolveResumeTarget(s.engine, s.workflow.id);
  expect(review.state).toBe("REVIEW_QUEUED");
  expect(review.stage).toBe(BEFORE_HUMAN_REVIEW_STAGE);

  s.store.put("interruption", s.workflow.id, s.workflow.id, {
    prior_state: "PLANNING",
    prior_stage: "planning",
    prior_purpose: "planning",
  });
  const planning = resolveResumeTarget(s.engine, s.workflow.id);
  expect(planning.state).toBe("PLANNING");

  s.store.put("interruption", s.workflow.id, s.workflow.id, {
    prior_state: "HUMAN_PENDING",
    prior_stage: "accept",
  });
  const human = resolveResumeTarget(s.engine, s.workflow.id);
  expect(human.state).toBe("HUMAN_PENDING");
  expect(human.enqueue).toBe(false);
});

it("IT-R17：自动额度重试使用失败 Run 的冻结绑定", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-r17";
  env.store.put("workflow", workflowId, "p1", {
    id: workflowId,
    project_id: "p1",
    title: "重试",
    request: "额度",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "BLOCKED",
    stage: "execute",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    run_id: "run-old",
    created_at: now(),
    updated_at: now(),
    feedback: [],
  } satisfies Workflow);
  putSpec(env.store, workflowId, 1, executor("old-model"));
  env.store.put("run", "run-old", workflowId, {
    id: "run-old",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    routing_role: "executor",
    logical_round_id: "round-old",
    profile: executor("old-model"),
    stage: "execute",
    status: "failed",
    started_at: now(),
    package_hash: "pkg",
  });
  putSpec(env.store, workflowId, 2, executor("new-model"));
  env.store.put("pending_model_retry", workflowId, workflowId, {
    retry_run_id: "run-old",
    logical_round_id: "round-old",
  });
  const binding = bindProfile(
    env.store,
    env.config,
    workflowId,
    "implement",
    buildDispatchContext(env.store, workflowId, "implement"),
  );
  expect(binding.routing_source).toBe("retry");
  expect(binding.profile.modelId).toBe("old-model");
  expect(binding.logical_round_id).toBe("round-old");
});

it("IT-R18：用户手动恢复使用最新绑定", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-r18";
  env.store.put("workflow", workflowId, "p1", {
    id: workflowId,
    project_id: "p1",
    title: "恢复",
    request: "手动",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "STOPPED",
    stage: "execute",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  } satisfies Workflow);
  putSpec(env.store, workflowId, 2, executor("latest-model-high"));
  const binding = bindProfile(
    env.store,
    env.config,
    workflowId,
    "implement",
    buildDispatchContext(env.store, workflowId, "implement"),
  );
  expect(binding.routing_source).toBe("task-base");
  expect(binding.profile.modelId).toBe("latest-model-high");
});

it("IT-R19：已停止 Run 的迟到审查结果丢弃且不计数", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  s.engine.transition(s.workflow.id, ["EXECUTING"], "REVIEWING", "review", {
    run_id: "run-test",
    review_request_id: "rev-1",
    snapshot_id: "snap-late",
  });
  s.store.put("run_stop", "run-test", s.workflow.id, {
    prior_run_id: "run-test",
    at: now(),
  });
  const before = s.engine.quality.getGate(s.workflow.id, "before_human");
  const next = await s.engine.receiveReview(s.workflow.id, {
    schema_version: 1,
    review_request_id: "rev-1",
    workflow_id: s.workflow.id,
    plan_revision: s.workflow.plan_revision,
    snapshot_id: "snap-late",
    verdict: "pass",
    coverage: {
      all_changed_files_reviewed: true,
      all_requirements_checked: true,
      upstream_downstream_checked: true,
      security_checked: true,
      tests_validity_checked: true,
      files: ["main:app.txt"],
    },
    findings: [],
    unresolved_questions: [],
    repair_plan: null,
    commit_message: "late",
  });
  expect(next?.state).toBe("REVIEWING");
  expect(s.engine.quality.getGate(s.workflow.id, "before_human")).toEqual(before);
});

it("IT-R20：stop 目标已换成新 Run 时返回 409 且不停止新 Run", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  s.engine.runtime = {
    execute: async () => {},
    stop: async () => {
      throw new Error("不应停止新 Run");
    },
    review: async () => ({}),
    check: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
  try {
    await s.engine.stop(s.workflow.id, "controller", "other-run");
    expect.unreachable("应当抛出 ACTIVE_RUN_CHANGED");
  } catch (error) {
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).code).toBe("ACTIVE_RUN_CHANGED");
  }
  expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
  expect(s.engine.get(s.workflow.id).run_id).toBe("run-test");
});

it("IT-R21：无法停止时保持暂停且不宣称切换成功", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  putSpec(s.store, s.workflow.id, 1);
  seedVerifiedAccess(s.store, planner());
  seedVerifiedAccess(s.store, executor("switched"));
  const switches = new ModelSwitchService(
    s.store,
    new ExecutionSpecService(s.store, s.config),
  );
  s.engine.waitForIdle = async () => {
    throw new FlowError("RUN_STILL_STOPPING", "旧执行轮次尚未退出", 409);
  };
  s.engine.runtime = {
    execute: async () => {},
    stop: async () => {},
    review: async () => ({}),
    check: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
  try {
    await switches.applyAfterPause(s.engine, s.workflow.id, {
      request_id: randomUUID(),
      expected_spec_revision: 1,
      planner_profile: planner(),
      executor_profile: executor("switched"),
      role_overrides: inheritRoleOverrides(),
      expected_workflow_version: s.engine.get(s.workflow.id).version,
      expected_run_id: "run-test",
    });
    expect.unreachable("应当抛出 RUN_STILL_STOPPING");
  } catch (error) {
    expect(error).toBeInstanceOf(FlowError);
    expect((error as FlowError).code).toBe("RUN_STILL_STOPPING");
  }
  const specs = s.store.list<any>("execution_spec", s.workflow.id);
  expect(specs.some((item) => item.executorProfile?.modelId === "switched")).toBe(
    false,
  );
});

it("没有 expected_run_id 的旧 spec_switch 不停止新 Run", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  let stopped = false;
  s.engine.runtime = {
    execute: async () => {},
    stop: async () => {
      stopped = true;
    },
    review: async () => ({}),
    check: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
  s.store.enqueue(s.workflow.id, "dispatch_run", { purpose: "spec_switch" });
  await s.engine.consumeOutbox();
  expect(stopped).toBe(false);
  expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
});

it("验证失败不会先停止当前运行", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  const switches = new ModelSwitchService(
    s.store,
    new ExecutionSpecService(s.store, s.config),
  );
  try {
    switches.parseRequest(
      {
        request_id: randomUUID(),
        expected_spec_revision: 1,
        planner_profile: planner(),
        executor_profile: executor(),
        role_overrides: inheritRoleOverrides(),
        expected_workflow_version: 1,
      },
      s.workflow.id,
    );
    expect.unreachable("缺少 expected_run_id 应失败");
  } catch (error) {
    expect((error as FlowError).code).toBe("ACTIVE_RUN_CHANGED");
  }
  expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
});

it("R05：审查暂停继续保留快照与人工确认", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  s.engine.transition(s.workflow.id, ["EXECUTING"], "STOPPED", "stopped");
  s.store.put("interruption", s.workflow.id, s.workflow.id, {
    prior_state: "REVIEWING",
    prior_stage: BEFORE_HUMAN_REVIEW_STAGE,
    prior_purpose: "quality_review",
    review_phase: "before_human",
  });
  const current = s.engine.get(s.workflow.id);
  s.store.put("workflow", s.workflow.id, current.project_id, {
    ...current,
    snapshot_id: "snap-keep",
    state: "STOPPED",
    stage: "stopped",
  });
  s.store.put("acceptance", s.workflow.id, s.workflow.id, {
    snapshot_id: "snap-keep",
    accepted_at: now(),
  });
  s.store.put("delivery_revision", "del-1", s.workflow.id, {
    id: "del-1",
    workflow_id: s.workflow.id,
    invalidated: false,
  });
  const resumed = resumeApproved(s.engine, s.workflow.id);
  expect(resumed.snapshot_id).toBe("snap-keep");
  expect(s.store.get("acceptance", s.workflow.id)).toBeTruthy();
  expect(s.store.get<any>("delivery_revision", "del-1").invalidated).toBe(false);
  expect(resumed.state).toBe("REVIEW_QUEUED");
});

it("R05：开发、人工确认后审查、功能修复暂停继续保留材料", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  const keep = (stage: string, purpose: string, extra: Record<string, unknown> = {}) => {
    s.engine.transition(s.workflow.id, [s.engine.get(s.workflow.id).state], "STOPPED", "stopped");
    const current = s.engine.get(s.workflow.id);
    s.store.put("workflow", s.workflow.id, current.project_id, {
      ...current,
      snapshot_id: "snap-keep",
      state: "STOPPED",
      stage: "stopped",
    });
    s.store.put("interruption", s.workflow.id, s.workflow.id, {
      prior_state: stage === "review" ? "REVIEWING" : "EXECUTING",
      prior_stage: stage,
      prior_purpose: purpose,
      ...extra,
    });
    s.store.put("acceptance", s.workflow.id, s.workflow.id, {
      snapshot_id: "snap-keep",
      accepted_at: now(),
    });
    s.store.put("delivery_revision", "del-keep", s.workflow.id, {
      id: "del-keep",
      workflow_id: s.workflow.id,
      invalidated: false,
    });
    const resumed = resumeApproved(s.engine, s.workflow.id);
    expect(resumed.snapshot_id).toBe("snap-keep");
    expect(s.store.get("acceptance", s.workflow.id)).toBeTruthy();
    expect(s.store.get<any>("delivery_revision", "del-keep").invalidated).toBe(
      false,
    );
    return resumed;
  };
  expect(keep("execute", "implement").state).toBe("QUEUED");
  expect(keep("review", "quality_review", { review_phase: "after_human" }).state).toBe(
    "REVIEW_QUEUED",
  );
  expect(keep("execute", "functional_fix").state).toBe("QUEUED");
});

it("R06：规划中暂停可继续，未批准计划不能进开发", async () => {
  const s = await prepared();
  closeStore = () => s.store.close();
  s.engine.transition(s.workflow.id, ["EXECUTING"], "STOPPED", "stopped");
  const current = s.engine.get(s.workflow.id);
  s.store.put("workflow", s.workflow.id, current.project_id, {
    ...current,
    state: "STOPPED",
    stage: "stopped",
    plan_revision: 0,
    plan_hash: undefined,
    snapshot_id: "snap-plan",
  });
  s.store.put("interruption", s.workflow.id, s.workflow.id, {
    prior_state: "PLANNING",
    prior_stage: "planning",
    prior_purpose: "planning",
  });
  const planning = resumeApproved(s.engine, s.workflow.id);
  expect(planning.state).toBe("PLANNING");
  expect(planning.snapshot_id).toBe("snap-plan");

  s.engine.transition(s.workflow.id, ["PLANNING"], "STOPPED", "stopped");
  s.store.put("interruption", s.workflow.id, s.workflow.id, {
    prior_state: "EXECUTING",
    prior_stage: "execute",
    prior_purpose: "implement",
  });
  const developing = s.engine.get(s.workflow.id);
  s.store.put("workflow", s.workflow.id, developing.project_id, {
    ...developing,
    state: "STOPPED",
    plan_revision: 1,
    plan_hash: "unapproved",
  });
  try {
    resumeApproved(s.engine, s.workflow.id);
    expect.unreachable("未批准计划不能进开发");
  } catch (error) {
    expect((error as FlowError).code).toBe("PLAN_NOT_APPROVED");
  }
});

it("R11：网络自动重试沿用原冻结绑定，用户继续用新配置", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-net-retry";
  env.store.put("workflow", workflowId, "p1", {
    id: workflowId,
    project_id: "p1",
    title: "网络",
    request: "重试",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "QUEUED",
    stage: "execute",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  } satisfies Workflow);
  putSpec(env.store, workflowId, 1, executor("model-a-high"));
  env.store.put("run", "run-a", workflowId, {
    id: "run-a",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    routing_role: "executor",
    logical_round_id: "round-a",
    profile: executor("model-a-high"),
    stage: "execute",
    status: "failed",
    started_at: now(),
    package_hash: "pkg",
  });
  putSpec(env.store, workflowId, 2, executor("model-b-high"));
  env.store.put("pending_model_retry", workflowId, workflowId, {
    retry_run_id: "run-a",
    logical_round_id: "round-a",
  });
  const autoRetry = bindProfile(
    env.store,
    env.config,
    workflowId,
    "implement",
    buildDispatchContext(env.store, workflowId, "implement"),
  );
  expect(autoRetry.profile.modelId).toBe("model-a-high");
  env.store.remove("pending_model_retry", workflowId);
  const userResume = bindProfile(
    env.store,
    env.config,
    workflowId,
    "implement",
    buildDispatchContext(env.store, workflowId, "implement"),
  );
  expect(userResume.profile.modelId).toBe("model-b-high");
});

it("R12：开始不同语义绑定时更早 lineage 不再连续", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const family = sessionFamily("implement", "run-b");
  const key = conversationLineageKey("wf-session", family);
  env.store.put("native_conversation", key, "wf-session", {
    id: "conv-a",
    fingerprint: fingerprintOf(executor("model-a")),
    run_id: "run-a",
  });
  env.store.put("native_conversation", key, "wf-session", {
    fingerprint: fingerprintOf(executor("model-b")),
    run_id: "run-b",
  });
  const latest = env.store.get<{ id?: string; fingerprint: string }>(
    "native_conversation",
    key,
  );
  expect(latest?.id).toBeUndefined();
  expect(latest?.fingerprint).toBe(fingerprintOf(executor("model-b")));
});

it("R12：指纹不匹配时不复用过期会话", () => {
  const family = sessionFamily("implement", "run-b");
  const a = fingerprintOf(executor("model-a"));
  const b = fingerprintOf(executor("model-b"));
  expect(
    conversationMatchesRun(
      { id: "conv-a", fingerprint: a, family },
      { invocation_fingerprint: b } as never,
      family,
    ),
  ).toBe(false);
  expect(
    conversationMatchesRun(
      { id: "conv-a", fingerprint: a, family },
      { invocation_fingerprint: a } as never,
      family,
    ),
  ).toBe(true);
});

function idleRuntime() {
  return {
    execute: async () => {},
    stop: async () => ({ status: "confirmed_exited" }),
    review: async () => ({}),
    check: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
}

function openSwitch(workflowId: string) {
  const env = setup();
  closeStore = () => env.store.close();
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: "切换",
    request: "切换",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "execute",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    run_id: "run-test",
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  env.store.put("workflow", workflowId, "p1", workflow);
  env.store.put("run", "run-test", workflowId, {
    id: "run-test",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    profile: executor(),
    stage: "execute",
    status: "running",
    started_at: now(),
    package_hash: "pkg",
  });
  putSpec(env.store, workflowId, 1);
  seedVerifiedAccess(env.store, planner());
  seedVerifiedAccess(env.store, executor("switched"));
  seedVerifiedAccess(env.store, executor());
  env.engine.runtime = idleRuntime();
  env.engine.waitForIdle = async () => {};
  const switches = new ModelSwitchService(
    env.store,
    new ExecutionSpecService(env.store, env.config),
  );
  return { ...env, workflow, switches };
}

it("R15：响应丢失重试收据、同 ID 改内容拒绝", async () => {
  const s = openSwitch("wf-r15-retry");
  const requestId = randomUUID();
  const base = {
    request_id: requestId,
    expected_spec_revision: 1,
    planner_profile: planner(),
    executor_profile: executor("switched"),
    role_overrides: inheritRoleOverrides(),
    expected_workflow_version: s.engine.get(s.workflow.id).version,
    expected_run_id: "run-test",
  };
  const first = await s.switches.applyAfterPause(s.engine, s.workflow.id, base);
  expect(first.effective_from).toBe("stopped-awaiting-resume");
  const retry = await s.switches.applyAfterPause(s.engine, s.workflow.id, base);
  expect(retry.operation_id).toBe(first.operation_id);
  try {
    await s.switches.applyAfterPause(s.engine, s.workflow.id, {
      ...base,
      executor_profile: executor("other"),
    });
    expect.unreachable("同 ID 改内容应拒绝");
  } catch (error) {
    expect((error as FlowError).code).toBe("IDEMPOTENCY_CONFLICT");
  }
});

it("R15：停止中断后可从持久化步骤继续", async () => {
  const s = openSwitch("wf-r15-interrupt");
  let idleCalls = 0;
  s.engine.waitForIdle = async () => {
    idleCalls += 1;
    if (idleCalls === 1) {
      throw new FlowError("RUN_STILL_STOPPING", "旧执行轮次尚未退出", 409);
    }
  };
  const req = {
    request_id: randomUUID(),
    expected_spec_revision: 1,
    planner_profile: planner(),
    executor_profile: executor("switched"),
    role_overrides: inheritRoleOverrides(),
    expected_workflow_version: s.engine.get(s.workflow.id).version,
    expected_run_id: "run-test",
  };
  try {
    await s.switches.applyAfterPause(s.engine, s.workflow.id, req);
    expect.unreachable("首次应因停止中断失败");
  } catch (error) {
    expect((error as FlowError).code).toBe("RUN_STILL_STOPPING");
  }
  const recovered = await s.switches.applyAfterPause(s.engine, s.workflow.id, req);
  expect(recovered.effective_from).toBe("stopped-awaiting-resume");
});

it("R15：另一页面新 Run 冲突", async () => {
  const s = openSwitch("wf-r15-other");
  s.engine.waitForIdle = async () => {
    throw new FlowError("RUN_STILL_STOPPING", "旧执行轮次尚未退出", 409);
  };
  const req = {
    request_id: randomUUID(),
    expected_spec_revision: 1,
    planner_profile: planner(),
    executor_profile: executor("switched"),
    role_overrides: inheritRoleOverrides(),
    expected_workflow_version: s.engine.get(s.workflow.id).version,
    expected_run_id: "run-test",
  };
  try {
    await s.switches.applyAfterPause(s.engine, s.workflow.id, req);
  } catch (error) {
    expect((error as FlowError).code).toBe("RUN_STILL_STOPPING");
  }
  const afterStop = s.engine.get(s.workflow.id);
  s.store.put("workflow", s.workflow.id, afterStop.project_id, {
    ...afterStop,
    state: "EXECUTING",
    stage: "execute",
    run_id: "run-other",
  });
  try {
    await s.switches.applyAfterPause(s.engine, s.workflow.id, req);
    expect.unreachable("另一页面新 Run 应冲突");
  } catch (error) {
    expect((error as FlowError).code).toBe("ACTIVE_RUN_CHANGED");
  }
});


it("无 Run 的排队任务先真正暂停，再保存模型切换", async () => {
  const s = openSwitch("wf-switch-queued");
  const queued = { ...s.workflow, state: "QUEUED" as const, run_id: undefined };
  s.store.put("workflow", queued.id, queued.project_id, queued);
  s.engine.scheduler.enqueue(queued.id, queued.project_id);
  const receipt = await s.switches.applyAfterPause(s.engine, queued.id, {
    request_id: randomUUID(), expected_spec_revision: 1,
    planner_profile: planner(), executor_profile: executor("switched"),
    role_overrides: inheritRoleOverrides(),
    expected_workflow_version: queued.version, expected_run_id: null,
  });
  expect(receipt.effective_from).toBe("stopped-awaiting-resume");
  expect(s.engine.get(queued.id).state).toBe("STOPPED");
  expect(s.store.get("queue", queued.id)).toBeUndefined();
  expect(s.store.get<any>("interruption", queued.id)?.prior_state).toBe("QUEUED");
});

it("重放未完成切换不能覆盖另一个已结束 Run", async () => {
  const s = openSwitch("wf-switch-finished-replacement");
  s.engine.waitForIdle = async () => {
    throw new FlowError("RUN_STILL_STOPPING", "still unwinding", 409);
  };
  const req = {
    request_id: randomUUID(), expected_spec_revision: 1,
    planner_profile: planner(), executor_profile: executor("switched"),
    role_overrides: inheritRoleOverrides(),
    expected_workflow_version: s.workflow.version, expected_run_id: "run-test",
  };
  await expect(s.switches.applyAfterPause(s.engine, s.workflow.id, req))
    .rejects.toMatchObject({ code: "RUN_STILL_STOPPING" });
  const stopped = s.engine.get(s.workflow.id);
  s.store.put("workflow", stopped.id, stopped.project_id, {
    ...stopped, state: "HUMAN_PENDING", run_id: "run-new-finished",
  });
  await expect(s.switches.applyAfterPause(s.engine, s.workflow.id, req))
    .rejects.toMatchObject({ code: "ACTIVE_RUN_CHANGED" });
  expect(s.store.list<any>("execution_spec", stopped.id)).toHaveLength(1);
});
