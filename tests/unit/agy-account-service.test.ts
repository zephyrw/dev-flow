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
} from "../../packages/agy-accounts/src/ports.js";
import type { AgyAccount } from "../../packages/contracts/src/agy-account.js";

describe("AGY Account Service Lifecycle & Operations (AC-U17, AC-U18, AC-U20)", () => {
  let tmpDir: string;
  let store: Store;
  let repo: AgyAccountRepository;
  let mockAuthHost: AuthHostPort;
  let mockProbe: AccountProbePort;
  let mockProcessHost: ProcessHostPort;
  let service: AgyAccountService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "devflow-svc-test-"));
    store = new Store(join(tmpDir, "store.db"));
    repo = new AgyAccountRepository(store);

    mockAuthHost = {
      capabilities: async () => ({ supported: true, platform: "win32", version: "2.0.0", dpapi_available: true, cred_manager_available: true, named_mutex_available: true }),
      isDomainLockHeld: () => true,
      compareActive: async () => true,
      acquireDomainLock: async () => ({
        acquired: true,
        release: async () => {},
      }),
      inspectActive: async () => ({
        exists: true,
        secret_ref: "vault-acc-1",
      }),
      activateSaved: async () => ({ credential_revision: 1 }),
      captureActive: async () => ({ secret_ref: "vault-backup-1", credential_revision: 1 }),
      restoreBackup: async () => {},
      clearActiveForLogin: async () => ({}),
      deleteSaved: async () => {},
    };

    mockProbe = {
      probeUsage: async () => ({
        email: "target@example.com",
        cli_version: "1.2.7",
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.8,
            reset_at: null,
            observed_at: new Date().toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.5,
            reset_at: null,
            observed_at: new Date().toISOString(),
            status: "observed",
          },
        ],
        raw_output: "",
        pools: [], executable_fingerprint: "fixture", capability_verified: false,
      }),
      probeModelAccess: async () => true,
    };

    mockProcessHost = {
      listManagedProcesses: async () => [],
      findExternalAgyProcesses: async () => [],
      stopProcess: async () => true,
      confirmProcessesStopped: async () => true,
    };

    service = new AgyAccountService(
      repo,
      mockAuthHost,
      mockProbe,
      mockProcessHost,
    );
  });

  afterEach(async () => {
    await service.close();
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("starts and stops the service updating realm state accordingly (AC-U17)", async () => {
    const realmId = "default-agy-realm";

    const startRes = await service.start({
      realmId,
      requestId: "req-1",
    });
    expect(startRes.operation_id).toBe("op_start_req-1");

    const realmAfterStart = repo.getRealm(realmId);
    expect(realmAfterStart?.service_state).toBe("running");
    expect(realmAfterStart?.desired_enabled).toBe(true);

    const stopRes = await service.stop({
      realmId,
      requestId: "req-2",
    });
    expect(stopRes.operation_id).toBe("op_stop_req-2");

    const realmAfterStop = repo.getRealm(realmId);
    expect(realmAfterStop?.service_state).toBe("stopped");
    expect(realmAfterStop?.desired_enabled).toBe(false);
  });

  it("preserves whitelist and strict night policy when only auto_switch changes", () => {
    const before = service.updatePolicy("workflow", { auto_switch: false, allowed_account_ids: ["A"], night_pool: "strict", recreation_policy: "recreate_after_confirmed_unavailable" }, 0, "policy-create");
    const after = service.updatePolicy("workflow", { auto_switch: true }, before.revision, "policy-change");
    expect(after.allowed_account_ids).toEqual(["A"]);
    expect(after.night_pool).toBe("strict");
    expect(after.recreation_policy).toBe("recreate_after_confirmed_unavailable");
    expect(after.auto_switch).toBe(true);
  });

  it("preserves nondefault settings when only the target model changes", () => {
    const before = service.initializeSettings("realm", { workflow_auto_switch: false, pause_managed_for_manual_switch: false, switch_gap_seconds: 9 });
    const after = service.updateSettings("realm", { standalone_model_id: "new-model" }, before.revision, "settings-model");
    expect(after.workflow_auto_switch).toBe(false);
    expect(after.pause_managed_for_manual_switch).toBe(false);
    expect(after.switch_gap_seconds).toBe(9);
    expect(after.maintenance).toEqual(before.maintenance);
  });

  it("merges a single maintenance field without resetting the other schedule fields", () => {
    const initial = service.initializeSettings("realm");
    const before = service.updateSettings("realm", { maintenance: { timezone: "UTC", night_start: "21:30", night_end: "06:30", local_report_time: "16:45" } }, initial.revision, "schedule");
    const after = service.updateSettings("realm", { maintenance: { refresh_verified_max_age_hours: 12 } }, before.revision, "schedule-age");
    expect(after.maintenance).toEqual({ ...before.maintenance, refresh_verified_max_age_hours: 12 });
  });

  it("issues and releases usage permits during running state", async () => {
    const realmId = "default-agy-realm";

    // Setup account in repo
    const account: AgyAccount = {
      id: "acc-1",
      realm_id: realmId,
      revision: 1,
      alias: "Test Account",
      identity: { email: "acc1@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-acc-1",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, refresh_expiry_source: "not_provided" },
    };
    repo.saveAccount(account);

    await service.start({ realmId, requestId: "req-start" });

    // Ensure realm has active_account_id
    const realm = repo.getRealm(realmId)!;
    realm.active_account_id = "acc-1";
    realm.active_secret_ref = "vault-acc-1";
    realm.auth_epoch = 1;
    repo.saveRealm(realm);
    repo.saveQuotaSnapshot({ id: "q-permit", realm_id: realmId, account_id: "acc-1", auth_epoch: 1, pool_id: "default", model_ids: ["fixture-model"], source: "official_cli_usage", cli_version: "fixture", parser_revision: 1, observed_at: new Date().toISOString(), windows: (await mockProbe.probeUsage()).windows, executable_fingerprint: "fixture", capability_verified: true });

    const permit = await service.acquireUsagePermit({
      realm_id: realmId,
      consumer_id: "workflow-wf-1",
      usage_kind: "execution",
      required_pool_ids: ["default"],
    });

    expect(permit.account_id).toBe("acc-1");
    expect(permit.auth_epoch).toBe(1);

    const savedPermit = repo.getPermit(permit.permit_id);
    expect(savedPermit?.status).toBe("issued");

    await service.releaseUsagePermit(permit.permit_id, {
      permit_id: permit.permit_id,
      success: true,
    });

    const releasedPermit = repo.getPermit(permit.permit_id);
    expect(releasedPermit?.status).toBe("released");
  });

  it("rejects usage permit acquisition when service is stopped", async () => {
    const realmId = "default-agy-realm";
    await expect(
      service.acquireUsagePermit({
        realm_id: realmId,
        consumer_id: "workflow-wf-1",
        usage_kind: "execution",
        required_pool_ids: ["default"],
      }),
    ).rejects.toThrow("is not running");
  });

  it("rolls back safely and fails switch when target account activation fails (AC-U20)", async () => {
    const realmId = "default-agy-realm";

    const a1: AgyAccount = {
      id: "acc-active",
      realm_id: realmId,
      revision: 1,
      alias: "Active",
      identity: { email: "active@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-active",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, refresh_expiry_source: "not_provided" },
    };
    const a2: AgyAccount = {
      id: "acc-target",
      realm_id: realmId,
      revision: 1,
      alias: "Target",
      identity: { email: "target@example.com", verified_at: new Date().toISOString() },
      secret_ref: "vault-target",
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date().toISOString(),
      auth: { has_refresh_credential: true, refresh_expiry_source: "not_provided" },
    };
    repo.saveAccount(a1);
    repo.saveAccount(a2);

    await service.start({ realmId, requestId: "req-start" });
    const realm = repo.getRealm(realmId)!;
    realm.active_account_id = "acc-active";
    realm.auth_epoch = 1;
    repo.saveRealm(realm);
    service.initializeSettings(realmId);
    const settings = repo.getSettings(realmId)!; settings.standalone_model_id = "fixture-model"; repo.saveSettings(settings);
    for (const account of [a1, a2]) repo.saveQuotaSnapshot({ id: `q-${account.id}`, realm_id: realmId, account_id: account.id, auth_epoch: 1, pool_id: "default", model_ids: ["fixture-model"], source: "official_cli_usage", cli_version: "fixture", parser_revision: 1, observed_at: new Date().toISOString(), windows: (await mockProbe.probeUsage()).windows, executable_fingerprint: "fixture", capability_verified: true });

    // Make activation fail
    mockAuthHost.activateSaved = async () => {
      throw new Error("DPAPI decryption failed for target credentials");
    };

    const switchRes = await service.requestOperation({
      realm_id: realmId,
      request_id: "req-switch-1",
      kind: "switch",
      selection: { mode: "explicit", account_id: "acc-target" },
    });

    expect(switchRes.phase).toBe("queued");
    await service.tick(Date.now());
    expect(repo.getOperation(switchRes.operation_id)?.phase).toBe("failed");
    expect(repo.getOperation(switchRes.operation_id)?.error).toBe("credential_install_failed");

    // The active account should remain old or not be corrupted
    const realmAfterFailed = repo.getRealm(realmId)!;
    expect(realmAfterFailed.active_account_id).toBe("acc-active");
  });
});
