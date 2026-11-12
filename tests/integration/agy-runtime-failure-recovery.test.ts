import { expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";
import { workflowAttention } from "../../packages/core/src/attention.js";
import { fixture as nativeFixture, runtime as fixtureRuntime, until, cleanup } from "../fixtures/native-flow.js";
import { beginRunConversation, retainRunConversation } from "../../packages/core/src/conversation-lineage.js";

const quota = "Individual quota reached. Resets in 2h27m12s.";
const stalled = "error: the connection to the agent was interrupted before the response finished: subscriber fell behind updates, stalled for 10s";
const internal = "API error (attempt 1): INTERNAL (code 500): Internal error encountered.";
const interrupted = "The stream was interrupted. Please continue the task you were working on.";
const capacity = "API error (attempt 6): UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";

it.each(["stalled", "internal", "stream_interrupted", "capacity", "unconfirmed", "disabled", "quota", "denied"] as const)(
  "real profile AGY process preserves current failure and account decision: %s",
  async mode => {
    const s = setup();
    const repo = await repository(s.root);
    const p = project(repo.repo);
    s.store.put("project", p.id, p.id, p);
    const created = s.engine.create({ project_id: p.id, title: "AGY failure fixture", request: "fixture",
      complexity: "simple", workspace_mode: "existing_workspace" }, "fixture-create");
    await s.engine.git.prepare(p, created.id, "existing_workspace", { main: repo.baseline });
    s.store.put("plan", `${created.id}-1`, created.id, { revision: 1, hash: "plan", plan: plan("project", repo.baseline) });
    const workflow = { ...created, plan_revision: 1, plan_hash: "plan" };
    s.store.put("workflow", workflow.id, p.id, workflow);
    const processes = new ProcessManager();
    const session = crypto.randomUUID();
    const cli = join(s.root, "agy-error-cli.mjs");
    const events = [
      { event: "init", conversation_id: session, init: { model: "fixture-model", cwd: repo.repo } },
      { event: "step_update", step_update: { conversation_id: session, step_index: 10, step_type: "user_input", state: "DONE" } },
      ...(mode === "denied" ? [{ event: "step_update", step_update: {
        conversation_id: session, step_index: 11, step_type: "tool", state: "ERROR", tool_info: {
          name: "run_command", parameters: { CommandLine: "echo permission-fixture" },
          error: { type: "TOOL_ERROR", message: "permission check failed for run_command: user denied permission for run_command" },
        },
      } }] : []),
      ...(mode === "internal" ? [
        { event: "step_update", step_update: { conversation_id: session, step_index: 11, step_type: "error_message", state: "DONE" } },
        { event: "step_update", step_update: { conversation_id: session, step_index: 12, step_type: "agent_response", state: "DONE" } },
        { event: "step_update", step_update: { conversation_id: session, step_index: 13, step_type: "finish", state: "DONE" } },
      ] : []),
      ...(mode === "stream_interrupted" ? [
        { event: "step_update", step_update: { conversation_id: session, step_index: 11, step_type: "error_message", state: "DONE" } },
        { event: "step_update", step_update: { conversation_id: session, step_index: 12, step_type: "agent_response", state: "DONE" } },
      ] : []),
      { event: "result", result: { conversation_id: session, status: "ERROR",
        error: mode === "stream_interrupted" ? JSON.stringify({ error: interrupted }) : mode === "internal" ? internal : mode === "capacity" ? capacity : quota,
        response: mode === "stream_interrupted" ? JSON.stringify({ status: "completed", summary: "完成", notes: "", artifacts: [] })
          : mode === "internal" ? "本轮仍有输出" : "",
        ...(mode === "denied" ? { denied_actions: [{ display_name: "run_command" }] } : {}) } },
    ];
    writeFileSync(cli, `if(process.argv.includes('--version') || process.argv.includes('--help')) {
      console.log('agy 1.2.13 --print --conversation --mode');
    } else {
      for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
      ${mode === "stalled" || mode === "denied" ? `console.error(${JSON.stringify(stalled)});` : ""}
      process.exitCode = ${mode === "internal" || mode === "stream_interrupted" ? 0 : mode === "quota" ? 3 : 1};
    }`);
    const run: Run = {
      id: "agy-current-run", workflow_id: workflow.id, plan_revision: 1, adapter: "agy", purpose: "executor_test",
      stage: "executor_test", protocol: "lightweight", status: "running", started_at: new Date().toISOString(),
      package_hash: "fixture", profile: { id: "agy-fixture", revision: 1, adapterId: "agy", executableRef: process.execPath,
        modelSelection: "explicit", modelId: "fixture-model", options: { prefixArgs: [cli] } },
    };
    const binding = { realm_id: "fixture-realm", account_id: "fixture-account", auth_epoch: 1,
      permit_id: "fixture-permit", source_run_id: run.id, account_policy_revision: 1, account_settings_revision_at_start: 1 };
    const bridge = {
      prepareProfileRun: vi.fn(async () => binding), attachProcess: vi.fn(), observeNativeEvent: vi.fn(),
      releaseRun: vi.fn(async () => {}), observeAccountQuota: vi.fn(() => vi.fn()),
      observeFailure: vi.fn(async (_binding: unknown, _fact: unknown) => mode === "quota" ? "waiting" : mode === "disabled" ? "not_applicable" : "quota_unconfirmed"),
    };
    const runtime = new ProfileRuntime(s.engine, processes, bridge as unknown as AgyWorkflowBridge);
    s.store.put("run", run.id, workflow.id, run);
    const w = { ...workflow, state: "EXECUTING" as const, stage: "executor_test", run_id: run.id };
    s.store.put("workflow", w.id, w.project_id, w);
    try {
      const error = await (runtime as any).invoke(w, run, { instructions: "fixture" }, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowError);
      const code = mode === "quota" ? "AGY_ACCOUNT_WAIT" : mode === "denied" ? "NATIVE_PERMISSION_DENIED" :
        mode === "capacity" ? "MODEL_CAPACITY_UNAVAILABLE" :
        mode === "unconfirmed" || mode === "disabled" ? "NATIVE_RUN_FAILED" : "MODEL_CONNECTION_FAILED";
      expect(error.code).toBe(code);
      if (mode !== "denied") expect(error.details.exit_code).toBe(mode === "internal" || mode === "stream_interrupted" ? 0 : mode === "quota" ? 3 : 1);
      if (mode === "stalled" || mode === "internal" || mode === "stream_interrupted" || mode === "capacity" || mode === "denied")
        expect(bridge.observeFailure).not.toHaveBeenCalled();
      else expect(bridge.observeFailure).toHaveBeenCalledOnce();
      if (mode === "stalled") expect(error.details.diagnostic).toContain(stalled);
      if (mode === "stream_interrupted") {
        expect(error.details.diagnostic).toContain(interrupted);
        expect(s.store.must<Run>("run", run.id).status).not.toBe("completed");
        expect(s.store.list("delivery", w.id)).toHaveLength(0);
      }
      if (mode === "unconfirmed" || mode === "disabled") {
        expect(error.details.diagnostic).not.toContain("Individual quota reached");
        expect(error.details.diagnostic).toContain("未获当前运行确认");
      }
      if (mode === "quota") expect(bridge.observeFailure.mock.calls[0]?.[1]).not.toHaveProperty("requires_quota_verification");
      expect(s.store.get("session_input", run.id)).toMatchObject({ state: "delivered" });
      expect(s.store.must<Run>("run", run.id).conversation_id).toBe(session);
      s.engine.block(w.id, error);
      expect(s.store.get("model_retry", w.id)).toBeUndefined();
      if (mode !== "quota") expect(workflowAttention(s.engine, w.id)).toMatchObject({ resolution: { code } });
    } finally {
      await processes.close();
      s.store.close();
    }
  },
);

it.each(["waiting", "result_then_stderr", "unconfirmed", "stderr_conflict", "stdout_conflict", "history"] as const)(
  "resumed AGY distinguishes process stderr from retained stdout failures: %s", async mode => {
    const s = setup();
    const processes = new ProcessManager();
    try {
      const repo = await repository(s.root);
      const p = project(repo.repo);
      s.store.put("project", p.id, p.id, p);
      const created = s.engine.create({ project_id: p.id, title: "AGY resumed quota fixture", request: "fixture",
        complexity: "simple", workspace_mode: "existing_workspace" }, "resumed-quota-create");
      await s.engine.git.prepare(p, created.id, "existing_workspace", { main: repo.baseline });
      s.store.put("plan", `${created.id}-1`, created.id, { revision: 1, hash: "plan", plan: plan("project", repo.baseline) });
      const session = crypto.randomUUID();
      const cli = join(s.root, "agy-resumed-stderr-cli.mjs");
      const events = mode === "result_then_stderr" ? [
        { event: "step_update", step_update: { conversation_id: session, step_index: 10, step_type: "user_input", state: "DONE" } },
        { event: "result", result: { conversation_id: session, status: "ERROR", error: quota, response: "" } },
        // A later completed model step invalidates attribution of the retained
        // result; process stderr must remain an independent verified candidate.
        { event: "step_update", step_update: { conversation_id: session, step_index: 11, step_type: "agent_response", state: "DONE" } },
      ] : mode === "history"
        ? [{ event: "result", result: { conversation_id: session, status: "ERROR", error: quota, response: "" } }]
        : mode === "stdout_conflict" ? [{ event: "error", error: { message: "operation timed out" } }] : [];
      const stderr = mode === "history" ? "" : `error: ${quota}\nAGY_ERROR: ${JSON.stringify({ error: quota })}` +
        (mode === "stderr_conflict" ? "\noperation timed out" : "");
      writeFileSync(cli, `if(process.argv.includes('--version') || process.argv.includes('--help')) {
        console.log('agy 1.2.13 --print --conversation --mode');
      } else {
        if (!process.argv.includes(${JSON.stringify(session)})) throw new Error('fixture expected original conversation');
        for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
        if (${JSON.stringify(stderr)}) console.error(${JSON.stringify(stderr)});
        process.exitCode = 3;
      }`);
      const run: Run = { id: "resumed-stderr-run", workflow_id: created.id, plan_revision: 1, adapter: "agy",
        purpose: "functional_fix", stage: "functional_fix", protocol: "lightweight", status: "running",
        started_at: new Date().toISOString(), package_hash: "fixture",
        profile: { id: "agy-fixture", revision: 1, adapterId: "agy", executableRef: process.execPath,
          modelSelection: "explicit", modelId: "fixture-model", options: { prefixArgs: [cli] } } };
      const w = { ...created, plan_revision: 1, plan_hash: "plan", state: "EXECUTING" as const,
        stage: "functional_fix", run_id: run.id };
      s.store.put("workflow", w.id, w.project_id, w);
      s.store.put("run", run.id, w.id, run);
      s.store.put("account_recovery_continuation", run.id, w.id,
        { decision: "exact_resume", original_conversation_id: session });
      const binding = { realm_id: "fixture-realm", account_id: "fixture-account", auth_epoch: 1,
        permit_id: "fixture-permit", source_run_id: run.id, account_policy_revision: 1, account_settings_revision_at_start: 1 };
      const bridge = {
        prepareProfileRun: vi.fn(async () => binding), attachProcess: vi.fn(), observeNativeEvent: vi.fn(),
        releaseRun: vi.fn(async () => {}), observeAccountQuota: vi.fn(() => vi.fn()),
        observeFailure: vi.fn(async (_binding: unknown, _fact: unknown) =>
          mode === "waiting" || mode === "result_then_stderr" ? "waiting" : "quota_unconfirmed"),
      };
      const runtime = new ProfileRuntime(s.engine, processes, bridge as unknown as AgyWorkflowBridge);
      const error = await (runtime as any).invoke(w, run, { instructions: "fixture" }, {}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FlowError);
      if (mode !== "result_then_stderr") expect(s.store.get("session_input", run.id)).not.toMatchObject({ state: "delivered" });
      expect(error.details.exit_code).toBe(3);
      if (mode === "waiting" || mode === "result_then_stderr" || mode === "unconfirmed") {
        expect(bridge.observeFailure).toHaveBeenCalledOnce();
        expect(bridge.observeFailure.mock.calls[0]?.[1]).toMatchObject({ source_event_type: "stderr",
          run_id: run.id, conversation_id: session, account_id: binding.account_id, auth_epoch: binding.auth_epoch,
          requires_quota_verification: true });
        expect(error.code).toBe(mode === "unconfirmed" ? "MODEL_QUOTA" : "AGY_ACCOUNT_WAIT");
        if (mode === "unconfirmed") expect(error.details.diagnostic).toContain("未获当前额度核验确认");
      } else {
        expect(bridge.observeFailure).not.toHaveBeenCalled();
        expect(error.code).not.toBe("AGY_ACCOUNT_WAIT");
      }
      expect(bridge.releaseRun).toHaveBeenCalled();
      expect(s.store.must<Run>("run", run.id).conversation_id).toBe(session);
    } finally {
      await processes.close();
      s.store.close();
    }
  },
);

it.each([0, 10])("stream interruptions keep the original session and bounded retry budget: %s previous retries", async count => {
  const s = await nativeFixture();
  const seen: Run[] = [];
  const resumed: Array<{ id: string } | undefined> = [];
  try {
    if (count) s.store.put("transient_network_retry", s.w.id, s.w.id, { count, last_at: Date.now() });
    s.engine.runtime = fixtureRuntime(s, async run => {
      seen.push(run);
      resumed.push(beginRunConversation(s.store, run));
      if (seen.length === 1) {
        retainRunConversation(s.store, run, "interrupted-session");
        throw new FlowError("NATIVE_RUN_FAILED", `CLI 返回错误：${JSON.stringify({ error: interrupted })}`, 422, { exit_code: 0 });
      }
      await s.engine.receiveRoundResult(s.w.id, run.id, { status: "need_user", summary: "恢复后等待真实用户决定",
        user_interaction: { kind: "question", title: "确认恢复后的处理方式", message: "连接已恢复，需要用户选择后续处理方式。",
          question: "恢复后应继续哪项任务？" } });
    });
    await until(s, [count ? "BLOCKED" : "WAITING_INPUT"], 30000);
    const retries = s.store.events(s.w.id).filter(event => event.type === "ModelRetryScheduled");
    expect(seen).toHaveLength(count ? 1 : 2);
    expect(retries).toHaveLength(count ? 0 : 1);
    expect(s.store.list("execution_auto_continuation", s.w.id)).toHaveLength(0);
    expect(s.store.list("delivery", s.w.id)).toHaveLength(0);
    if (count) {
      expect(s.engine.get(s.w.id).blocker?.code).toBe("MODEL_CONNECTION_FAILED");
      expect(s.store.get("pending_model_retry", s.w.id)).toBeUndefined();
    } else {
      expect(retries[0]?.payload).toMatchObject({ attempt: 1, max_attempts: 10 });
      expect(resumed).toEqual([undefined, { id: "interrupted-session" }]);
      expect(seen[1]?.profile).toEqual(seen[0]?.profile);
    }
  } finally { await cleanup(s); }
});
