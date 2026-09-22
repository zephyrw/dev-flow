import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import {
  readPlanningHandoff,
  readWaitingContext,
  savePlanningHandoff,
  saveWaitingContext,
} from "../../packages/core/src/waiting-context.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import type { Run } from "../../packages/contracts/src/index.js";

it("need_user 不生成完成记录，审查不明结论回答后回到原审查", async () => {
  const s = await fixture();
  try {
    const approved = s.engine.get(s.w.id);
    s.engine.transition(s.w.id, [approved.state], "EXECUTING", "execute", {
      run_id: "run-ask",
    });
    s.store.put("run", "run-ask", s.w.id, {
      id: "run-ask",
      workflow_id: s.w.id,
      plan_revision: approved.plan_revision,
      adapter: "codex",
      stage: "execute",
      status: "running",
      purpose: "implement",
      protocol: "lightweight",
      started_at: new Date().toISOString(),
      package_hash: "pkg",
    });
    const asked = await s.engine.deliver(s.w.id, {
      status: "need_user",
      summary: "缺环境变量名称",
    });
    expect(asked.status).toBe("need_user");
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(s.store.get("execution_completion", "run-ask")).toBeUndefined();
    expect(readWaitingContext(s.store, s.w.id)?.role).toBe("executor");

    s.engine.transition(
      s.w.id,
      ["WAITING_INPUT"],
      "REVIEWING",
      "quality_before_human",
      { run_id: "rev-ask", review_request_id: "req-ask", blocker: undefined },
    );
    s.store.put("run", "rev-ask", s.w.id, {
      id: "rev-ask",
      workflow_id: s.w.id,
      plan_revision: approved.plan_revision,
      adapter: "codex",
      stage: "quality_before_human",
      status: "completed",
      exit_code: 0,
      purpose: "quality_review",
      protocol: "lightweight",
      started_at: new Date().toISOString(),
      package_hash: "pkg",
    });
    s.store.put("plan_check_review_intent", s.w.id, s.w.id, {
      phase: "before_human",
      source_run_id: "run-ask",
    });
    await s.engine.receiveReview(s.w.id, { summary: "稍后补充结论" });
    expect(s.engine.get(s.w.id).state).toBe("REVIEW_QUEUED");
    expect(s.engine.quality.getGate(s.w.id, "before_human")).toBeUndefined();
    expect(readWaitingContext(s.store, s.w.id)?.purpose).toBe("review");
    expect(readWaitingContext(s.store, s.w.id)?.continuation).toBe(true);
    expect(readWaitingContext(s.store, s.w.id)?.intent).toBe("unclear");
  } finally {
    await cleanup(s);
  }
});

it("嵌套 delivery 不能覆盖外层 need_user，停止的旧运行不能改当前任务", async () => {
  const s = await fixture();
  try {
    const approved = s.engine.get(s.w.id);
    s.engine.transition(s.w.id, [approved.state], "EXECUTING", "execute", {
      run_id: "new-run",
    });
    s.store.put("run", "new-run", s.w.id, {
      id: "new-run",
      workflow_id: s.w.id,
      plan_revision: approved.plan_revision,
      adapter: "codex",
      stage: "execute",
      status: "running",
      purpose: "implement",
      protocol: "lightweight",
      started_at: new Date().toISOString(),
      package_hash: "pkg",
    });
    s.store.put("run", "old-stopped", s.w.id, {
      id: "old-stopped",
      workflow_id: s.w.id,
      plan_revision: approved.plan_revision,
      adapter: "codex",
      stage: "execute",
      status: "stopped",
      purpose: "implement",
      protocol: "lightweight",
      started_at: new Date().toISOString(),
      package_hash: "pkg",
    });
    s.store.put("run_stop", "old-stopped", s.w.id, { at: new Date().toISOString() });
    const nested = await s.engine.receiveRoundResult(s.w.id, "new-run", {
      status: "need_user",
      summary: "需要补充配置",
      delivery: { summary: "已完成部分实现" },
    });
    expect(nested.status).toBe("need_user");
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(s.engine.get(s.w.id).run_id).toBe("new-run");
    s.engine.transition(s.w.id, ["WAITING_INPUT"], "EXECUTING", "execute", {
      run_id: "new-run",
      blocker: undefined,
    });
    const stale = await s.engine.receiveRoundResult(s.w.id, "old-stopped", {
      status: "need_user",
      summary: "过期求助",
    });
    expect(stale.status).toBe("ignored");
    expect(s.engine.get(s.w.id).state).toBe("EXECUTING");
    expect(s.engine.get(s.w.id).run_id).toBe("new-run");
    expect(s.engine.get(s.w.id).blocker).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("执行中不沿用旧完成记录，人工后审查保留完成来源，status=passed 会写入规范化 verdict", async () => {
  const s = await fixture();
  try {
    const approved = s.engine.get(s.w.id);
    s.store.put("execution_completion", "old-done", s.w.id, {
      run_id: "old-done",
      workflow_id: s.w.id,
      intent: "completed",
      summary: "上一轮",
      recorded_at: new Date().toISOString(),
    });
    s.store.put("plan_check_review_intent", s.w.id, s.w.id, {
      phase: "before_human",
      completion_run_id: "old-done",
      source_run_id: "old-done",
    });
    s.engine.transition(s.w.id, [approved.state], "EXECUTING", "execute", {
      run_id: "new-run",
    });
    const executing = s.engine.taskStatus(s.w.id);
    expect(executing.every((task) => task.completed === false)).toBe(true);
    s.store.put("plan_check_review_intent", s.w.id, s.w.id, {
      phase: "after_human",
      completion_run_id: "old-done",
      source_run_id: "old-done",
    });
    s.engine.transition(s.w.id, ["EXECUTING"], "REVIEWING", "review", {
      run_id: "rev-pass",
      review_request_id: "req-pass",
    });
    s.store.put("run", "rev-pass", s.w.id, {
      id: "rev-pass",
      workflow_id: s.w.id,
      plan_revision: approved.plan_revision,
      adapter: "codex",
      stage: "review",
      status: "completed",
      exit_code: 0,
      purpose: "quality_review",
      protocol: "lightweight",
      started_at: new Date().toISOString(),
      package_hash: "pkg",
    });
    const reviewing = s.engine.taskStatus(s.w.id);
    expect(reviewing.every((task) => task.completed === true)).toBe(true);
    s.store.put("plan_check_review_intent", s.w.id, s.w.id, {
      phase: "before_human",
      completion_run_id: "old-done",
      source_run_id: "old-done",
    });
    s.engine.transition(s.w.id, ["REVIEWING"], "REVIEWING", "quality_before_human", {
      run_id: "rev-pass",
      review_request_id: "req-pass",
    });
    await s.engine.receiveReview(s.w.id, {
      status: "passed",
      summary: "质量通过",
    });
    const stored = s.store.get<any>("review", "req-pass");
    expect(stored?.verdict).toBe("passed");
  } finally {
    await cleanup(s);
  }
});

function executingRun(s: Awaited<ReturnType<typeof fixture>>, runId: string) {
  const approved = s.engine.get(s.w.id);
  s.engine.transition(s.w.id, [approved.state], "EXECUTING", "execute", {
    run_id: runId,
  });
  s.store.put("run", runId, s.w.id, {
    id: runId,
    workflow_id: s.w.id,
    plan_revision: approved.plan_revision,
    adapter: "codex",
    stage: "execute",
    status: "running",
    purpose: "implement",
    protocol: "lightweight",
    started_at: new Date().toISOString(),
    package_hash: "pkg",
  });
  return approved;
}

it("外层 unclear 加内层 completed 不能写成完成", async () => {
  const s = await fixture();
  try {
    executingRun(s, "run-unclear");
    const result = await s.engine.receiveRoundResult(s.w.id, "run-unclear", {
      status: "unclear",
      summary: "还没写结论",
      delivery: {
        status: "completed",
        implementations: [{ path: "src/a.ts" }],
      },
    });
    expect(result.status).toBe("unclear");
    expect(s.store.get("execution_completion", "run-unclear")).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("未知外层状态不读内层完成", async () => {
  const s = await fixture();
  try {
    executingRun(s, "run-unknown");
    const result = await s.engine.receiveRoundResult(s.w.id, "run-unknown", {
      status: "weird-status",
      delivery: { status: "completed" },
    });
    expect(result.status).toBe("unclear");
    expect(s.store.get("execution_completion", "run-unknown")).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("默认配置轻量审查走 ProfileRuntime 并带入用户回答", async () => {
  const s = await fixture();
  const runtime = new LocalRuntime(s.engine);
  const spy = vi
    .spyOn(ProfileRuntime.prototype, "review")
    .mockResolvedValue({ verdict: "passed" });
  const w = {
    ...s.engine.get(s.w.id),
    state: "REVIEWING" as const,
    stage: "quality_before_human",
    run_id: "rev-default",
  };
  s.store.put("workflow", w.id, w.project_id, w);
  const run = {
    id: "rev-default",
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    adapter: "codex",
    purpose: "quality_review",
    protocol: "lightweight",
    stage: "quality_before_human",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg",
    continuation: {
      kind: "user_answer" as const,
      source_run_id: "rev-old",
      purpose: "review" as const,
      role: "planner" as const,
      conversation_id: "review-session",
      questions: ["缺哪个配置项？"],
      answer: "API_BASE",
    },
  };
  try {
    await runtime.review(w, run as Run);
    expect(spy).toHaveBeenCalled();
    const sent = spy.mock.calls[0]?.[1] as Run;
    expect(sent.continuation?.answer).toBe("API_BASE");
    expect(sent.continuation?.questions).toEqual(["缺哪个配置项？"]);
  } finally {
    spy.mockRestore();
    await runtime.close();
    await cleanup(s);
  }
});

it("规划输入包含求助正文且不 resume 执行会话", async () => {
  const s = await fixture();
  const runtime = new LocalRuntime(s.engine);
  const w = s.engine.get(s.w.id);
  s.store.put("planning_handoff", w.id, w.id, {
    handoff_id: "handoff-1",
    source_run_id: "exec-1",
    source_role: "executor",
    source_conversation_id: "exec-session",
    plan_revision: w.plan_revision,
    original_text: "模块边界和计划不一致",
    summary: "需要澄清模块拆分",
    notes: "现有接口不能删",
    questions: ["B 模块是否独立？"],
    target_role: "planner",
    status: "pending",
  });
  const run: Run = {
    id: "plan-handoff",
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    adapter: "codex",
    purpose: "planning",
    stage: "planning",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg",
    protocol: "lightweight",
    continuation: {
      kind: "runtime_resume",
      source_run_id: "exec-1",
      purpose: "planning",
      role: "planner",
      conversation_id: "exec-session",
    },
    profile: {
      id: "fixture-planner",
      adapterId: "codex",
      revision: 1,
      executableRef: process.execPath,
      modelSelection: "explicit",
      modelId: "fixture-planner",
      options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
    },
  };
  s.store.put("run", run.id, w.id, run);
  try {
    await runtime.plan(w, run);
    const handoff = JSON.parse(
      readFileSync(
        join(s.config.storage_root, "native-runs", run.id, "HANDOFF.json"),
        "utf8",
      ),
    );
    expect(handoff.original_text).toBe("模块边界和计划不一致");
    expect(handoff.summary).toBe("需要澄清模块拆分");
    expect(handoff.notes).toBe("现有接口不能删");
    expect(handoff.questions).toEqual(["B 模块是否独立？"]);
    expect(handoff.source_execution).toMatchObject({
      run_id: "exec-1",
      conversation_id: "exec-session",
    });
    expect(handoff.current_plan).toBeTruthy();
    const stored = s.store.must<Run>("run", run.id);
    expect(stored.conversation_id).not.toBe("exec-session");
  } finally {
    await runtime.close();
    await cleanup(s);
  }
});

it("need_planner 入口应留下规划交接而不是完成记录", async () => {
  const s = await fixture();
  try {
    executingRun(s, "run-planner");
    const result = await s.engine.receiveRoundResult(s.w.id, "run-planner", {
      status: "need_planner",
      summary: "模块边界和计划不一致",
      notes: "现有接口不能删",
      unresolved_questions: ["B 模块是否独立？"],
    });
    expect(result.status).toBe("need_planner");
    expect(s.store.get("execution_completion", "run-planner")).toBeUndefined();
    const handoff = s.store.get<any>("planning_handoff", s.w.id);
    expect(handoff?.source_run_id).toBe("run-planner");
    expect(handoff?.status).toBe("pending");
    expect(handoff?.target_role).toBe("planner");
    expect(String(handoff?.original_text ?? "")).toContain(
      "模块边界和计划不一致",
    );
    expect(String(handoff?.notes ?? handoff?.original_text ?? "")).toContain(
      "现有接口不能删",
    );
    expect(readWaitingContext(s.store, s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("不明结论会写入完整续接，完成交付只入队归档不改意图", async () => {
  const s = await fixture();
  try {
    executingRun(s, "run-clarify");
    const result = await s.engine.receiveRoundResult(s.w.id, "run-clarify", {
      status: "unclear",
      summary: "请补充本轮结论",
    });
    expect(result.status).toBe("unclear");
    const continuation = s.store.get<any>("run_continuation", s.w.id);
    expect(continuation).toMatchObject({
      kind: "intent_clarification",
      source_run_id: "run-clarify",
      purpose: "execute",
      role: "executor",
      original_text: "请补充本轮结论",
    });
    expect(readWaitingContext(s.store, s.w.id)?.continuation).toBe(true);
  } finally {
    await cleanup(s);
  }
});

it("过期规划等待不会改派后续执行恢复", async () => {
  const s = await fixture();
  try {
    const approved = s.engine.get(s.w.id);
    s.engine.transition(s.w.id, [approved.state], "EXECUTING", "execute", {
      run_id: "exec-now",
    });
    s.store.put("run", "exec-now", s.w.id, {
      id: "exec-now",
      workflow_id: s.w.id,
      plan_revision: approved.plan_revision,
      adapter: "codex",
      stage: "execute",
      status: "failed",
      purpose: "implement",
      protocol: "lightweight",
      started_at: new Date().toISOString(),
      package_hash: "pkg",
    });
    s.engine.transition(s.w.id, ["EXECUTING"], "BLOCKED", "blocked", {
      run_id: "exec-now",
      blocker: { code: "INTERNAL_FAILURE", message: "网络中断" },
    });
    saveWaitingContext(s.store, s.w.id, {
      purpose: "planning",
      role: "planner",
      run_id: "old-exec",
      source_execution_run_id: "old-exec",
      intent: "need_planner",
      original_text: "过期求助",
    });
    savePlanningHandoff(s.store, s.w.id, {
      handoff_id: "stale-handoff",
      source_run_id: "old-exec",
      source_role: "executor",
      target_role: "planner",
      status: "pending",
    });
    const next = resumeApproved(s.engine, s.w.id);
    expect(next.state).toBe("QUEUED");
    expect(next.stage).not.toBe("planning");
    expect(readPlanningHandoff(s.store, s.w.id)?.status).toBe("superseded");
    expect(readWaitingContext(s.store, s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});
