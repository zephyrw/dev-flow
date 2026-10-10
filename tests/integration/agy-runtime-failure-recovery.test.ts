import { expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";
import { workflowAttention } from "../../packages/core/src/attention.js";

const quota = "Individual quota reached. Resets in 2h27m12s.";
const stalled = "error: the connection to the agent was interrupted before the response finished: subscriber fell behind updates, stalled for 10s";
const internal = "API error (attempt 1): INTERNAL (code 500): Internal error encountered.";

it.each(["stalled", "internal", "unconfirmed", "disabled", "quota", "denied"] as const)(
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
      { event: "result", result: { conversation_id: session, status: "ERROR", error: mode === "internal" ? internal : quota,
        response: mode === "internal" ? "本轮仍有输出" : "",
        ...(mode === "denied" ? { denied_actions: [{ display_name: "run_command" }] } : {}) } },
    ];
    writeFileSync(cli, `if(process.argv.includes('--version') || process.argv.includes('--help')) {
      console.log('agy 1.2.13 --print --conversation --mode');
    } else {
      for(const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
      ${mode === "stalled" || mode === "denied" ? `console.error(${JSON.stringify(stalled)});` : ""}
      process.exitCode = ${mode === "internal" ? 0 : mode === "quota" ? 3 : 1};
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
        mode === "unconfirmed" || mode === "disabled" ? "NATIVE_RUN_FAILED" : "MODEL_CONNECTION_FAILED";
      expect(error.code).toBe(code);
      if (mode !== "denied") expect(error.details.exit_code).toBe(mode === "internal" ? 0 : mode === "quota" ? 3 : 1);
      if (mode === "stalled" || mode === "internal" || mode === "denied")
        expect(bridge.observeFailure).not.toHaveBeenCalled();
      else expect(bridge.observeFailure).toHaveBeenCalledOnce();
      if (mode === "stalled") expect(error.details.diagnostic).toContain(stalled);
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
