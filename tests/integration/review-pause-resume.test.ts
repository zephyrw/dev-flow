import { it, expect, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { INTENT_CLARIFICATION_INSTRUCTION } from "../../packages/core/src/round-intent.js";
import type { Run } from "../../packages/contracts/src/index.js";
import { frozenInvocationFromProfile, invocationFingerprintFromFrozen, permissionCategoryForPurpose, workflowWorkspaceIdentity } from "../../packages/core/src/run-profile.js";
import { beginRunConversation, retainRunConversation } from "../../packages/core/src/conversation-lineage.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import {
  readPlanningHandoff,
  readRunContinuation,
  savePlanningHandoff,
} from "../../packages/core/src/waiting-context.js";

it.each([true, false])(
  "paused review resumes its original phase without snapshot proof (matches=%s)",
  async () => {
    const s = await fixture();
    const w = {
      ...s.engine.get(s.w.id),
      state: "STOPPED" as const,
      stage: "stopped",
      run_id: "paused-review",
      snapshot_id: "paused-snapshot",
    };
    s.store.put("workflow", w.id, w.project_id, w);
    s.store.put("run", w.run_id, w.id, {
      id: w.run_id,
      workflow_id: w.id,
      stage: "quality_before_human",
      status: "stopped",
      purpose: "quality_review",
    });
    s.store.put("snapshot", w.snapshot_id, w.id, {
      id: w.snapshot_id,
      repositories: [],
    });
    vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
    try {
      expect(await s.engine.retryReview(w.id)).toMatchObject({
        state: "REVIEW_QUEUED",
        stage: "quality_before_human",
        plan_hash: w.plan_hash,
        snapshot_id: w.snapshot_id,
      });
    } finally {
      await cleanup(s);
    }
  },
);

function reviewingWorkflow(
  s: Awaited<ReturnType<typeof fixture>>,
  runId: string,
) {
  const current = s.engine.get(s.w.id);
  const w = {
    ...current,
    state: "REVIEWING" as const,
    stage: "quality_before_human",
    run_id: runId,
    snapshot_id: current.snapshot_id ?? "snap-review",
  };
  s.store.put("workflow", w.id, w.project_id, w);
  s.store.put("snapshot", w.snapshot_id!, w.id, {
    id: w.snapshot_id,
    repositories: [],
  });
  s.store.put("workspace", "ws-review", w.id, {
    id: "ws-review",
    workflow_id: w.id,
    repo_id: "main",
    root: s.repo,
    common_dir: s.repo,
    baseline: s.baseline,
    branch: "task/fixture",
    owned: false,
  });
  return w;
}

function captureReviewCli(root: string) {
  const cli = join(root, "review-capture.cjs");
  writeFileSync(
    cli,
    [
      "const fs = require('node:fs');",
      "try { fs.readFileSync(0, 'utf8'); } catch {}",
      "const emit = (value) => console.log(JSON.stringify(value));",
      "const resume = process.argv.indexOf('resume');",
      "emit({ type: 'thread.started', thread_id: resume >= 0 ? process.argv[resume + 1] : 'new-session' });",
      "const idx = process.argv.indexOf('--output-last-message');",
      "const result = { verdict: 'passed', summary: '补问完成' };",
      "if (idx >= 0 && process.argv[idx + 1]) fs.writeFileSync(process.argv[idx + 1], JSON.stringify(result));",
      "emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });",
    ].join("\n"),
  );
  return {
    id: "fixture-reviewer",
    revision: 1,
    adapterId: "codex" as const,
    executableRef: process.execPath,
    modelSelection: "explicit" as const,
    modelId: "fixture-reviewer",
    options: { prefixArgs: [cli] },
  };
}

function persistReviewBinding(
  s: Awaited<ReturnType<typeof fixture>>,
  run: Run,
  sourceSession?: string,
) {
  const frozen = frozenInvocationFromProfile(run.profile!, "profile-native");
  run.frozen_invocation = frozen;
  run.runtime_flavor = "profile-native";
  run.invocation_fingerprint = invocationFingerprintFromFrozen(
    frozen,
    workflowWorkspaceIdentity(s.store, run.workflow_id),
    permissionCategoryForPurpose("quality_review"),
  );
  if (sourceSession) {
    const source: Run = {
      ...run,
      id: run.continuation!.source_run_id,
      status: "completed",
      continuation: undefined,
      conversation_id: sourceSession,
    };
    s.store.put("run", source.id, source.workflow_id, source);
    beginRunConversation(s.store, source);
    retainRunConversation(s.store, source, sourceSession);
  }
  s.store.put("run", run.id, run.workflow_id, run);
}

it("无 execution_spec_id 的轻量审查仍走 ProfileRuntime", async () => {
  const s = await fixture();
  const runtime = new LocalRuntime(s.engine);
  const spy = vi
    .spyOn(ProfileRuntime.prototype, "review")
    .mockResolvedValue({ verdict: "passed" });
  const w = reviewingWorkflow(s, "rev-light");
  const run = {
    id: "rev-light",
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    adapter: "codex",
    purpose: "quality_review",
    protocol: "lightweight",
    stage: "quality_before_human",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg",
  };
  try {
    await runtime.review(w, run as Run);
    expect(spy).toHaveBeenCalledOnce();
  } finally {
    spy.mockRestore();
    await runtime.close();
    await cleanup(s);
  }
});

it("审查续接只补问结论并 resume 原会话", async () => {
  const s = await fixture();
  const runtime = new LocalRuntime(s.engine);
  const w = reviewingWorkflow(s, "rev-clarify");
  const run: Run = {
    id: "rev-clarify",
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
      kind: "intent_clarification",
      source_run_id: "rev-old",
      purpose: "review",
      role: "planner",
      conversation_id: "review-session",
      original_text: "稍后补充结论",
    },
    profile: captureReviewCli(s.root),
  };
  persistReviewBinding(s, run, "review-session");
  try {
    await runtime.review(w, run);
    const materials = JSON.parse(
      readFileSync(
        join(s.config.storage_root, "native-runs", run.id, "HANDOFF.json"),
        "utf8",
      ),
    );
    expect(materials.instructions).toBe(INTENT_CLARIFICATION_INSTRUCTION);
    expect(materials.original_text).toBe("稍后补充结论");
    expect(materials).not.toHaveProperty("skill_resources");
    expect(String(materials.instructions)).not.toContain("完整汇总后统一给出审查结论");
    const stored = s.store.must<Run>("run", run.id);
    expect(stored.conversation_id).toBe("review-session");
  } finally {
    await runtime.close();
    await cleanup(s);
  }
});

it("审查用户回答进入原审查上下文并续接原会话", async () => {
  const s = await fixture();
  const runtime = new LocalRuntime(s.engine);
  const w = reviewingWorkflow(s, "rev-answer");
  const run: Run = {
    id: "rev-answer",
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
      kind: "user_answer",
      source_run_id: "rev-old",
      purpose: "review",
      role: "planner",
      conversation_id: "review-session",
      questions: ["缺哪个配置项？"],
      answer: "API_BASE",
    },
    profile: captureReviewCli(s.root),
  };
  persistReviewBinding(s, run, "review-session");
  try {
    await runtime.review(w, run);
    const materials = JSON.parse(
      readFileSync(
        join(s.config.storage_root, "native-runs", run.id, "HANDOFF.json"),
        "utf8",
      ),
    );
    expect(materials.answer).toBe("API_BASE");
    expect(materials.questions).toEqual(["缺哪个配置项？"]);
    expect(materials.instructions).toContain("你负责本次需求和变更的代码质量");
    expect(materials.instructions).toContain("不检查测试是否真实执行");
    const stored = s.store.must<Run>("run", run.id);
    expect(stored.conversation_id).toBe("review-session");
  } finally {
    await runtime.close();
    await cleanup(s);
  }
});

it("续接会话缺失时新会话获得完整背景与原文，不要求重复开发测试", async () => {
  const s = await fixture();
  const runtime = new LocalRuntime(s.engine);
  const w = reviewingWorkflow(s, "rev-missing");
  const run: Run = {
    id: "rev-missing",
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
      kind: "intent_clarification",
      source_run_id: "rev-old",
      purpose: "review",
      role: "planner",
      original_text: "稍后补充结论",
      questions: ["请明确本轮审查结论"],
    },
    profile: captureReviewCli(s.root),
  };
  persistReviewBinding(s, run);
  const gateBefore = structuredClone(s.engine.quality.getOrCreateGate(w.id, "before_human"));
  try {
    await expect(runtime.review(w, run)).resolves.toMatchObject({ verdict: "passed" });
    const materials = JSON.parse(readFileSync(
      join(s.config.storage_root, "native-runs", run.id, "HANDOFF.json"), "utf8",
    ));
    expect(materials.original_text).toBe("稍后补充结论");
    expect(materials.questions).toEqual(["请明确本轮审查结论"]);
    expect(materials.plan).toEqual(s.engine.plan(w.id));
    expect(materials.project).toEqual(s.engine.project(w.project_id));
    expect(materials.snapshot.id).toBe(w.snapshot_id);
    expect(materials).toHaveProperty("review_contract");
    expect(materials.phase).toBe("before_human");
    expect(materials.run).toMatchObject({ stage: "quality_before_human", protocol: "lightweight" });
    expect(materials.continuation_handoff).toMatchObject({ source_run_id: "rev-old" });
    expect(materials).toHaveProperty("skill_resources");
    expect(materials.instructions).toContain("不重新执行已完成的开发或测试");
    expect(s.store.must<Run>("run", run.id).conversation_id).toBe("new-session");
    expect(s.store.get("quality_review", run.id)).toBeUndefined();
    expect(s.engine.get(w.id)).toMatchObject({ state: "REVIEWING", stage: "quality_before_human" });
    expect(s.engine.quality.getGate(w.id, "before_human")).toEqual(gateBefore);
  } finally {
    await runtime.close();
    await cleanup(s);
  }
});

it("审查续接已绑到 Run 后失败恢复仍入队审查", async () => {
  const s = await fixture();
  try {
    const current = s.engine.get(s.w.id);
    s.store.put("workflow", current.id, current.project_id, {
      ...current,
      state: "RECOVERY_REQUIRED",
      stage: "quality_before_human",
      run_id: "rev-bound",
      blocker: { code: "NATIVE_RUN_FAILED", message: "审查中断" },
    });
    s.store.put("run", "rev-bound", current.id, {
      id: "rev-bound",
      workflow_id: current.id,
      plan_revision: current.plan_revision,
      adapter: "codex",
      stage: "quality_before_human",
      status: "failed",
      purpose: "quality_review",
      protocol: "lightweight",
      continuation: {
        kind: "user_answer",
        source_run_id: "rev-bound",
        purpose: "review",
        role: "planner",
        conversation_id: "review-session",
        answer: "API_BASE",
      },
    });
    const next = resumeApproved(s.engine, s.w.id);
    expect(next.state).toBe("REVIEW_QUEUED");
    expect(next.stage).toBe("quality_before_human");
    expect(readRunContinuation(s.store, s.w.id)?.purpose).toBe("review");
    expect(readRunContinuation(s.store, s.w.id)?.answer).toBe("API_BASE");
  } finally {
    await cleanup(s);
  }
});

it("后续执行失败时未关闭的规划交接标为 superseded，不改派规划", async () => {
  const s = await fixture();
  try {
    const current = s.engine.get(s.w.id);
    s.store.put("workflow", current.id, current.project_id, {
      ...current,
      state: "BLOCKED",
      stage: "execute",
      run_id: "exec-now",
      blocker: { code: "NATIVE_RUN_FAILED", message: "执行中断" },
    });
    s.store.put("run", "exec-now", current.id, {
      id: "exec-now",
      workflow_id: current.id,
      plan_revision: current.plan_revision,
      adapter: "codex",
      stage: "execute",
      status: "failed",
      purpose: "implement",
      protocol: "lightweight",
    });
    savePlanningHandoff(s.store, current.id, {
      handoff_id: "leftover-handoff",
      source_run_id: "old-exec",
      source_role: "executor",
      target_role: "planner",
      target_run_id: "old-plan",
      status: "assigned",
      original_text: "过期规划原文",
    });
    const next = resumeApproved(s.engine, s.w.id);
    expect(next.state).toBe("QUEUED");
    expect(next.stage).not.toBe("planning");
    expect(readPlanningHandoff(s.store, current.id)?.status).toBe("superseded");
  } finally {
    await cleanup(s);
  }
});
