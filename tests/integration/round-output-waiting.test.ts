import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import {
  readWaitingContext,
  readRunContinuation,
} from "../../packages/core/src/waiting-context.js";
import { extractRoundOutput } from "../../packages/runtime/src/round-output.js";
import {
  resumeModelWaits,
  reconcileProcesses,
} from "../../packages/runtime/src/recovery.js";
import { Engine } from "../../packages/core/src/engine.js";
import { Store } from "../../packages/store/src/store.js";
import type { Run } from "../../packages/contracts/src/index.js";

function executing(
  s: Awaited<ReturnType<typeof fixture>>,
  runId = "mixed-output",
): Run {
  const w = s.engine.get(s.w.id);
  const run: Run = {
    id: runId,
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    adapter: "codex",
    purpose: "implement",
    stage: "execute",
    protocol: "lightweight",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "fixture",
    profile: {
      id: "mixed-profile",
      revision: 1,
      adapterId: "codex",
      executableRef: process.execPath,
      modelSelection: "explicit",
      modelId: "fixture-model",
      options: { prefixArgs: [resolve("tests/fixtures/round-output-cli.mjs")] },
    },
  };
  s.store.put("run", run.id, w.id, run);
  s.engine.transition(w.id, [w.state], "EXECUTING", "execute", {
    run_id: run.id,
  });
  return run;
}

it("receives a mixed reply from a real CLI, falls through a damaged file and waits without dispatch", async () => {
  const s = await fixture();
  const processes = new ProcessManager();
  const runtime = new ProfileRuntime(s.engine, processes);
  try {
    const run = executing(s);
    const w = s.engine.get(s.w.id);
    const value = await (runtime as any).invoke(
      w,
      run,
      () => ({ instructions: "先完成可做的工作，然后等待" }),
      {},
    );
    expect(value).toMatchObject({
      status: "need_user",
      summary: "等待测试环境恢复",
    });
    expect(s.store.get("run_result_parse", run.id)).toMatchObject({
      kind: "resolved",
      source: "reply",
    });
    expect(
      readFileSync(
        join(s.config.storage_root, "native-runs", run.id, "raw-result.txt"),
        "utf8",
      ),
    ).toContain("依赖测试环境的工作保持暂停");
    const jobs = s.store.jobs().length;
    await s.engine.receiveRoundResult(w.id, run.id, value);
    expect(s.engine.get(w.id).state).toBe("WAITING_INPUT");
    expect(
      new UserInteractionService(s.store).getCurrentInteraction(w.id)?.request
        .message,
    ).toBe("等待测试环境恢复");
    expect(s.store.get("execution_completion", run.id)).toBeUndefined();
    expect(s.store.jobs().length).toBeLessThanOrEqual(jobs);
    const execute = vi.fn();
    s.engine.runtime = { execute } as any;
    await s.engine.consumeOutbox();
    await s.engine.dispatch();
    await resumeModelWaits(s.engine);
    expect(execute).not.toHaveBeenCalled();
    expect(s.engine.get(w.id).state).toBe("WAITING_INPUT");
  } finally {
    await processes.close();
    await cleanup(s);
  }
});

it("persists ambiguous results across controller reload; clarification requires one idempotent user decision", async () => {
  const s = await fixture();
  let restartedStore: Store | undefined;
  try {
    const run = executing(s, "unclear-run");
    const jobs = s.store.jobs().length;
    const parsed = extractRoundOutput({
      kind: "execution",
      replyText: '说明\n{"status":"completed"}\n{"status":"need_user"}',
    });
    expect(parsed.kind).toBe("ambiguous");
    await s.engine.receiveRoundResult(s.w.id, run.id, {
      status: "unclear",
      summary: parsed.kind === "resolved" ? "" : parsed.rawText,
    });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(readRunContinuation(s.store, s.w.id)).toBeUndefined();
    expect(s.store.jobs().length).toBeLessThanOrEqual(jobs);
    restartedStore = new Store(join(s.config.storage_root, "devflow.sqlite"));
    const restarted = new Engine(restartedStore, s.config);
    reconcileProcesses(restarted, s.w.id);
    await restarted.consumeOutbox();
    await restarted.dispatch();
    await resumeModelWaits(restarted);
    expect(restarted.get(s.w.id).state).toBe("WAITING_INPUT");
    const interactions = new UserInteractionService(restartedStore);
    const current = interactions.getCurrentInteraction(s.w.id)!;
    expect(current.request.choices).toEqual([
      { id: "clarify", label: "仅补充结果说明" },
    ]);
    const payload = {
      request_id: "confirm-clarification",
      source_run_id: run.id,
      action: "answer" as const,
      choice_id: "clarify",
    };
    await interactions.respondInteraction(
      s.w.id,
      current.id,
      payload,
      restarted,
    );
    const queuedJobs = restartedStore.jobs().length;
    await interactions.respondInteraction(
      s.w.id,
      current.id,
      payload,
      restarted,
    );
    expect(restartedStore.jobs().length).toBe(queuedJobs);
    expect(restarted.get(s.w.id).state).toBe("QUEUED");
    expect(readRunContinuation(restartedStore, s.w.id)).toMatchObject({
      kind: "intent_clarification",
      source_run_id: run.id,
    });
    expect(restartedStore.list("feedback_message", s.w.id)).toHaveLength(0);
  } finally {
    restartedStore?.close();
    await cleanup(s);
  }
});

it("preserves a user's pause against a late mixed result", async () => {
  const s = await fixture();
  try {
    const run = executing(s, "paused-run");
    s.store.put("run_stop", run.id, s.w.id, { at: new Date().toISOString() });
    s.engine.transition(s.w.id, ["EXECUTING"], "STOPPED", "stopped");
    expect(
      await s.engine.receiveRoundResult(s.w.id, run.id, {
        status: "need_user",
        summary: "晚到的结果",
      }),
    ).toMatchObject({ status: "ignored" });
    expect(s.engine.get(s.w.id).state).toBe("STOPPED");
    expect(readWaitingContext(s.store, s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("keeps an explicit review need_user when optional review material is malformed", async () => {
  const s = await fixture();
  try {
    const run = executing(s, "review-wait");
    s.store.put("run", run.id, s.w.id, {
      ...run,
      purpose: "quality_review",
      stage: "quality_before_human",
    });
    s.engine.transition(
      s.w.id,
      ["EXECUTING"],
      "REVIEWING",
      "quality_before_human",
    );
    await s.engine.receiveReview(s.w.id, {
      verdict: "need_user",
      summary: "等待必要的外部条件",
      findings: "malformed",
    });
    expect(s.engine.get(s.w.id).state).toBe("WAITING_INPUT");
    expect(readWaitingContext(s.store, s.w.id)).toMatchObject({
      purpose: "review",
      intent: "need_user",
    });
    expect(
      new UserInteractionService(s.store).getCurrentInteraction(s.w.id)?.request
        .message,
    ).toBe("等待必要的外部条件");
  } finally {
    await cleanup(s);
  }
});
