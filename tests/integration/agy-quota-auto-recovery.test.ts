import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup, project } from "../helpers.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { bindProfile, buildDispatchContext, frozenInvocationFromProfile } from "../../packages/core/src/run-profile.js";
import { classifyAgyFailure, confirmAgyQuotaFailure } from "../../packages/adapters/agy/src/failure-fact.js";
import { type Run, type ToolProfile, type Workflow } from "../../packages/contracts/src/index.js";
import type { AgyRunBinding } from "../../packages/contracts/src/agy-account.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import type { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";

const realmId = "default-agy-realm";
const profile: ToolProfile = { id: "original-profile", revision: 1, adapterId: "agy", executableRef: process.execPath,
  modelSelection: "explicit", modelId: "fixture-model", selectionKind: "fixed",
  reasoning: { mode: "explicit", value: "high" }, options: {} };
let s: ReturnType<typeof setup>;
let accounts: ReturnType<typeof accountFixture>;
let bridge: AgyWorkflowBridge;
let access: ModelAccessService;
let exhausted: boolean;
let probeFails: boolean;
let live: Set<string>;
let stop: ReturnType<typeof vi.fn>;
let confirm: ReturnType<typeof vi.fn>;
let restore: ReturnType<typeof vi.spyOn>;
let installs: ReturnType<typeof vi.spyOn>;
let recoveryErrors: unknown[];

beforeEach(async () => {
  s = setup();
  accounts = accountFixture(s.store);
  accounts.seedAccounts();
  exhausted = false;
  probeFails = false;
  const originalProbe = accounts.probe.probeUsage.bind(accounts.probe);
  vi.spyOn(accounts.probe, "probeUsage").mockImplementation(async (...args) => {
    if (probeFails) throw new Error("official_usage_probe_failed");
    const result = await originalProbe(...args);
    if (exhausted && accounts.active() === "a") {
      for (const window of result.windows) if (window.kind === "five_hour") window.remaining_fraction = 0;
      for (const pool of result.pools) for (const window of pool.windows)
        if (window.kind === "five_hour") window.remaining_fraction = 0;
    }
    return result;
  });
  await accounts.service.start({ realmId, requestId: "start" });
  installs = vi.spyOn(accounts.authHost, "activateSaved");
  access = new ModelAccessService(s.store);
  access.seedVerified(profile);
  s.store.put("project", "p1", "p1", project(s.root));
  live = new Set();
  stop = vi.fn(async (runId: string) => {
    live.delete(runId);
    const run = s.store.must<Run>("run", runId);
    markWaiting(run);
    await bridge.releaseRun(runId, false, "account_switch");
  });
  confirm = vi.fn(async (runIds: string[]) => runIds.every((id) => !live.has(id)));
  bridge = new AgyWorkflowBridge(accounts.service,
    { stop, get: (id: string) => live.has(id) ? { id } : undefined } as unknown as ProcessManager,
    undefined, s.engine, { confirmJobsStopped: confirm } as unknown as AgyAccountProcessHost);
  recoveryErrors = [];
  const commit = bridge.onAccountCommitted.bind(bridge);
  vi.spyOn(bridge, "onAccountCommitted").mockImplementation(async (event) => {
    try { await commit(event); } catch (error) { recoveryErrors.push(String(error)); throw error; }
  });
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  // Observe recovery handoff without dispatching a real planner/executor. Frozen
  // retry bindings below are resolved through the actual Engine Store contract.
  restore = vi.spyOn(s.engine, "restoreFailedRole").mockImplementation((id) => s.engine.get(id));
});

afterEach(async () => {
  bridge.dispose();
  for (const permit of accounts.repository.listPermits(realmId))
    await accounts.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: false });
  await accounts.service.close();
  vi.restoreAllMocks();
  s.store.close();
});

function source(id: string, purpose: Run["purpose"] = "implement") {
  const workflowId = `wf-${id}`;
  accounts.repository.savePolicy({ workflow_id: workflowId, revision: 1, auto_switch: true,
    allowed_account_ids: null, recreation_policy: "exact_only", night_pool: "normal", created_at: new Date().toISOString() });
  const native = access.resolveNativeConfig(profile);
  const run: Run = { id, workflow_id: workflowId, adapter: "agy", purpose,
    stage: purpose === "planning" ? "planning" : purpose === "quality_review" ? "quality_before_human" : "execute",
    status: "running", plan_revision: 1, started_at: new Date().toISOString(), package_hash: "package",
    profile, runtime_flavor: "profile-native", execution_spec_id: "original-spec", execution_spec_revision: 1,
    routing_role: purpose === "planning" ? "planner" : purpose === "quality_review" ? "reviewer" : "executor",
    routing_source: "user-repair", logical_round_id: `round-${id}`, conversation_id: `native-${id}`,
    frozen_invocation: { ...frozenInvocationFromProfile(profile, "profile-native"), accountScope: native.accountFingerprint,
      providerScope: native.providerEndpointFingerprint ?? "default", identityConfidence: native.identityConfidence ?? "account" } };
  const workflow: Workflow = { id: workflowId, project_id: "p1", title: id, request: "same task",
    complexity: "simple", workspace_mode: "existing_workspace", state: purpose === "planning" ? "PLANNING" : purpose === "quality_review" ? "REVIEWING" : "EXECUTING",
    stage: run.stage, run_id: id, version: 2, plan_revision: 1, plan_hash: "same-plan", environment_revision: 0,
    feedback: [], created_at: run.started_at, updated_at: run.started_at };
  s.store.put("run", id, workflowId, run);
  s.store.put("workflow", workflowId, "p1", workflow);
  return run;
}
function request(run: Run) {
  return { workflow_id: run.workflow_id, run_id: run.id, effective_model_id: "fixture-model",
    account_policy_revision: accounts.repository.getPolicy(run.workflow_id)!.revision, required_pool_ids: ["fixture-pool"] };
}
function markWaiting(run: Run) {
  const w = s.engine.get(run.workflow_id);
  s.store.put("workflow", w.id, w.project_id, { ...w, version: w.version + (w.state === "BLOCKED" ? 0 : 1),
    state: "BLOCKED", stage: "blocked", blocker: { code: "AGY_ACCOUNT_WAIT", message: "switching" } });
  s.store.put("run", run.id, w.id, { ...s.store.must<Run>("run", run.id), status: "failed" });
}
async function started(run: Run) {
  const binding = await bridge.prepareRun(request(run));
  live.add(run.id);
  accounts.service.markUsageStarted(binding.permit_id, 100 + live.size);
  s.store.put("run", run.id, run.workflow_id, { ...run, agy_account: binding });
  return binding;
}
async function verifyZero() {
  exhausted = true;
  const realm = accounts.repository.getRealm(realmId)!;
  expect(await accounts.service.verifyActiveQuotaExhausted({ realm_id: realmId, account_id: "a", auth_epoch: realm.auth_epoch,
    required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"] })).toBe(true);
}
async function rejectedIntoWait(run: Run) {
  await expect(bridge.prepareRun(request(run))).rejects.toMatchObject({ code: "AGY_ACCOUNT_WAIT" });
  markWaiting(run);
  return s.store.must<any>("agy_account_wait", run.id);
}
function quotaText(binding: AgyRunBinding) {
  const message = "Individual quota reached. Resets in 2h10m.";
  return classifyAgyFailure({ realmId, accountId: binding.account_id, authEpoch: binding.auth_epoch,
    runId: binding.source_run_id, currentTurn: true, eventOffset: 7,
    event: { type: "result", error: message, result: { status: "ERROR", error: message } } });
}
const switches = () => accounts.repository.listOperations(realmId).filter((op) => op.kind === "switch");

it.each(["positive", "probe_failure"])("accepts the bound current quota exit even when usage is %s and coalesces two failures", async mode => {
  const one = source("quota-exit-one"), two = source("quota-exit-two");
  const a = await started(one), b = await started(two);
  const verify = vi.spyOn(accounts.service, "verifyActiveQuotaExhausted");
  probeFails = mode === "probe_failure";
  for (const [run, binding] of [[one, a], [two, b]] as const) {
    const fact = confirmAgyQuotaFailure(quotaText(binding), { exitCode: 3, currentTurn: true, stderr: "" });
    expect(await bridge.observeFailure(binding, fact)).toBe(true);
    markWaiting(run);
  }
  expect(verify).not.toHaveBeenCalled();
  expect(switches()).toHaveLength(1);
  probeFails = false;
  await accounts.service.tick(Date.now());
  expect(accounts.active()).toBe("b");
  expect(installs).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledTimes(2);
});

it.each(["stop", "disable_auto", "stale_epoch"])("does not switch a confirmed quota exit after %s", async change => {
  const run = source("cancelled-quota");
  const binding = await started(run);
  if (change === "stop") s.store.put("run_stop", run.id, run.workflow_id, { reason: "manual" });
  if (change === "disable_auto") {
    const policy = accounts.repository.getPolicy(run.workflow_id)!;
    accounts.repository.savePolicy({ ...policy, revision: policy.revision + 1, auto_switch: false });
  }
  if (change === "stale_epoch") {
    const realm = accounts.repository.getRealm(realmId)!;
    accounts.repository.saveRealm({ ...realm, auth_epoch: realm.auth_epoch + 1 });
  }
  const fact = confirmAgyQuotaFailure(quotaText(binding), { exitCode: 3, currentTurn: true });
  expect(await bridge.observeFailure(binding, fact)).toBe(false);
  expect(switches()).toHaveLength(0);
  expect(installs).not.toHaveBeenCalled();
});

it("does not install credentials or stop an external CLI for a confirmed quota exit", async () => {
  const run = source("external-quota");
  const binding = await started(run);
  accounts.setExternal([{ pid: 999, exe_path: "external-agy" }]);
  const stopExternal = vi.spyOn(accounts.processHost, "stopProcess");
  expect(await bridge.observeFailure(binding, confirmAgyQuotaFailure(quotaText(binding), {
    exitCode: 3, currentTurn: true,
  }))).toBe(true);
  markWaiting(run);
  await accounts.service.tick(Date.now());
  expect(installs).not.toHaveBeenCalled();
  expect(stopExternal).not.toHaveBeenCalled();
  expect(accounts.active()).toBe("a");
  expect(restore).not.toHaveBeenCalled();
});

it("routes a fresh admission quota probe into the same switch and skips a quota-exhausted candidate", async () => {
  const run = source("quota-probe-admission");
  vi.spyOn(accounts.probe, "probeModelAccess").mockImplementation(async (model, options) => {
    if (options?.account_id === "a" || options?.account_id === "b")
      throw Object.assign(new Error("agy_model_quota_exhausted"), {
        code: "agy_model_quota_exhausted", account_id: options.account_id, model_id: model,
      });
    return true;
  });
  await rejectedIntoWait(run);
  expect(switches()).toHaveLength(1);
  expect(accounts.repository.listPermits(realmId)).toHaveLength(0);
  await accounts.service.tick(Date.now());
  expect(accounts.active()).toBe("c");
  expect(installs.mock.calls.map((call: unknown[]) => call[1])).toEqual(["b", "c"]);
  expect(restore).toHaveBeenCalledTimes(1);
});

it.each(["network_error", "permission_denied", "wrong_binding"])("does not turn a %s probe failure into quota switching", async kind => {
  const run = source("non-quota-probe");
  vi.spyOn(accounts.probe, "probeModelAccess").mockRejectedValue(Object.assign(new Error(kind), {
    code: kind === "wrong_binding" ? "agy_model_quota_exhausted" : kind,
    account_id: kind === "wrong_binding" ? "other" : "a", model_id: "fixture-model",
  }));
  await expect(bridge.prepareRun(request(run))).rejects.toThrow();
  expect(switches()).toHaveLength(0);
  expect(installs).not.toHaveBeenCalled();
});

it("verifies quota across same-account token refresh and records why unconfirmed queries are rejected", async () => {
  const realm = accounts.repository.getRealm(realmId)!;
  vi.spyOn(accounts.authHost, "compareActive").mockResolvedValue(false);
  const inspection = vi.spyOn(accounts.authHost, "inspectActive").mockResolvedValue({
    exists: true, auth: { email: "a@example.com" },
  });
  exhausted = true;
  const demand = { realm_id: realmId, account_id: "a", auth_epoch: realm.auth_epoch,
    required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"] };
  expect(await accounts.service.verifyActiveQuotaExhausted(demand)).toBe(true);
  probeFails = true;
  expect(await accounts.service.verifyActiveQuotaExhausted(demand)).toBe(false);
  expect(accounts.repository.listAudits(realmId)[0]).toMatchObject({
    action: "quota_verification_rejected", details: { reason: "official_usage_probe_failed" },
  });
  inspection.mockResolvedValue({ exists: true, auth: { email: "other@example.com" } });
  expect(await accounts.service.verifyActiveQuotaExhausted(demand)).toBe(false);
  expect(accounts.repository.listAudits(realmId)[0]).toMatchObject({
    action: "quota_verification_rejected", details: { reason: "active_identity_changed" },
  });
  expect(installs).not.toHaveBeenCalled();
});

it("switches once for two running consumers plus an exhausted prelaunch run and preserves all three recovery bindings", async () => {
  const runs = [source("running-executor"), source("running-reviewer", "quality_review"), source("admission-planner", "planning")];
  await started(runs[0]!); await started(runs[1]!);
  await verifyZero();
  const wait = await rejectedIntoWait(runs[2]!);
  expect(wait).toMatchObject({ admission_only: true });
  expect(wait.permit_id).toBeUndefined();
  expect(accounts.repository.listPermits(realmId)).toHaveLength(2);
  expect((await bridge.listOccupancy()).find((entry) => entry.consumer_id === runs[2]!.id))
    .toMatchObject({ permit_ids: [], required_model_ids: ["fixture-model"], required_pool_ids: ["fixture-pool"] });
  await accounts.service.tick(Date.now());
  expect(switches()).toHaveLength(1);
  expect(accounts.active()).toBe("b");
  expect(installs).toHaveBeenCalledTimes(1);
  expect(stop.mock.calls.map((call) => call[0]).sort()).toEqual([runs[0]!.id, runs[1]!.id].sort());
  expect(confirm).toHaveBeenCalledWith([runs[0]!.id, runs[1]!.id]);
  expect(restore, JSON.stringify({ recoveryErrors, operations: switches().map(op => ({ phase: op.phase, error: op.error })) })).toHaveBeenCalledTimes(3);
  for (const run of runs) {
    expect(s.store.get<any>("agy_recovery_checkpoint", `${wait.operation_id}:${run.id}`))
      .toMatchObject({ source_run_id: run.id, root_purpose: run.purpose, root_conversation_id: run.conversation_id });
    const retry = bindProfile(s.store, s.config, run.workflow_id, run.purpose!, buildDispatchContext(s.store, run.workflow_id, run.purpose!));
    expect(retry).toMatchObject({ profile, routing_role: run.routing_role, logical_round_id: run.logical_round_id, execution_spec_revision: 1 });
    expect(retry.frozen_invocation.modelToken).toBe(run.frozen_invocation!.modelToken);
    expect(retry.frozen_invocation.accountScope).not.toBe(run.frozen_invocation!.accountScope);
    expect(s.engine.get(run.workflow_id).plan_hash).toBe("same-plan");
  }
});

it("coalesces concurrent prelaunch rejections into the same queued switch without permits", async () => {
  const one = source("one"); const two = source("two"); await verifyZero();
  const waits = await Promise.all([rejectedIntoWait(one), rejectedIntoWait(two)]);
  expect(waits[0].operation_id).toBe(waits[1].operation_id);
  expect(switches()).toHaveLength(1);
  expect(accounts.repository.listPermits(realmId)).toHaveLength(0);
  await accounts.service.tick(Date.now());
  expect(stop).not.toHaveBeenCalled();
  expect(installs).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledTimes(2);
});

it.each(["positive", "probe_failure"])("does not switch for a text quota candidate when official active quota is %s", async (mode) => {
  const run = source("text-quota"); const binding = await started(run);
  probeFails = mode === "probe_failure";
  const fact = quotaText(binding);
  expect(fact.requires_quota_verification).toBe(true);
  expect(await bridge.observeFailure(binding, fact)).toBe(false);
  expect(switches()).toHaveLength(0);
  expect(installs).not.toHaveBeenCalled();
});

it("shares the operation between two real text failures and a third prelaunch consumer after official zero verification", async () => {
  const one = source("text-one"); const two = source("text-two"); const three = source("prelaunch");
  const a = await started(one); const b = await started(two); exhausted = true;
  expect(await bridge.observeFailure(a, quotaText(a))).toBe(true); markWaiting(one);
  expect(await bridge.observeFailure(b, quotaText(b))).toBe(true); markWaiting(two);
  const wait = await rejectedIntoWait(three);
  expect(switches()).toHaveLength(1);
  expect(switches()[0]!.operation_id).toBe(wait.operation_id);
  await accounts.service.tick(Date.now());
  expect(installs).toHaveBeenCalledTimes(1);
  expect(restore, JSON.stringify({ recoveryErrors, operations: switches().map(op => ({ phase: op.phase, error: op.error })) })).toHaveBeenCalledTimes(3);
});

it("retains all running bindings across same-account token refresh and switches once when that account is exhausted", async () => {
  const one = source("refresh-one"); const two = source("refresh-two");
  const a = await started(one); const b = await started(two);
  const before = accounts.repository.getRealm(realmId)!;
  const compare = accounts.authHost.compareActive.bind(accounts.authHost);
  vi.spyOn(accounts.authHost, "compareActive").mockImplementation((realm, ref) =>
    ref === before.active_secret_ref ? Promise.resolve(false) : compare(realm, ref));
  vi.spyOn(accounts.authHost, "inspectActive").mockImplementation(async () => ({
    exists: true, auth: { email: `${accounts.active()}@example.com` },
  }));
  await accounts.service.syncActiveAccountFromHost(realmId);
  const refreshed = accounts.repository.getRealm(realmId)!;
  expect(refreshed.active_secret_ref).not.toBe(before.active_secret_ref);
  expect(refreshed.auth_epoch).toBe(a.auth_epoch);
  const three = source("refresh-third"); const c = await started(three);
  expect(c.auth_epoch).toBe(a.auth_epoch);
  exhausted = true;
  for (const [run, binding] of [[one, a], [two, b], [three, c]] as const) {
    expect(await bridge.observeFailure(binding, quotaText(binding))).toBe(true);
    markWaiting(run);
  }
  expect(switches()).toHaveLength(1);
  await accounts.service.tick(Date.now());
  expect(accounts.active()).toBe("b");
  expect(installs).toHaveBeenCalledTimes(1);
  expect(restore, JSON.stringify(recoveryErrors)).toHaveBeenCalledTimes(3);
});

it("leaves quota rejection manual when automatic switching is disabled", async () => {
  const run = source("auto-off"); await verifyZero();
  const policy = accounts.repository.getPolicy(run.workflow_id)!;
  accounts.repository.savePolicy({ ...policy, revision: policy.revision + 1, auto_switch: false });
  await expect(bridge.prepareRun(request(run))).rejects.toMatchObject({ code: "active_account_quota_exhausted" });
  expect(switches()).toHaveLength(0);
  expect(await bridge.listOccupancy()).toEqual([]);
});

it("does not turn external ownership or missing quota coverage into an automatic switch", async () => {
  const run = source("external"); await verifyZero();
  accounts.setExternal([{ pid: 999, name: "agy" } as any]);
  await expect(bridge.prepareRun(request(run))).rejects.toMatchObject({ code: "external_owner" });
  accounts.setExternal([]);
  accounts.repository.retainQuotaPools(realmId, "a", []);
  await expect(bridge.prepareRun(request(run))).rejects.toMatchObject({ code: "active_account_unavailable" });
  expect(switches()).toHaveLength(0);
});

it("does not confirm an admission-only wait if a process record has appeared", async () => {
  const run = source("record-mixed-in"); await verifyZero(); const wait = await rejectedIntoWait(run);
  await bridge.prepareSwitch(wait.operation_id);
  s.store.put("process_record", run.id, run.workflow_id, { run_id: run.id, status: "running" });
  expect(await bridge.confirmStopped(wait.operation_id)).toBe(false);
  expect(installs).not.toHaveBeenCalled();
});

it("keeps an exhausted allowed-account demand waiting when no candidate is eligible", async () => {
  const run = source("no-candidate"); await verifyZero();
  const policy = accounts.repository.getPolicy(run.workflow_id)!;
  accounts.repository.savePolicy({ ...policy, revision: policy.revision + 1, allowed_account_ids: ["a"] });
  const wait = await rejectedIntoWait(run);
  await accounts.service.tick(Date.now());
  expect(accounts.repository.getOperation(wait.operation_id)?.phase).toBe("waiting");
  expect(s.engine.get(run.workflow_id).blocker?.code).toBe("AGY_ACCOUNT_WAIT");
  expect(installs).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});

it("never restores a workflow stopped by the user after its admission wait", async () => {
  const run = source("user-stopped"); await verifyZero(); const wait = await rejectedIntoWait(run);
  await bridge.prepareSwitch(wait.operation_id);
  const w = s.engine.get(run.workflow_id);
  s.store.put("workflow", w.id, "p1", { ...w, state: "STOPPED", version: w.version + 1 });
  s.store.put("run_stop", run.id, w.id, { run_id: run.id, reason: "user_stop" });
  const realm = accounts.repository.getRealm(realmId)!;
  await bridge.onAccountCommitted({ realm_id: realmId, account_id: "a", auth_epoch: realm.auth_epoch, operation_id: wait.operation_id });
  expect(restore).not.toHaveBeenCalled();
  expect(s.engine.get(w.id).state).toBe("STOPPED");
  expect(s.store.get("pending_model_retry", w.id)).toBeUndefined();
});


