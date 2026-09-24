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
} from "../../packages/agy-accounts/src/ports.js";

describe("W03 D03修复验证：关闭自动调度时手动录入one-shot闭环测试", () => {
  let tmpDir: string;
  let store: Store;
  let repo: AgyAccountRepository;
  let mockAuthHost: AuthHostPort;
  let mockProbe: AccountProbePort;
  let mockProcessHost: ProcessHostPort;
  let service: AgyAccountService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "devflow-enroll-oneshot-"));
    store = new Store(join(tmpDir, "store.db"));
    repo = new AgyAccountRepository(store);

    mockAuthHost = {
      capabilities: async () => ({
        supported: true,
        platform: "win32",
        version: "3.0.0-node",
        dpapi_available: true,
        cred_manager_available: true,
        named_mutex_available: true,
      }),
      isDomainLockHeld: () => true,
      compareActive: async () => true,
      acquireDomainLock: async () => ({
        acquired: true,
        release: async () => {},
      }),
      inspectActive: async () => ({
        exists: true,
        secret_ref: "vault-acc-1",
        auth: {
          email: "user@example.com",
          metadata_status: "verified",
        } as any,
      }),
      activateSaved: async () => ({ credential_revision: 1 }),
      captureActive: async () => ({
        secret_ref: "vault-backup-1",
        credential_revision: 1,
      }),
      restoreBackup: async () => {},
      clearActiveForLogin: async () => ({}),
      deleteSaved: async () => {},
    };

    mockProbe = {
      probeIdentity: async () => ({
        email: "user@example.com",
        cli_version: "1.2.8",
        raw_output: "whoami",
      }),
      probeUsage: async () => ({
        email: "user@example.com",
        cli_version: "1.2.8",
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.85,
            reset_at: "2026-09-30T09:58:52Z",
            observed_at: new Date().toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.21,
            reset_at: "2026-09-24T05:33:38Z",
            observed_at: new Date().toISOString(),
            status: "observed",
          },
        ],
        raw_output: "",
        pools: [
          {
            pool_id: "Gemini Models",
            model_ids: ["*"],
            windows: [
              {
                kind: "weekly",
                duration_minutes: 10080,
                remaining_fraction: 0.85,
                reset_at: "2026-09-30T09:58:52Z",
                observed_at: new Date().toISOString(),
                status: "observed",
              },
              {
                kind: "five_hour",
                duration_minutes: 300,
                remaining_fraction: 0.21,
                reset_at: "2026-09-24T05:33:38Z",
                observed_at: new Date().toISOString(),
                status: "observed",
              },
            ],
          },
        ],
        executable_fingerprint: "fake-sha256",
        capability_verified: true,
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

  it("D03: 注册了无恢复任务的 Consumer 时，关闭自动调度也能完成录入收尾并保持关闭", async () => {
    const realmId = "default-agy-realm";
    service.initializeSettings(realmId);
    repo.saveRealm({
      realm_id: realmId,
      owner: "system",
      revision: 1,
      phase: "idle",
      service_state: "stopped",
      desired_enabled: false,
      auth_epoch: 1,
      control_generation: 1,
      active_account_id: null,
      pending_operation_id: null,
    });

    // 确保当前处于 stopped 且 desired_enabled = false
    const realm = repo.getRealm(realmId)!;
    expect(realm.service_state).toBe("stopped");
    expect(realm.desired_enabled).toBe(false);

    // 模拟注册类似 AgyWorkflowBridge 的 consumer，prepareSwitch 返回空恢复列表
    const mockWorkflowConsumer: AccountConsumerPort = {
      listOccupancy: async () => [],
      prepareSwitch: async (opId: string) => ({
        savedRef: { operation_id: opId, runs: [] },
      }),
      quiesce: async () => {},
      confirmStopped: async () => true,
      onAccountCommitted: async () => {},
    };
    service.registerConsumer(mockWorkflowConsumer, "workflow");

    // 发起录入当前账号操作
    const enrollResult = await service.requestOperation({
      realm_id: realmId,
      kind: "enroll",
      mode: "capture_current",
      alias: "本机导入测试",
      request_id: "req-enroll-1",
    });

    expect(enrollResult.phase).toBe("queued");
    expect(enrollResult.operation_id).toBeDefined();

    // 驱动状态机 tick
    await service.tick(Date.now());

    // 验证操作已经进入 completed 终态，未被 stopped 状态卡死
    const op = repo.getOperation(enrollResult.operation_id!)!;
    expect(op.phase).toBe("completed");

    // 验证 realm 状态：pending_operation_id 已被清空，且保持 stopped 与 desired_enabled = false
    const updatedRealm = repo.getRealm(realmId)!;
    expect(updatedRealm.pending_operation_id).toBeFalsy();
    expect(updatedRealm.service_state).toBe("stopped");
    expect(updatedRealm.desired_enabled).toBe(false);

    // 验证账号已保存且双额度均完成
    const accounts = repo.listAccounts(realmId);
    expect(accounts.length).toBeGreaterThan(0);
    const enrolled = accounts.find((a) => a.identity.email === "user@example.com");
    expect(enrolled).toBeDefined();
    expect(enrolled?.state).toBe("ready");
    expect(enrolled?.enrollment_completed_at).toBeDefined();
  });
});
