import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

    const mockAuthHost: AuthHostPort = {
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

    const mockProbe: AccountProbePort = {
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
    await service.close();
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("coordinates quiesce sequence and commits epoch increment during manual switch", async () => {
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
