import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import { AgyAccountService } from "../../packages/agy-accounts/src/service.js";
import { AgyReconciler } from "../../packages/agy-accounts/src/reconcile.js";
import { isQuotaPoolVerified, requiredQuotaPools } from "../../packages/agy-accounts/src/quota.js";
import { selectCandidates } from "../../packages/agy-accounts/src/selector.js";
import type { AuthHostPort, AccountProbePort, ProcessHostPort, ModelProbeLifecycle } from "../../packages/agy-accounts/src/ports.js";
import type { AgyAccount, AgyQuotaSnapshot, AgyUsagePermit, QuotaWindow } from "../../packages/contracts/src/agy-account.js";
import { AgyRealmSchema } from "../../packages/contracts/src/agy-account.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import type { RunTelemetry } from "../../packages/runtime/src/run-telemetry.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import type { LimitedCliHandle, LimitedCliResult } from "../../packages/core/src/model-catalog-service.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";

const realmId = "default-agy-realm";
const observedAt = "2026-10-04T10:00:00.000Z";
const nowMs = Date.parse(observedAt);
const windows: QuotaWindow[] = [
  { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.8, reset_at: "2026-10-11T10:00:00.000Z", observed_at: observedAt, status: "observed" },
  { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.8, reset_at: "2026-10-04T15:00:00.000Z", observed_at: observedAt, status: "observed" },
];
const account: AgyAccount = {
  id: "account-a", realm_id: realmId, revision: 1, alias: "A",
  identity: { email: "a@example.com", verified_at: observedAt }, secret_ref: "fixture-secret-ref",
  credential_revision: 1, state: "pending_quota", enrolled_at: observedAt,
  auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
};
const snapshot = (poolId: string, modelIds: string[]): AgyQuotaSnapshot => ({
  id: `snapshot-${poolId.replace(/[^a-zA-Z0-9_-]/g, "_")}`, realm_id: realmId, account_id: account.id, auth_epoch: 1,
  pool_id: poolId, model_ids: modelIds, source: "official_cli_usage", cli_version: "fixture",
  parser_revision: 1, executable_fingerprint: "fixture", capability_verified: true, observed_at: observedAt, windows,
});
const permit = (id = "permit-a"): AgyUsagePermit => ({
  permit_id: id, realm_id: realmId, account_id: "unmanaged", auth_epoch: 1, consumer_id: "run-a",
  usage_kind: "execution", status: "started", process_id: 123, issued_at: observedAt,
  required_pool_ids: [], allowed_account_ids: null, model_id: "gemini-3.8-flash", model_category: "gemini",
});

describe("AGY review regressions U03/U04/I03", () => {
  let directory: string;
  let store: Store;
  let repository: AgyAccountRepository;
  let service: AgyAccountService;
  let locked: boolean;
  let auth: AuthHostPort;
  let processHost: ProcessHostPort;
  const probe = {} as AccountProbePort;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agy-category-repair-"));
    store = new Store(join(directory, "store.db"));
    repository = new AgyAccountRepository(store);
    locked = false;
    auth = {
      isDomainLockHeld: () => locked,
      acquireDomainLock: async () => {
        locked = true;
        return { acquired: true, release: async () => { locked = false; } };
      },
      compareActive: async () => false,
      capabilities: async () => ({
        supported: true,
        platform: "win32",
        dpapi_available: true,
        cred_manager_available: true,
        named_mutex_available: true,
        version: "1.0",
      }),
      inspectActive: async () => ({ exists: false }),
      captureActive: async () => ({ secret_ref: "dummy", credential_revision: 1 }),
      activateSaved: async () => ({ credential_revision: 1 }),
      restoreBackup: async () => {},
      clearActiveForLogin: async () => ({}),
      deleteSaved: async () => {},
    };
    processHost = {
      listManagedProcesses: vi.fn(async () => []), findExternalAgyProcesses: async () => [],
      stopProcess: async () => false, confirmProcessesStopped: async () => false,
      confirmPermitStopped: vi.fn(async () => false),
    };
    service = new AgyAccountService(repository, auth, probe, processHost);
  });
  afterEach(async () => {
    await service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("nonmanaged probes reserve a category until confirmed exit, including timeout settlement", async () => {
    let lifecycle!: ModelProbeLifecycle;
    await service.withCategoryVerification(realmId, "claude-opus-5-5", async current => {
      lifecycle = current;
      current.started(456);
      return { timedOut: true };
    });
    expect(service.isManaged()).toBe(false);
    expect(service.getActiveCategory().category).toBe("other");
    const invoke = vi.fn();
    await expect(service.withCategoryVerification(realmId, "gemini-3.8-flash", invoke)).rejects.toMatchObject({ code: "agy_category_conflict" });
    expect(invoke).not.toHaveBeenCalled();
    lifecycle.stopped();
    expect(service.getActiveCategory().category).toBeNull();
  });

  it("a cancellation before launching releases only its own probe permit", async () => {
    repository.savePermit(permit());
    await expect(service.withCategoryVerification(realmId, "gemini-3.8-flash", async () => {
      throw new Error("cancelled before launch");
    })).rejects.toThrow("cancelled before launch");
    expect(repository.getPermit("permit-a")?.status).toBe("started");
    expect(repository.listPermits().filter(p => p.status === "released")).toHaveLength(1);
  });

  it("reconciliation checks its lock before querying and retains failed/unknown process observations", async () => {
    repository.savePermit(permit());
    const reconciler = new AgyReconciler(repository, auth, probe, processHost);
    await expect(reconciler.reconcilePermits(realmId)).rejects.toThrow("domain_lock_lost");
    expect(processHost.confirmPermitStopped).not.toHaveBeenCalled();
    locked = true;
    vi.mocked(processHost.confirmPermitStopped!).mockRejectedValue(new Error("identity unknown"));
    await expect(reconciler.reconcilePermits(realmId)).rejects.toThrow("identity unknown");
    expect(repository.getPermit("permit-a")?.status).toBe("started");
    vi.mocked(processHost.confirmPermitStopped!).mockResolvedValue(false);
    await reconciler.reconcilePermits(realmId);
    expect(repository.getPermit("permit-a")?.status).toBe("started");
  });

  it("startup and later ticks reconcile nonmanaged permits without creating or enabling a realm", async () => {
    repository.savePermit(permit());
    await service.reconcileStartup();
    expect(repository.getPermit("permit-a")?.status).toBe("started");
    vi.mocked(processHost.confirmPermitStopped!).mockImplementation(async current => {
      expect(locked).toBe(true);
      expect(current.consumer_id).toBe("run-a");
      return true;
    });
    await service.tick(nowMs);
    expect(repository.getPermit("permit-a")?.status).toBe("released");
    expect(repository.getRealm(realmId)).toBeUndefined();
    expect(locked).toBe(false);
  });

  it("management context includes the category alongside a real global constraint", () => {
    const other = snapshot("Claude and GPT models", ["claude-opus-5-5"]);
    const global = snapshot("global", ["*"]);
    expect(requiredQuotaPools([global, other], ["global"], [], "other")?.map(p => p.pool_id))
      .toEqual(["global", "Claude and GPT models"]);
    expect(requiredQuotaPools([global, other], ["global"], [], "unknown")).toBeNull();
    const exhausted = { ...other, windows: windows.map(w => ({ ...w, remaining_fraction: 0 })) };
    const selection = selectCandidates([account], [global, exhausted], ["global"], nowMs, { active_category: "other" });
    expect(selection.ranked_candidates).toHaveLength(0);
  });

  it("failed runtime cleanup preserves category occupancy until the exact process exit is confirmed", async () => {
    const observe = vi.fn(async () => ({ state: "unknown" as "unknown" | "confirmed_exited" }));
    const manager = { get: () => ({}), hasStartAttempt: () => true, observe } as unknown as ProcessManager;
    const bridge = new AgyWorkflowBridge(service, manager);
    const binding = await bridge.prepareProfileRun("wf-a", { id: "run-a" } as Run, "gemini-3.8-flash");
    service.markUsageStarted(binding!.permit_id, 123);
    await bridge.releaseRun("run-a", false, "process_failed");
    expect(repository.getPermit(binding!.permit_id)?.status).toBe("started");
    expect(await bridge.listOccupancy()).toHaveLength(1);
    await expect(service.withCategoryVerification(realmId, "claude-opus-5-5", async () => {}))
      .rejects.toMatchObject({ code: "agy_category_conflict" });
    observe.mockResolvedValue({ state: "confirmed_exited" });
    await bridge.releaseRun("run-a", false, "process_failed");
    expect(repository.getPermit(binding!.permit_id)?.status).toBe("released");
    expect(await bridge.listOccupancy()).toHaveLength(0);
    bridge.dispose();
  });

  it("prelaunch invocation failure releases its own issued permit without treating an unknown old attempt as exited", async () => {
    const manager = { get: () => undefined, hasStartAttempt: () => false } as unknown as ProcessManager;
    const bridge = new AgyWorkflowBridge(service, manager);
    const binding = await bridge.prepareProfileRun("wf-a", { id: "run-a" } as Run, "gemini-3.8-flash");
    await bridge.releaseRun("run-a", false, "invocation_failed");
    expect(repository.getPermit(binding!.permit_id)?.status).toBe("released");
    repository.savePermit(permit());
    await bridge.releaseRun("run-a", false, "process_failed");
    expect(repository.getPermit("permit-a")?.status).toBe("started");
    bridge.dispose();
  });

  it("a probe cancellation exposes unknown stopping and can retry the retained handle", async () => {
    const access = new ModelAccessService(store);
    const jobId = randomUUID(), accessKey = "cancel-access";
    store.put("model_verification_job", jobId, accessKey, {
      id: jobId, request_id: randomUUID(), access_key: accessKey, status: "checking",
      started_at: observedAt, deadline_at: observedAt, retryable: false,
    });
    access.putAccess({ key: accessKey, status: "checking", checked_at: observedAt, adapterId: "agy",
      cliFingerprint: "fixture", accountScope: "fixture", providerScope: "fixture", accessModelKey: "claude-opus-5-5",
      verification_method: "native-probe", identityConfidence: "account" });
    const stop = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new FlowError("PROCESS_STOP_UNCONFIRMED", "停止未确认", 409))
      .mockResolvedValue(undefined);
    const handle: LimitedCliHandle = {
      cancel: stop,
      result: new Promise<LimitedCliResult>(() => {}),
    };
    const probes = access as unknown as {
      live: Map<string, { jobId: string; accessKey: string; handle: LimitedCliHandle }>;
      inflight: Map<string, string>;
    };
    probes.live.set(jobId, { jobId, accessKey, handle });
    probes.inflight.set(accessKey, jobId);
    store.put("model_probe_process", jobId, accessKey, { job_id: jobId, process_id: "fixture-process", access_key: accessKey });
    expect(await access.cancel(jobId)).toMatchObject({ status: "failed", error_code: "PROCESS_STOP_UNCONFIRMED", retryable: true });
    expect(access.getAccess(accessKey)?.status).toBe("environment_error");
    expect(store.get("model_probe_process", jobId)).toBeDefined();
    expect(await access.cancel(jobId)).toMatchObject({ status: "cancelled" });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(store.get("model_probe_process", jobId)).toBeUndefined();
    expect(access.getAccess(accessKey)?.status).toBe("unverified");
    await access.close();
  });

  it("an unrelated invalid pool does not exclude valid demanded quota on a legacy pending account", () => {
    const other = snapshot("Claude and GPT models", ["claude-opus-5-5"]);
    const invalid = { ...snapshot("Gemini Models", ["gemini-3.8-flash"]), capability_verified: false };
    const selection = selectCandidates([account], [other, invalid], ["global"], nowMs, { active_category: "other" });
    expect(selection.ranked_candidates.map(candidate => candidate.account_id)).toEqual([account.id]);
    expect(isQuotaPoolVerified({ capability_verified: true, executable_fingerprint: "fixture" }, invalid)).toBe(false);
  });

  it("runtime quota selects the bound category, uses reset seconds and does not fabricate unknown values", () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    repository.saveRealm(AgyRealmSchema.parse({ realm_id: realmId, owner: "fixture", active_account_id: account.id, auth_epoch: 1 }));
    repository.saveQuotaSnapshot(snapshot("global", ["*"]));
    repository.saveQuotaSnapshot(snapshot("Claude and GPT models", ["claude-opus-5-5"]));
    const bridge = new AgyWorkflowBridge(service, {} as ProcessManager);
    const bindings = (bridge as unknown as { activeRuns: Map<string, { account_id: string; auth_epoch: number }> }).activeRuns;
    bindings.set("run-a", { account_id: account.id, auth_epoch: 1 });
    const accountQuota = vi.fn();
    let stop = bridge.observeAccountQuota("run-a", "claude-opus-5-5", { accountQuota } as unknown as RunTelemetry);
    stop();
    const [buckets, sourceTime] = accountQuota.mock.calls[0]!;
    expect(buckets.map((bucket: { id: string }) => bucket.id)).toEqual(["Claude and GPT models"]);
    expect(buckets[0].windows[0].resets_at).toBe(Date.parse(windows[0]!.reset_at!) / 1000);
    expect(sourceTime).toBe(observedAt);

    repository.saveQuotaSnapshot({ ...snapshot("Claude and GPT models", ["claude-opus-5-5"]), capability_verified: false });
    accountQuota.mockClear();
    stop = bridge.observeAccountQuota("run-a", "claude-opus-5-5", { accountQuota } as unknown as RunTelemetry);
    stop();
    expect(accountQuota.mock.calls[0]![0][0].windows).toEqual([]);

    bindings.set("run-a", { account_id: "unmanaged", auth_epoch: 1 });
    accountQuota.mockClear();
    stop = bridge.observeAccountQuota("run-a", "claude-opus-5-5", { accountQuota } as unknown as RunTelemetry);
    stop();
    expect(accountQuota).not.toHaveBeenCalled();
  });

  it("a global-only runtime observation leaves category windows unknown", () => {
    vi.spyOn(Date, "now").mockReturnValue(nowMs);
    repository.saveRealm(AgyRealmSchema.parse({ realm_id: realmId, owner: "fixture", active_account_id: account.id, auth_epoch: 1 }));
    repository.saveQuotaSnapshot(snapshot("global", ["*"]));
    const bridge = new AgyWorkflowBridge(service, {} as ProcessManager);
    (bridge as unknown as { activeRuns: Map<string, unknown> }).activeRuns.set("run-a", { account_id: account.id, auth_epoch: 1 });
    const accountQuota = vi.fn();
    bridge.observeAccountQuota("run-a", "claude-opus-5-5", { accountQuota } as unknown as RunTelemetry)();
    expect(accountQuota.mock.calls[0]![0]).toEqual([{ id: "Claude and GPT models", model: "claude-opus-5-5", windows: [] }]);
    bridge.dispose();
  });
});
