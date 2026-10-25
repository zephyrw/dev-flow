import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { AgyDomainCoordinator } from "../../packages/agy-accounts/src/coordinator.js";

const realm = "default-agy-realm";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
async function setup() {
  const store = new Store(":memory:"), f = accountFixture(store); f.seedAccounts();
  await f.service.start({ realmId: realm, requestId: "start" });
  cleanups.push(async () => { for (const p of f.repository.listPermits(realm)) f.repository.savePermit({ ...p, status: "released" });
    await f.service.close(); store.close(); });
  return f;
}
it("keeps two running permits and processes on their old identity, admits future commands on the committed identity", async () => {
  const f = await setup();
  const old: Awaited<ReturnType<typeof f.service.acquireUsagePermit>>[] = [];
  for (const id of ["one", "two"]) {
    const p = await f.service.acquireUsagePermit({ realm_id: realm, consumer_id: id, usage_kind: "execution",
      required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"] });
    f.service.markUsageStarted(p.permit_id, id === "one" ? 1001 : 1002); old.push(p);
  }
  vi.spyOn(f.processHost, "listManagedProcesses").mockResolvedValue(old.map((p, i) => ({ pid: 1001 + i, permit_id: p.permit_id, account_id: p.account_id, auth_epoch: p.auth_epoch })));
  const stop = vi.spyOn(f.processHost, "stopProcess"), quiesce = vi.fn();
  const prepare = vi.fn(async () => ({ savedRef: { runs: [] } }));
  f.service.registerConsumer({ listOccupancy: async () => [{ consumer_id: "one", permit_ids: old.map(p => p.permit_id),
    required_pool_ids: [], allowed_account_ids: null, can_pause: false }], prepareSwitch: prepare,
    quiesce, confirmStopped: async () => false, onAccountCommitted: vi.fn() });
  const settings = f.repository.getSettings(realm)!;
  f.repository.saveSettings({ ...settings, pause_managed_for_manual_switch: false });
  const epoch = f.repository.getRealm(realm)!.auth_epoch;
  const probe = f.probe.probeUsage;
  vi.spyOn(f.probe, "probeUsage").mockImplementation(async options => {
    expect(f.repository.getRealm(realm)).toMatchObject({ active_account_id: "a", auth_epoch: epoch });
    return probe(options);
  });
  const accepted = await f.service.requestOperation({ realm_id: realm, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  await f.service.tick(Date.now());
  expect(f.repository.getOperation(accepted.operation_id)?.phase).toBe("completed");
  expect(stop).not.toHaveBeenCalled(); expect(quiesce).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledWith(accepted.operation_id, { preserveRunning: true });
  for (const p of old) expect(f.repository.getPermit(p.permit_id)).toMatchObject({ status: "started", account_id: "a", auth_epoch: epoch });
  const next = await f.service.acquireUsagePermit({ realm_id: realm, consumer_id: "next", usage_kind: "execution",
    required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"] });
  expect(next).toMatchObject({ account_id: "b", auth_epoch: epoch + 1 });
});
it("coalesces concurrent refreshes, never installs another credential and accepts switching while the probe waits", async () => {
  const f = await setup();
  const install = vi.spyOn(f.authHost, "activateSaved");
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probe = f.probe.probeUsage;
  vi.spyOn(f.probe, "probeUsage").mockImplementationOnce(async options => { entered(); await gate; return probe(options); });
  const first = f.service.syncAndRefreshQuotas(); await started;
  const second = f.service.syncAndRefreshQuotas(); expect(first).toBe(second);
  const op = await f.service.requestOperation({ realm_id: realm, request_id: "switch", kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  expect(op.phase).toBe("queued"); expect(f.service.getPresentation(realm).accounts).toHaveLength(3);
  release(); expect((await first).refresh_scope).toBe("active_only");
  expect(install).not.toHaveBeenCalled();
  await f.service.tick(Date.now()); expect(f.active()).toBe("b");
});
it("lets a manual operation overtake an unstarted background refresh", async () => {
  const queue = new AgyDomainCoordinator(), order: string[] = [];
  let release!: () => void;
  const current = queue.enqueue(() => new Promise<void>(resolve => { release = resolve; }));
  const background = queue.enqueue(async () => { order.push("refresh"); }, "background");
  const manual = queue.enqueue(async () => { order.push("switch"); });
  release(); await Promise.all([current, background, manual]); expect(order).toEqual(["switch", "refresh"]);
});

it("cancels release-time quota collection and waits for its real exit before switching", async () => {
  const f = await setup();
  const permit = await f.service.acquireUsagePermit({ realm_id: realm, consumer_id: "finishing", usage_kind: "execution", required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"] });
  f.service.markUsageStarted(permit.permit_id, 1001);
  const probe = f.probe.probeUsage;
  let entered!: () => void, exit!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const exited = new Promise<void>(resolve => { exit = resolve; });
  vi.spyOn(f.probe, "probeUsage").mockImplementationOnce(async options => {
    signal = options?.signal; entered(); await exited; return probe(options);
  });
  const collecting = f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: true });
  await started;
  const op = await f.service.requestOperation({ realm_id: realm, request_id: "switch-during-tail", kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  expect(signal?.aborted).toBe(true);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.active()).toBe("a"); expect(f.repository.getOperation(op.operation_id)?.phase).toBe("queued");
  exit(); await collecting;
  await vi.waitFor(() => expect(f.active()).toBe("b"));
  expect(f.repository.getRealm(realm)?.last_error).not.toBe("final_snapshot_failed");
});

it("retains the credential lock and blocks switching when a cancelled probe cannot confirm exit", async () => {
  const f = await setup();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(f.probe, "probeUsage").mockImplementationOnce(options => new Promise((_, reject) => {
    entered(); options!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("stop unknown"), { code: "PROCESS_STOP_UNCONFIRMED" })), { once: true });
  }));
  const refresh = f.service.syncAndRefreshQuotas();
  const failure = expect(refresh).rejects.toMatchObject({ code: "PROCESS_STOP_UNCONFIRMED" });
  await started;
  const op = await f.service.requestOperation({ realm_id: realm, request_id: "unconfirmed-probe", kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  await failure;
  await new Promise(resolve => setImmediate(resolve));
  expect(f.repository.getOperation(op.operation_id)).toMatchObject({ phase: "blocked", error: "process_stop_unconfirmed" });
  expect(f.repository.getRealm(realm)).toMatchObject({ phase: "blocked", last_error: "process_stop_unconfirmed" });
  expect(f.authHost.isDomainLockHeld(realm)).toBe(true); expect(f.active()).toBe("a");
});

it("cancels only a background quota query when a manual switch is accepted, and never marks a healthy account logged out", async () => {
  const f = await setup(), stop = vi.spyOn(f.processHost, "stopProcess");
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(f.probe, "probeUsage").mockImplementationOnce(options => new Promise((_, reject) => {
    entered(); options!.signal!.addEventListener("abort", () => reject(new Error("identity_unverified")), { once: true });
  }));
  const refresh = f.service.syncAndRefreshQuotas(); await started;
  await f.service.requestOperation({ realm_id: realm, request_id: "cancel-only-query", kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  await refresh;
  expect(f.repository.getAccount(realm, "a")?.state).not.toBe("reauth_required");
  await f.service.tick(Date.now()); expect(f.active()).toBe("b"); expect(stop).not.toHaveBeenCalled();
});
it("blocks new starts on lock loss without killing a running command", async () => {
  const f = await setup(), stop = vi.spyOn(f.processHost, "stopProcess");
  vi.spyOn(f.authHost, "isDomainLockHeld").mockReturnValue(false);
  vi.spyOn(f.processHost, "listManagedProcesses").mockResolvedValue([{ pid: 1001 }]);
  await f.service.tick(Date.now());
  expect(f.repository.getRealm(realm)?.last_error).toBe("domain_lock_lost");
  expect(stop).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

it("switches a refreshed credential locally when its email remains but its ID-token subject is absent", async () => {
  const f = await setup();
  const target = f.repository.getAccount(realm, "b")!;
  f.repository.saveAccount({ ...target, identity: { ...target.identity, subject: "old-subject" } });
  vi.spyOn(f.authHost, "inspectActive").mockImplementation(async () => ({ exists: true,
    auth: { email: `${f.active()}@example.com`, has_refresh_credential: true } }));
  const usage = vi.spyOn(f.probe, "probeUsage"), identity = vi.spyOn(f.probe, "probeIdentity");
  const model = vi.spyOn(f.probe, "probeModelAccess");
  const accepted = await f.service.requestOperation({ realm_id: realm, request_id: "refreshed-local",
    kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  await f.service.tick(Date.now());
  expect(f.repository.getOperation(accepted.operation_id)?.phase).toBe("completed");
  expect(f.active()).toBe("b");
  expect(usage).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled(); expect(model).not.toHaveBeenCalled();
});

it.each([false, true])("recovers an enabled but stopped service before manual switching, with retained lease %s", async held => {
  const f = await setup();
  if (!held) await (await f.authHost.acquireDomainLock(realm)).release?.();
  f.repository.saveRealm({ ...f.repository.getRealm(realm)!, service_state: "stopped", phase: "stopped", desired_enabled: true });
  const receipt = await f.service.requestOperation({ realm_id: realm, request_id: "resume-service",
    kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  await f.service.tick(Date.now());
  expect(f.repository.getOperation(receipt.operation_id)?.phase).toBe("completed");
  expect(f.repository.getRealm(realm)).toMatchObject({ service_state: "running", desired_enabled: true, phase: "idle", active_account_id: "b" });
  expect(f.authHost.isDomainLockHeld(realm)).toBe(true);
});

it("retains an unverified rollback through housekeeping and startup instead of erasing its blocker", async () => {
  const f = await setup();
  const receipt = await f.service.requestOperation({ realm_id: realm, request_id: "unverified-rollback",
    kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  f.repository.saveOperation({ ...f.repository.getOperation(receipt.operation_id)!, phase: "blocked",
    before_secret_ref: "saved-a", deadline_at: new Date(Date.now() - 1000).toISOString() });
  f.repository.saveRealm({ ...f.repository.getRealm(realm)!, service_state: "blocked", phase: "blocked", last_error: "external_change" });
  f.service.cleanStalePendingOperationLocked(realm);
  await f.service.reconcileStartup();
  expect(f.repository.getOperation(receipt.operation_id)?.phase).toBe("blocked");
  expect(f.repository.getRealm(realm)).toMatchObject({ phase: "blocked", pending_operation_id: receipt.operation_id, last_error: "external_change" });
  await expect(f.service.requestOperation({ realm_id: realm, request_id: "must-not-overwrite", kind: "switch",
    selection: { mode: "explicit", account_id: "c" } })).rejects.toThrow("operation_in_progress");
  expect(f.active()).toBe("a");
});
