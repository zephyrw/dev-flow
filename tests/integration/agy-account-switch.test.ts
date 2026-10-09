import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import { AgyAccountService } from "../../packages/agy-accounts/src/service.js";
import type {
  AuthHostPort,
  AccountProbePort,
  ProcessHostPort,
  AccountConsumerPort,
  ConsumerOccupancy,
  AccountCommittedEvent,
} from "../../packages/agy-accounts/src/ports.js";
import type { AgyAccount, AgyQuotaSnapshot } from "../../packages/contracts/src/agy-account.js";

describe("AGY Account Switch Concurrency & CAS Integrity (AC-I04 & AC-I25)", () => {
  let tmpDir: string;
  let store: Store;
  let repo: AgyAccountRepository;
  let service: AgyAccountService;
  let mockProbe: AccountProbePort;
  let mockAuthHost: AuthHostPort;

  const eventsLog: string[] = [];

  const mockConsumer: AccountConsumerPort = {
    listOccupancy: async (): Promise<ConsumerOccupancy[]> => [],
    prepareSwitch: async (opId: string) => {
      eventsLog.push(`prepare:${opId}`);
      return { savedRef: { state: "paused" } };
    },
    quiesce: async (opId: string) => {
      eventsLog.push(`quiesce:${opId}`);
    },
    confirmStopped: async (opId: string) => {
      eventsLog.push(`confirm:${opId}`);
      return true;
    },
    onAccountCommitted: async (ev: AccountCommittedEvent) => {
      eventsLog.push(`committed:${ev.account_id}:${ev.auth_epoch}`);
    },
  };

  beforeEach(() => {
    eventsLog.length = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "devflow-switch-test-"));
    store = new Store(join(tmpDir, "store.db"));
    repo = new AgyAccountRepository(store);

    mockAuthHost = {
      capabilities: async () => ({ supported: true, platform: "win32", version: "3.0.0-node", dpapi_available: true, cred_manager_available: true, named_mutex_available: true }),
      isDomainLockHeld: () => true,
      compareActive: async () => true,
      acquireDomainLock: async () => ({ acquired: true, release: async () => {} }),
      inspectActive: async () => ({ exists: true, secret_ref: "vault-acc-1" }),
      activateSaved: async () => ({ credential_revision: 2 }),
      captureActive: async () => ({ secret_ref: "vault-backup-1", credential_revision: 1 }),
      restoreBackup: async () => {},
      clearActiveForLogin: async () => ({}),
      deleteSaved: async () => {},
    };

    mockProbe = {
      probeIdentity: async () => ({
        email: "target@example.com",
        cli_version: "1.2.7",
        raw_output: "agy whoami",
      }),
      probeUsage: async () => ({
        email: "target@example.com",
        cli_version: "1.2.7",
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.9,
            reset_at: null,
            observed_at: new Date().toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.6,
            reset_at: null,
            observed_at: new Date().toISOString(),
            status: "observed",
          },
        ],
        raw_output: "",
        pools: [{ pool_id: "fixture-pool", model_ids: ["fixture-model"], windows: [
          { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.9, reset_at: null, observed_at: new Date().toISOString(), status: "observed" },
          { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.6, reset_at: null, observed_at: new Date().toISOString(), status: "observed" },
        ] }], executable_fingerprint: "fixture", capability_verified: true,
      }),
      probeModelAccess: async () => true,
    };

    const mockProcessHost: ProcessHostPort = {
      listManagedProcesses: async () => [],
      findExternalAgyProcesses: async () => [],
      stopProcess: async () => true,
      confirmProcessesStopped: async () => true,
    };

    service = new AgyAccountService(repo, mockAuthHost, mockProbe, mockProcessHost);
    service.initializeSettings("default-agy-realm", { standalone_model_id: "fixture-model" });
    service.registerConsumer(mockConsumer);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await service.close();
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it.each([
    { model: null, quota: "available", expected: "completed", accountState: "ready" },
    { model: null, quota: "zero", expected: "completed", accountState: "waiting_quota" },
    { model: null, quota: "unknown", expected: "completed", accountState: "pending_quota" },
    { model: "fixture-model", quota: "unknown", expected: "failed", accountState: "pending_quota" },
    { model: null, quota: "unknown", expected: "failed", accountState: "pending_quota", managed: true },
    { model: null, quota: "unknown", expected: "failed", accountState: "ready", identityUnverified: true },
    { model: null, quota: "available", expected: "completed", accountState: "ready", identityUnverified: true },
  ])("manual identity selection with model=$model and quota=$quota, managed=$managed, identityUnverified=$identityUnverified", async ({ model, quota, expected, accountState, managed, identityUnverified }) => {
    const realmId = "default-agy-realm";
    const settings = repo.getSettings(realmId)!;
    repo.saveSettings({ ...settings, standalone_model_id: model });
    for (const [id, email] of [["acc-1", "acc1@example.com"], ["acc-2", "target@example.com"]] as const) {
      repo.saveAccount({
        id, realm_id: realmId, revision: 1, alias: id,
        identity: { email, verified_at: new Date().toISOString() },
        secret_ref: `vault-${id}`, credential_revision: 1, state: "ready",
        enrolled_at: new Date().toISOString(),
        auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
      });
    }
    const observation = await mockProbe.probeUsage();
    observation.pools = ["Gemini Models", "Claude and GPT models"].map(pool_id => ({
      pool_id, model_ids: [pool_id === "Gemini Models" ? "gemini-*" : "claude-*"],
      windows: observation.windows.map(window => ({ ...window, remaining_fraction: quota === "zero" ? 0 : window.remaining_fraction })),
    }));
    if (quota === "unknown") observation.pools = [];
    if (identityUnverified) {
      observation.email = undefined;
      vi.spyOn(mockProbe, "probeIdentity").mockRejectedValue(new Error("identity_unverified"));
      vi.spyOn(mockAuthHost, "inspectActive").mockResolvedValue({ exists: true, auth: { email: "target@example.com" } });
    }
    vi.spyOn(mockProbe, "probeUsage").mockResolvedValue(observation);
    const modelProbe = vi.spyOn(mockProbe, "probeModelAccess");
    await service.start({ realmId, requestId: "start-identity" });
    vi.spyOn(mockConsumer, "prepareSwitch").mockResolvedValue({ savedRef: { runs: [] } });
    if (managed) vi.spyOn(mockConsumer, "listOccupancy").mockResolvedValue([{
      consumer_id: "managed-run", permit_ids: [], can_pause: true,
      required_model_ids: ["gemini-3.8-flash"], required_pool_ids: ["Gemini Models", "global"], allowed_account_ids: null,
    }]);
    const realm = repo.getRealm(realmId)!;
    repo.saveRealm({ ...realm, active_account_id: "acc-1", active_secret_ref: "vault-acc-1", auth_epoch: 1, service_state: "stopped", desired_enabled: false });
    const accepted = await service.requestOperation({
      realm_id: realmId, request_id: "switch-identity", kind: "switch",
      selection: { mode: "explicit", account_id: "acc-2" }, expected_epoch: 1,
    });
    await service.tick(Date.now());
    expect(repo.getOperation(accepted.operation_id)?.phase).toBe(expected);
    expect(repo.getRealm(realmId)?.active_account_id).toBe(expected === "completed" ? "acc-2" : "acc-1");
    expect(repo.getAccount(realmId, "acc-2")?.state).toBe(accountState);
    expect(modelProbe).not.toHaveBeenCalled();
    if (expected === "failed") expect(repo.getOperation(accepted.operation_id)?.error).toBe(identityUnverified ? "identity_unverified" : "quota_capability_unavailable");
  });

  it.each([true, false])("coordinates manual switch with automation enabled=%s", async (enabled) => {
    const realmId = "default-agy-realm";

    const a1: AgyAccount = {
      id: "acc-1",
      realm_id: realmId,
      revision: 1,
      alias: "Account 1",
      identity: { email: "acc1@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-acc-1",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
    };
    const a2: AgyAccount = {
      id: "acc-2",
      realm_id: realmId,
      revision: 1,
      alias: "Account 2",
      identity: { email: "target@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-acc-2",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
    };
    repo.saveAccount(a1);
    repo.saveAccount(a2);

    await service.start({ realmId, requestId: "req-start" });

    const realm = repo.getRealm(realmId)!;
    realm.active_account_id = "acc-1";
    realm.auth_epoch = 1;
    if (!enabled) {
      realm.service_state = "stopped";
      realm.desired_enabled = false;
      vi.spyOn(mockConsumer, "prepareSwitch").mockResolvedValue({ savedRef: { runs: [] } });
    }
    repo.saveRealm(realm);
    for (const account of [a1, a2]) repo.saveQuotaSnapshot({ id: `q-${account.id}`, realm_id: realmId, account_id: account.id, auth_epoch: 1, pool_id: "fixture-pool", model_ids: ["fixture-model"], source: "official_cli_usage", cli_version: "fixture", parser_revision: 1, observed_at: new Date().toISOString(), executable_fingerprint: "fixture", capability_verified: true, windows: [
      { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.9, reset_at: null, observed_at: new Date().toISOString(), status: "observed" },
      { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.6, reset_at: null, observed_at: new Date().toISOString(), status: "observed" },
    ] });

    // Explicit switch to acc-2
    const res = await service.requestOperation({
      realm_id: realmId,
      request_id: "op-sw-1",
      kind: "switch",
      selection: { mode: "explicit", account_id: "acc-2" },
      expected_epoch: 1,
    });

    expect(res.phase).toBe("queued");
    await service.tick(Date.now());
    expect(repo.getOperation(res.operation_id)?.phase).toBe("completed");

    const updatedRealm = repo.getRealm(realmId)!;
    expect(updatedRealm.active_account_id).toBe("acc-2");
    expect(updatedRealm.auth_epoch).toBe(2);
    if (!enabled) {
      expect(updatedRealm.service_state).toBe("stopped");
      expect(updatedRealm.desired_enabled).toBe(false);
      expect(updatedRealm.pending_operation_id).toBeNull();
      return;
    }

    // Verify consumer lifecycle sequence was called in order
    expect(eventsLog.some(e => e.startsWith("prepare:"))).toBe(true);
    expect(eventsLog.some(e => e.startsWith("quiesce:"))).toBe(true);
    expect(eventsLog.some(e => e.startsWith("confirm:"))).toBe(true);
    expect(eventsLog).toContain("committed:acc-2:2");
  });

  it("enforces CAS epoch check and aborts if expected_epoch is mismatched", async () => {
    const realmId = "default-agy-realm";

    const a1: AgyAccount = {
      id: "acc-1",
      realm_id: realmId,
      revision: 1,
      alias: "Account 1",
      identity: { email: "acc1@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-acc-1",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
    };
    const a2: AgyAccount = {
      id: "acc-2",
      realm_id: realmId,
      revision: 1,
      alias: "Account 2",
      identity: { email: "target@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-acc-2",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
    };
    repo.saveAccount(a1);
    repo.saveAccount(a2);

    await service.start({ realmId, requestId: "req-start" });

    const realm = repo.getRealm(realmId)!;
    realm.active_account_id = "acc-1";
    realm.auth_epoch = 5; // current epoch is 5
    repo.saveRealm(realm);

    // Switch request expects epoch 4 (stale CAS)
    await expect(service.requestOperation({
      realm_id: realmId,
      request_id: "op-sw-stale",
      kind: "switch",
      selection: { mode: "explicit", account_id: "acc-2" },
      expected_epoch: 4,
    })).rejects.toThrow("epoch_conflict");

    const unchangedRealm = repo.getRealm(realmId)!;
    expect(unchangedRealm.active_account_id).toBe("acc-1");
    expect(unchangedRealm.auth_epoch).toBe(5);
  });
});
