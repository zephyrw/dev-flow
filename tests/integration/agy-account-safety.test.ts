import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import { AgyAccountService } from "../../packages/agy-accounts/src/service.js";
import type { AuthHostPort, AccountProbePort, ProcessHostPort, AccountConsumerPort } from "../../packages/agy-accounts/src/ports.js";
import type { QuotaWindow } from "../../packages/contracts/src/agy-account.js";

const realmId = "default-agy-realm", model = "gemini-fixture", pool = "fixture-pool";
const timestamp = "2026-09-20T04:00:00Z", now = Date.parse(timestamp);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function windows(weekly = 0.8, five = 0.5): QuotaWindow[] {
  return [{ kind: "weekly", duration_minutes: 10080, remaining_fraction: weekly, reset_at: "2026-09-26T04:00:00Z", observed_at: timestamp, status: "observed" }, { kind: "five_hour", duration_minutes: 300, remaining_fraction: five, reset_at: "2026-09-20T09:00:00Z", observed_at: timestamp, status: "observed" }];
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agy-safety-"));
  const store = new Store(join(dir, "store.sqlite")), repo = new AgyAccountRepository(store);
  const state = { held: false, acquire: true, active: "saved_A", external: false, releases: 0, writes: [] as string[], probes: [] as string[], actual: { A: 0.4, B: 0.9, C: 0.7 } as Record<string, number> };
  const auth: AuthHostPort = {
    isDomainLockHeld: () => state.held,
    compareActive: async (_realm, ref) => state.active === ref,
    capabilities: async () => ({ supported: true, platform: "win32", dpapi_available: true, cred_manager_available: true, named_mutex_available: true, version: "3.0.0-node" }),
    acquireDomainLock: async () => { state.held = state.acquire; return { acquired: state.acquire, release: async () => { state.held = false; state.releases++; } }; },
    inspectActive: async () => ({ exists: state.active !== "absent", account_id: state.active.replace("saved_", ""), secret_ref: state.active }),
    captureActive: async () => ({ secret_ref: state.active, credential_revision: 1 }),
    activateSaved: async (_realm, account, ref) => { state.active = ref; state.writes.push(account); return { credential_revision: 1 }; },
    restoreBackup: async (_realm, ref) => { state.active = ref; state.writes.push("restore"); },
    clearActiveForLogin: async () => { const backupRef = state.active; state.active = "absent"; return { backupRef }; },
    deleteSaved: async () => {},
  };
  const probe: AccountProbePort = {
    probeIdentity: async () => {
      const id = state.active.replace("saved_", "");
      return { email: `${id}@example.test`, cli_version: "fixture", raw_output: "agy whoami" };
    },
    probeUsage: async () => {
      const id = state.active.replace("saved_", ""); state.probes.push(id);
      const quota = windows(state.actual[id]);
      return { email: `${id}@example.test`, cli_version: "fixture", raw_output: "", windows: quota, pools: [{ pool_id: pool, model_ids: [model], windows: quota }], executable_fingerprint: "isolated-fixture", capability_verified: true };
    },
    probeModelAccess: async () => true,
  };
  const processes: ProcessHostPort = { listManagedProcesses: async () => [], findExternalAgyProcesses: async () => state.external ? [{ pid: 42, exe_path: "fixture-agy" }] : [], stopProcess: async () => true, confirmProcessesStopped: async () => true };
  const clock = { now: () => now, toISOString: () => timestamp };
  const service = new AgyAccountService(repo, auth, probe, processes, clock);
  service.initializeSettings(realmId, { standalone_model_id: model, switch_gap_seconds: 1 });
  repo.saveRealm({ realm_id: realmId, owner: "fixture", active_account_id: "A", active_secret_ref: "saved_A", auth_epoch: 1, phase: "idle", revision: 1, service_state: "stopped", desired_enabled: false, control_generation: 0 });
  for (const [id, balance] of Object.entries(state.actual)) {
    repo.saveAccount({ id, realm_id: realmId, alias: id, revision: 1, identity: { email: `${id}@example.test`, verified_at: timestamp }, secret_ref: `saved_${id}`, credential_revision: 1, state: "ready", enrolled_at: timestamp, enrollment_completed_at: timestamp, auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" } });
    repo.saveQuotaSnapshot({ id: `quota_${id}`, realm_id: realmId, account_id: id, auth_epoch: 1, pool_id: pool, model_ids: [model], source: "official_cli_usage", cli_version: "fixture", parser_revision: 1, observed_at: timestamp, executable_fingerprint: "isolated-fixture", capability_verified: true, windows: windows(balance) });
  }
  cleanup.push(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { state, auth, probe, processes, clock, repo, service, store };
}

describe("AGY durable safety boundary", () => {
  it("refuses admission when the OS owner cannot be acquired", async () => {
    const f = await fixture(); f.state.acquire = false;
    await expect(f.service.start({ realmId, requestId: "start" })).rejects.toThrow("domain_owned_elsewhere");
    expect(f.repo.getRealm(realmId)?.service_state).toBe("blocked"); expect(f.state.writes).toEqual([]);
  });

  it("does not require a process-host capability during close if startup never acquired a realm", async () => {
    const f = await fixture(); let enumerations = 0;
    f.processes.listManagedProcesses = async () => { enumerations++; throw new Error("AGY_PROCESS_HOST_CAPABILITY_MISSING"); };
    await expect(f.service.start({ realmId, requestId: "start" })).rejects.toThrow("AGY_PROCESS_HOST_CAPABILITY_MISSING");
    await expect(f.service.close()).resolves.toBeUndefined();
    expect(enumerations).toBe(1); expect(f.state.releases).toBe(0);
  });

  it("still stops owned jobs after lease loss and refuses an unconfirmed shutdown", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    f.service.markUsageStarted(permit.permit_id, 123); f.state.held = false;
    const stopped: number[] = [];
    f.processes.listManagedProcesses = async () => [{ pid: 123, permit_id: permit.permit_id }];
    f.processes.stopProcess = async (pid) => { stopped.push(pid); return true; };
    f.processes.confirmProcessesStopped = async () => false;
    await expect(f.service.close()).rejects.toThrow("managed_processes_not_stopped");
    expect(stopped).toEqual([123]); expect(f.state.releases).toBe(0);
    f.processes.confirmProcessesStopped = async () => true;
    await f.service.close(); expect(f.state.releases).toBe(1);
  });

  it("persists the returned operation ID and deduplicates intent before any upstream call", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    const input = { realm_id: realmId, request_id: "switch", kind: "switch" as const, selection: { mode: "explicit" as const, account_id: "B" }, model_id: model };
    const receipt = await f.service.requestOperation(input);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("queued");
    expect(await f.service.requestOperation(input)).toEqual(receipt); expect(f.state.probes).toEqual([]);
    await expect(f.service.requestOperation({ ...input, selection: { mode: "explicit", account_id: "C" } })).rejects.toThrow("request_id_conflict");
    await expect(f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] })).rejects.toThrow();
    await f.service.tick(now);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed"); expect(f.state.writes).toEqual(["B"]);
  });

  it("rolls back an explicit exhausted target even with an external CLI, without probing another account", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" }); f.state.actual.B = 0;
    f.state.external = true;
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    await f.service.tick(now);
    expect(f.state.probes).toEqual(["B"]); expect(f.state.active).toBe("saved_A");
    expect(f.repo.getRealm(realmId)?.auth_epoch).toBeGreaterThan(2);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("failed");
  });

  it("does not reclassify an unknown CLI failure as a network retry", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let probes = 0;
    f.probe.probeUsage = async () => { probes++; throw new Error("official_usage_probe_failed"); };
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "auto" } });
    await f.service.tick(now);
    expect(probes).toBe(1); expect(f.state.active).toBe("saved_A");
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("failed");
    expect(f.repo.getOperation(receipt.operation_id)?.retry_at).toBeUndefined();
  });

  it("automatically tries the next candidate only after stopping the exhausted identity", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" }); f.state.actual.B = 0;
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "auto" } });
    await f.service.tick(now);
    expect(f.state.probes).toEqual(["B", "C"]); expect(f.state.active).toBe("saved_C");
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
  });

  it("commits the same account's refreshed credential after model access verification", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.probe.probeModelAccess = async () => { f.state.active = "renewed_B"; return true; };
    f.auth.inspectActive = async () => ({ exists: true, auth: { email: "B@example.test" } });
    f.auth.captureActive = async () => ({ secret_ref: f.state.active, credential_revision: f.state.active === "renewed_B" ? 2 : 1, auth: { email: `${f.state.active.endsWith("B") ? "B" : "A"}@example.test` } });
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "auto" } });
    await f.service.tick(now);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    expect(f.repo.getFinalAccountCommit(receipt.operation_id)?.secret_ref).toBe("renewed_B");
    expect(f.repo.getRealm(realmId)?.active_secret_ref).toBe("renewed_B");
    expect(f.repo.getAccount(realmId, "B")?.credential_revision).toBe(2);
  });

  it("does not commit or relabel credentials when identity changes during a model probe", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.probe.probeModelAccess = async () => { f.state.active = "external_C"; return true; };
    f.auth.inspectActive = async () => ({ exists: true, auth: { email: "C@example.test" } });
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "auto" } });
    await f.service.tick(now);
    expect(f.repo.getFinalAccountCommit(receipt.operation_id)).toBeUndefined();
    expect(f.repo.getRealm(realmId)?.phase).toBe("blocked");
    expect(f.repo.getAccount(realmId, "B")?.secret_ref).toBe("saved_B");
    expect(f.state.active).toBe("external_C");
  });

  it("switches accounts alongside an external CLI without stopping it", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" }); f.state.external = true;
    const stopped: number[] = [];
    f.processes.stopProcess = async pid => { stopped.push(pid); return true; };
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    await f.service.tick(now);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    expect(f.state.active).toBe("saved_B");
    expect(f.state.writes).toEqual(["B"]);
    expect(stopped).toEqual([]);
  });

  it.each(["admission", "restart"])("clears a legacy external-owner block during %s", async mode => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.state.external = true;
    const original = f.repo.getRealm(realmId)!;
    f.repo.saveRealm({ ...original, phase: "blocked", last_error: "external_owner" });
    if (mode === "restart") await f.service.reconcileStartup();
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "recovered", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    expect(permit.account_id).toBe(original.active_account_id);
    expect(f.repo.getRealm(realmId)).toMatchObject({ phase: "idle", auth_epoch: original.auth_epoch });
    expect(f.repo.getRealm(realmId)?.last_error).toBeUndefined();
    expect(f.state.writes).toEqual([]);
  });

  it("does not clear a real credential recovery failure during admission", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.repo.saveRealm({ ...f.repo.getRealm(realmId)!, phase: "blocked", last_error: "rollback_verification_failed" });
    await expect(f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "blocked", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] })).rejects.toThrow();
    expect(f.repo.getRealm(realmId)?.last_error).toBe("rollback_verification_failed");
    expect(f.repo.listPermits(realmId)).toHaveLength(0);
  });

  it("continues a legacy external-exit wait even while the CLI remains open", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.state.external = true;
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "legacy-switch", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    f.repo.saveOperation({ ...f.repo.getOperation(receipt.operation_id)!, phase: "waiting_external_exit", deadline_at: new Date(Date.now() + 300_000).toISOString() });
    await f.service.reconcileStartup();
    await f.service.tick(now);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    expect(f.state.active).toBe("saved_B");
  });

  it.each(["switch", "probe"] as const)("cancels %s during the last ownership read before installing another identity", async (kind) => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let enter!: () => void, finish!: () => void, paused = false;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const compare = f.auth.compareActive;
    f.auth.compareActive = async (...args) => {
      const phase = f.repo.getRealm(realmId)?.phase;
      if (!paused && phase === (kind === "switch" ? "installing" : "prepared")) { paused = true; enter(); await finished; }
      return compare(...args);
    };
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "operation", kind, account_id: "B", selection: { mode: "explicit", account_id: "B" } });
    const tick = f.service.tick(now); await entered;
    await f.service.requestOperation({ realm_id: realmId, request_id: "cancel", kind: "cancel", operation_id: receipt.operation_id });
    finish(); await tick;
    expect(f.state.writes).toEqual([]); expect(f.state.active).toBe("saved_A");
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("cancelled");
  });

  it("does not clear active credentials if login is cancelled while preparing its backup", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.service.getEnrollmentService().isLoginAvailable = () => true;
    let enter!: () => void, finish!: () => void, clears = 0;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const capture = f.auth.captureActive;
    f.auth.captureActive = async (...args) => { enter(); await finished; return capture(...args); };
    f.auth.clearActiveForLogin = async () => { clears++; f.state.active = "absent"; return { backupRef: "saved_A" }; };
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "login", kind: "enroll", mode: "login", alias: "fixture" });
    const tick = f.service.tick(now); await entered;
    await f.service.requestOperation({ realm_id: realmId, request_id: "cancel", kind: "cancel", operation_id: receipt.operation_id });
    finish(); await tick;
    expect(clears).toBe(0); expect(f.state.active).toBe("saved_A");
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("cancelled");
  });

  it("updates a disabled account's quota without enabling it during a requested probe", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    const account = f.repo.getAccount(realmId, "B")!;
    account.state = "disabled"; account.state_before_disabled = "pending_quota"; f.repo.saveAccount(account);
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "probe", kind: "probe", account_id: "B" });
    await f.service.tick(now);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    expect(f.repo.getAccount(realmId, "B")?.state).toBe("disabled");
    expect(f.repo.getAccount(realmId, "B")?.state_before_disabled).toBe("ready");
  });

  it("holds the domain until a previously issued execution permit is released", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    f.service.markUsageStarted(permit.permit_id);
    await f.service.stop({ realmId, requestId: "stop" }); expect(f.state.held).toBe(true); expect(f.repo.getRealm(realmId)?.service_state).toBe("stopping");
    await f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: false }); await f.service.tick(now);
    expect(f.state.held).toBe(false); expect(f.repo.getRealm(realmId)?.service_state).toBe("stopped");
  });

  it("finishes an in-flight access probe before a queued identity switch can install", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let entered!: () => void, finishProbe!: () => void;
    const probeEntered = new Promise<void>((resolve) => { entered = resolve; });
    const probeMayFinish = new Promise<void>((resolve) => { finishProbe = resolve; });
    f.probe.probeModelAccess = async () => { entered(); await probeMayFinish; return true; };
    const permit = f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    await probeEntered;
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    const tick = f.service.tick(now);
    expect(f.state.writes).toEqual([]);
    const rejected = expect(permit).rejects.toThrow("permit_admission_changed");
    finishProbe(); await rejected; await tick;
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    expect(f.state.writes).toEqual(["B"]);
  });

  it("keeps the OS lease during stop until a pre-permit model probe exits", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    f.probe.probeModelAccess = async () => { enter(); await finished; return true; };
    const permit = f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    await entered;
    await f.service.stop({ realmId, requestId: "stop" }); await f.service.tick(now);
    expect(f.state.held).toBe(true); expect(f.state.releases).toBe(0);
    const rejected = expect(permit).rejects.toThrow("permit_admission_changed");
    finish(); await rejected; await f.service.tick(now);
    expect(f.state.held).toBe(false); expect(f.repo.listPermits(realmId)).toEqual([]);
  });

  it("keeps the OS lease while the last released permit still captures its identity", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    f.service.markUsageStarted(permit.permit_id);
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const capture = f.auth.captureActive;
    f.auth.captureActive = async (...args) => { enter(); await finished; expect(f.state.held).toBe(true); return capture(...args); };
    const release = f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: true });
    await entered;
    await f.service.stop({ realmId, requestId: "stop" }); await f.service.tick(now);
    expect(f.state.held).toBe(true); expect(f.repo.getPermit(permit.permit_id)?.status).toBe("released");
    finish(); await release; await f.service.tick(now);
    expect(f.state.held).toBe(false); expect(f.repo.getRealm(realmId)?.service_state).toBe("stopped");
  });

  it("closes spawn admission before shutdown starts enumerating owned processes", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    f.processes.listManagedProcesses = async () => { enter(); await finished; return []; };
    const closing = f.service.close(); await entered;
    expect(() => f.service.markUsageStarted(permit.permit_id)).toThrow("account_service_closing");
    finish(); await closing;
    expect(f.state.held).toBe(false); expect(f.repo.getRealm(realmId)?.desired_enabled).toBe(true);
  });

  it("rejects account updates while a switch is probing and allows them after completion", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const probe = f.probe.probeUsage;
    f.probe.probeUsage = async (...args) => { enter(); await finished; return probe(...args); };
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    const tick = f.service.tick(now); await entered;
    const before = f.repo.getAccount(realmId, "B")!;
    expect(() => f.service.updateAccount(realmId, "B", { enabled: false }, before.revision, "disable-during-probe")).toThrow("operation_in_progress");
    expect(f.repo.getAccount(realmId, "B")).toEqual(before);
    finish(); await tick;
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    const backup = f.repo.getAccount(realmId, "C")!;
    expect(f.service.updateAccount(realmId, "C", { enabled: false, alias: "saved-backup" }, backup.revision, "disable-after-switch").state).toBe("disabled");
  });

  it("retries durable consumer delivery after restart without another credential install", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let deliveries = 0;
    const consumer: AccountConsumerPort = { listOccupancy: async () => [], prepareSwitch: async () => ({ savedRef: { key: "saved-runs" } }), quiesce: async () => {}, confirmStopped: async () => true, onAccountCommitted: async () => { deliveries++; throw new Error("temporary-delivery-error"); } };
    f.service.registerConsumer(consumer);
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    await f.service.tick(now); expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("recovering");
    await f.service.close();
    const restarted = new AgyAccountService(f.repo, f.auth, f.probe, f.processes, f.clock);
    restarted.registerConsumer({ ...consumer, onAccountCommitted: async (event) => { deliveries++; expect(event.saved_ref).toEqual({ key: "saved-runs" }); } });
    await restarted.reconcileStartup(); await restarted.tick(now);
    expect(f.state.writes).toEqual(["B"]); expect(deliveries).toBe(2); expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    await restarted.close();
  });

  async function quotaOnlyFixture() {
    const f = await fixture();
    await f.service.start({ realmId, requestId: "quota-start" });
    const query = f.probe.probeUsage;
    f.probe.probeUsage = async (...args) => ({ ...await query(...args), email: undefined });
    f.auth.inspectActive = async () => ({ exists: true, auth: { email: `${f.state.active.replace("saved_", "")}@example.test` } });
    f.auth.captureActive = async () => ({ secret_ref: f.state.active, credential_revision: 1,
      auth: { email: `${f.state.active.replace("saved_", "")}@example.test` } });
    return f;
  }

  it("accepts real quota-only /usage on successful release without falsely blocking the account realm", async () => {
    const f = await quotaOnlyFixture();
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    f.service.markUsageStarted(permit.permit_id);
    await f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: true });
    expect(f.repo.getRealm(realmId)).toMatchObject({ phase: "idle", service_state: "running" });
    expect(f.repo.getRealm(realmId)?.last_error).toBeUndefined();
    expect(f.repo.getQuotaSnapshot(realmId, "A", pool)?.windows[0]?.remaining_fraction).toBe(0.4);
  });

  it("rejects actual identity changes even when /usage omits the email", async () => {
    const f = await quotaOnlyFixture();
    const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    const original = f.repo.getQuotaSnapshot(realmId, "A", pool);
    const query = f.probe.probeUsage;
    f.probe.probeUsage = async (...args) => { const result = await query(...args); f.state.active = "saved_B"; return result; };
    await f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: true });
    expect(f.repo.getRealm(realmId)).toMatchObject({ phase: "blocked", last_error: "external_change" });
    expect(f.repo.getQuotaSnapshot(realmId, "A", pool)).toEqual(original);
    expect(f.repo.getAccount(realmId, "A")?.secret_ref).toBe("saved_A");
  });

  it("does not overwrite another account's credential or quota with an incorrectly labelled saved blob", async () => {
    const f = await quotaOnlyFixture();
    const originalQuota = f.repo.getQuotaSnapshot(realmId, "B", pool);
    const activate = f.auth.activateSaved;
    f.auth.activateSaved = async (realm, account, ref) => activate(realm, account, account === "B" ? "saved_A" : ref);
    await f.service.syncAndRefreshQuotas(realmId);
    expect(f.repo.getAccount(realmId, "B")).toMatchObject({ secret_ref: "saved_B", state: "reauth_required" });
    expect(f.repo.getQuotaSnapshot(realmId, "B", pool)).toEqual(originalQuota);
    expect(f.state.active).toBe("saved_A");
  });

  it("rejects an identity change between the quota query and credential capture", async () => {
    const f = await quotaOnlyFixture();
    const original = f.repo.getAccount(realmId, "A");
    f.state.external = true;
    const compare = f.auth.compareActive;
    f.auth.compareActive = async (...args) => f.state.probes.length ? false : compare(...args);
    f.auth.captureActive = async () => ({ secret_ref: "wrong_B", credential_revision: 2, auth: { email: "B@example.test" } });
    await f.service.syncAndRefreshQuotas(realmId);
    expect(f.repo.getAccount(realmId, "A")?.secret_ref).toBe(original?.secret_ref);
    expect(f.repo.getAccount(realmId, "A")?.auth.email).not.toBe("B@example.test");
    expect(f.repo.getAccount(realmId, "A")?.state).toBe("reauth_required");
  });

  it("keeps the credential cache key across releases when native credentials have not changed", async () => {
    const f = await quotaOnlyFixture();
    let captures = 0;
    f.auth.captureActive = async () => { captures++; throw new Error("unchanged credentials must reuse snapshot"); };
    const revisions: Array<number | undefined> = [];
    f.probe.probeModelAccess = async (_model, options) => { revisions.push(options?.credential_revision); return true; };
    for (let i = 0; i < 2; i++) {
      const permit = await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: `run-${i}`, usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
      await f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: true });
    }
    expect(captures).toBe(0);
    expect(revisions).toEqual([1, 1]);
    expect(f.repo.getRealm(realmId)?.last_error).toBeUndefined();
  });

  it.each(["managed", "permit"])("refreshes only the active account with %s activity and never reinstalls credentials", async (activity) => {
    const f = await quotaOnlyFixture();
    if (activity === "managed") f.processes.listManagedProcesses = async () => [{ pid: 123 }];
    if (activity === "permit") await f.service.acquireUsagePermit({ realm_id: realmId, consumer_id: "run", usage_kind: "execution", required_pool_ids: [pool], required_model_ids: [model] });
    const view = await f.service.syncAndRefreshQuotas(realmId);
    expect(view.refresh_scope).toBe("active_only");
    expect(f.state.probes).toEqual(["A"]);
    expect(f.state.writes).toEqual([]);
  });

  it.each([false, true])("refreshes all accounts and restores the original account with external CLI=%s", async external => {
    const f = await quotaOnlyFixture();
    f.state.external = external;
    const view = await f.service.syncAndRefreshQuotas(realmId);
    expect(view.refresh_scope).toBe("all");
    expect(f.state.probes).toEqual(["A", "B", "C"]);
    expect(f.state.writes).toEqual(["B", "C", "A"]);
    expect(f.state.active).toBe("saved_A");
  });

  it.each(["A", "B"])("preserves a switch accepted during the %s quota refresh", async (probingAccount) => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const usage = f.probe.probeUsage;
    let blocked = false;
    f.probe.probeUsage = async (...args) => {
      if (!blocked && f.state.active === `saved_${probingAccount}`) {
        blocked = true; entered(); await gate;
      }
      return usage(...args);
    };
    const refreshing = f.service.syncAndRefreshQuotas(realmId);
    await ready;
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "during-refresh", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    expect(f.repo.getRealm(realmId)?.pending_operation_id).toBe(receipt.operation_id);
    finish(); await refreshing;
    f.service.getPresentation(realmId); // The panel's normal polling used to cancel the lost request.
    expect(f.repo.getRealm(realmId)?.pending_operation_id).toBe(receipt.operation_id);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("queued");
    await f.service.tick(now);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("completed");
    expect(f.state.active).toBe("saved_B");
  });

  it("does not erase a switch accepted while syncing refreshed native credentials", async () => {
    const f = await fixture(); await f.service.start({ realmId, requestId: "start" });
    f.state.active = "renewed_A";
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    f.auth.inspectActive = async () => { entered(); await gate; return { exists: true, auth: { email: "A@example.test" } }; };
    const syncing = f.service.syncActiveAccountFromHost(realmId);
    await ready;
    const receipt = await f.service.requestOperation({ realm_id: realmId, request_id: "during-sync", kind: "switch", selection: { mode: "explicit", account_id: "B" } });
    finish(); await syncing; f.service.getPresentation(realmId);
    expect(f.repo.getRealm(realmId)?.pending_operation_id).toBe(receipt.operation_id);
    expect(f.repo.getOperation(receipt.operation_id)?.phase).toBe("queued");
  });

  it("recovers the old missing-email block only after a fresh identity-checked quota query", async () => {
    const f = await quotaOnlyFixture();
    f.state.external = true;
    f.repo.saveRealm({ ...f.repo.getRealm(realmId)!, phase: "blocked", last_error: "external_change" });
    await f.service.syncAndRefreshQuotas(realmId);
    expect(f.repo.getRealm(realmId)?.phase).toBe("idle");
    expect(f.repo.getRealm(realmId)?.last_error).toBeUndefined();
  });

  it("hides known misattributed quota and excludes that account from automatic selection", async () => {
    const f = await quotaOnlyFixture();
    const account = f.repo.getAccount(realmId, "B")!;
    f.repo.saveAccount({ ...account, auth: { ...account.auth, email: "A@example.test" } });
    const view = f.service.getPresentation(realmId);
    expect(view.accounts.find(a => a.id === "B")?.state).toBe("reauth_required");
    expect(view.snapshots.some(s => s.account_id === "B")).toBe(false);
    expect(view.candidates.some(c => c.account_id === "B")).toBe(false);
  });
});
