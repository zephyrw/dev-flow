import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { setup, project } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { frozenInvocationFromProfile } from "../../packages/core/src/run-profile.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import type { Run, ToolProfile, Workflow } from "../../packages/contracts/src/index.js";

const sdk = vi.hoisted(() => ({ adapter: undefined as any, identity: undefined as any }));
vi.mock("../../packages/adapters/sdk/src/index.js", async (original) => ({
  ...await original<object>(), createDefaultAdapterRegistry: () => ({ mustGet: () => sdk.adapter }),
  resolveSessionIdentity: async () => sdk.identity,
}));
vi.mock("../../packages/adapters/agy/src/native-record-source.js", async (original) => ({
  ...await original<object>(),
  AgyNativeRecordSource: class { read() { return undefined; } },
}));
const stores: ReturnType<typeof setup>["store"][] = [];
afterEach(() => { vi.restoreAllMocks(); for (const s of stores.splice(0)) s.close(); });

const quota = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h27m2s.";
const tls = "API error: request failed: local error: tls: bad record MAC";
type Scenario = "completed" | "finish_repaired" | "finish_repaired_tool_error" | "quota" | "tls" | "stderr_tls" | "stderr_disk" | "stderr_timeout" | "denied" | "terminated" | "top_error" | "reported_tool_error";
async function invoke(scenario: Scenario, managed = true) {
  const s = setup(); stores.push(s.store);
  s.store.put("project", "p1", "p1", project(s.root));
  const wid = "wf-footer", rid = "run-footer", conversation = "fixture-existing-root";
  const key = { workflow_id: wid, adapter_id: "agy", host_id: "fixture-host", client_scope_id: "fixture-client",
    provider_account_scope: "fixture-account", canonical_model_id: "gemini-fixture", workspace_identity: "fixture-workspace" };
  sdk.identity = { ...key, resolved: true };
  const profile: ToolProfile = { id: "fixture-agy", revision: 1, adapterId: "agy", executableRef: process.execPath,
    modelSelection: "explicit", modelId: "gemini-fixture", reasoning: { mode: "native-default" }, selectionKind: "fixed", options: {} };
  const run: Run = { id: rid, workflow_id: wid, adapter: "agy", purpose: "functional_fix", status: "running",
    stage: "functional_fix", started_at: new Date().toISOString(), plan_revision: 0, package_hash: "fixture", profile,
    frozen_invocation: { ...frozenInvocationFromProfile(profile, "profile-native"), accountScope: "fixture-account" } };
  const w = { id: wid, project_id: "p1", title: "fixture", request: "fixture", complexity: "simple",
    workspace_mode: "existing_workspace", state: "EXECUTING", stage: "functional_fix", run_id: rid,
    version: 1, plan_revision: 0, environment_revision: 0, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), feedback: [], binding_strategy: "unified" } as Workflow;
  s.store.put("workflow", wid, "p1", w); s.store.put("run", rid, wid, run);
  const sessions = new ExecutionSessionStore(s.store);
  const context = { workspace_root: s.root, source_root: s.root, repo_id: "main" };
  const binding = sessions.getOrCreateBinding(key, context);
  sessions.bindConversationId(binding.id, conversation, "prior-run");
  vi.spyOn(ModelAccessService.prototype, "resolveNativeConfig").mockReturnValue({
    identityConfidence: "account", accountId: "fixture-account", accountFingerprint: "fixture-account",
  } as any);
  sdk.adapter = new AgyNativeCliAdapter();
  vi.spyOn(sdk.adapter, "probe").mockResolvedValue({ available: true } as any);
  const step = (index: number, type: string, state = "DONE", extra = {}) => ({ event: "step_update",
    step_update: { conversation_id: conversation, step_index: index, step_type: type, state, ...extra } });
  const output = { status: "completed", summary: "Current guidance handled", test_results: [] };
  // Sanitized live order: new user 751 -> last real tool 813 -> final response 815.
  const events: any[] = [step(751, "user_input"), step(813, "tool", "ACTIVE", { tool_name: "run_command" }),
    step(813, "tool", "DONE", { tool_name: "run_command" })];
  if (scenario === "quota" || scenario === "tls") events.push(step(814, "error_message"));
  if (scenario === "top_error") events.push({ type: "error", error: "fixture transport failed" });
  if (scenario === "reported_tool_error") events.push(step(814, "tool", "ERROR", { tool_name: "read_file",
    tool_info: { output: JSON.stringify({ error: { code: "FIXTURE_TOOL_FAILURE", message: "fixture tool failed" } }) } }));
  if (scenario !== "quota") events.push(step(815, "agent_response"));
  if (scenario.startsWith("finish_repaired")) {
    events.splice(0, events.length, step(673, "user_input"),
      ...(scenario === "finish_repaired_tool_error" ? [step(725, "tool", "ERROR", { tool_name: "run_command",
        tool_info: { output: JSON.stringify({ error: { code: "FIXTURE_TOOL_FAILURE", message: "fixture tool failed" } }) } })] : []),
      step(726, "agent_response"), step(727, "tool", "ACTIVE", { tool_name: "finish" }),
      step(727, "tool", "ERROR", { tool_name: "finish", tool_info: { name: "finish",
        error: { type: "TOOL_ERROR", message: "invalid arguments:\n- at '/delivery': missing property 'workflow_id'\n- at '/delivery': got object, want null" } } }),
      step(728, "agent_response"), step(729, "tool", "ACTIVE", { tool_name: "finish" }), step(729, "finish"));
  }
  const response = ["reported_tool_error", "finish_repaired_tool_error"].includes(scenario) ? "FIXTURE_TOOL_FAILURE" : JSON.stringify(output);
  events.push({ event: "result", result: { conversation_id: conversation, status: "ERROR", response,
    error: scenario === "tls" ? tls : quota, structured_output: output,
    ...(scenario === "denied" ? { denied_actions: [{ display_name: "run_command" }] } : {}) } });
  const proc = new EventEmitter() as any;
  const exit = { code: scenario === "quota" ? 3 : 0, ...(scenario === "terminated" ? { termination_reason: "manual" } : {}) };
  const start = vi.fn(() => {
    proc.completion = new Promise(resolve => setImmediate(() => {
      if (scenario === "stderr_tls") proc.emit("stderr", Buffer.from(tls));
      else if (scenario === "stderr_disk") proc.emit("stderr", Buffer.from("ENOSPC: disk full"));
      else if (scenario === "stderr_timeout") proc.emit("stderr", Buffer.from("request timed out"));
      else proc.emit("stderr", Buffer.from("terminating 2 daemon task(s) on exit\n"));
      proc.emit("stdout", Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n")); resolve(exit);
    }));
    proc.stop = vi.fn(); return proc;
  });
  const bridge = { prepareProfileRun: vi.fn(async () => ({ realm_id: "fixture", account_id: "fixture-account", auth_epoch: 53,
    source_run_id: rid, permit_id: "fixture-permit" })), observeNativeEvent: vi.fn(), observeFailure: vi.fn(async () => true),
    releaseRun: vi.fn(async () => {}), attachProcess: vi.fn() };
  const runtime = new ProfileRuntime(s.engine, { start } as any, managed ? bridge as any : undefined) as any;
  return { result: runtime.invoke(w, run, {}, {}, undefined, [{ id: "ws", workflow_id: wid, ...context, root: s.root }]), bridge, s, rid };
}

it.each([true, false])("delivers a completed fresh response despite a historical quota footer (managed=%s)", async managed => {
  const f = await invoke("completed", managed);
  await expect(f.result).resolves.toMatchObject({ status: "completed", summary: "Current guidance handled" });
  expect(f.s.store.get<Run>("run", f.rid)?.status).toBe("completed");
  expect(f.bridge.observeFailure).not.toHaveBeenCalled();
});
it("still switches for a real unfinished quota turn with exit 3", async () => {
  const f = await invoke("quota");
  await expect(f.result).rejects.toMatchObject({ code: "AGY_ACCOUNT_WAIT" });
  expect(f.bridge.observeFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "current_turn_quota_exit" }));
});
it("delivers the corrected finish output without treating its old quota footer as a new switch request", async () => {
  const f = await invoke("finish_repaired");
  await expect(f.result).resolves.toMatchObject({ status: "completed" });
  expect(f.bridge.observeFailure).not.toHaveBeenCalled();
});
it("keeps another tool's execution error after finish parameters are corrected", async () => {
  const f = await invoke("finish_repaired_tool_error");
  await expect(f.result).rejects.toMatchObject({ details: { diagnostic: expect.stringContaining("FIXTURE_TOOL_FAILURE") } });
  expect(f.bridge.observeFailure).not.toHaveBeenCalled();
});
it.each(["tls", "stderr_tls", "stderr_disk", "stderr_timeout", "denied", "terminated", "top_error", "reported_tool_error"] as const)("preserves current %s failures", async scenario => {
  const f = await invoke(scenario);
  await expect(f.result).rejects.toBeDefined();
  if (scenario === "tls" || scenario === "stderr_tls") await expect(f.result).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
  if (scenario === "stderr_disk") await expect(f.result).rejects.toMatchObject({ code: "DISK_FULL" });
  if (scenario === "stderr_timeout") await expect(f.result).rejects.toMatchObject({ code: "TIMEOUT" });
  if (scenario === "denied") await expect(f.result).rejects.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
  if (scenario === "terminated") await expect(f.result).rejects.toMatchObject({ code: "RUN_REVOKED" });
  if (scenario === "reported_tool_error") await expect(f.result).rejects.toMatchObject({ details: { diagnostic: expect.stringContaining("FIXTURE_TOOL_FAILURE") } });
  if (scenario === "top_error") await expect(f.result).rejects.toMatchObject({ details: { diagnostic: expect.stringContaining("fixture transport failed") } });
  expect(f.bridge.observeFailure).not.toHaveBeenCalled();
});
