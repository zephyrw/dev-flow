import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getAgyModelCategory,
  buildAgyCandidateEntry,
  AGY_55_CANDIDATE_IDS,
} from "../../packages/adapters/agy/src/model-configuration.js";
import { formatModelName } from "../../packages/presentation/src/model-display.js";
import { selectCandidates } from "../../packages/agy-accounts/src/selector.js";
import { Store } from "../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import { AgyAccountService } from "../../packages/agy-accounts/src/service.js";
import type { AgyAccount, AgyQuotaSnapshot } from "../../packages/contracts/src/agy-account.js";

describe("AGY 类别并发与额度池单元测试 (U02, U03, U04)", () => {
  describe("U02: 5.5 目录候补条目、token、未知思考强度与展示名兼容", () => {
    it("正确识别模型类别：Gemini 模型为 gemini，Claude/GPT 为 other", () => {
      expect(getAgyModelCategory("gemini-3.8-flash-high")).toBe("gemini");
      expect(getAgyModelCategory("gemini-3.7-flash")).toBe("gemini");
      expect(getAgyModelCategory("gemini-3.1-pro")).toBe("gemini");
      expect(getAgyModelCategory("claude-opus-5-5")).toBe("other");
      expect(getAgyModelCategory("claude-sonnet-5-5")).toBe("other");
      expect(getAgyModelCategory("claude-sonnet-4-6")).toBe("other");
      expect(getAgyModelCategory("gpt-oss-120b-medium")).toBe("other");
      expect(getAgyModelCategory(null)).toBe("unknown");
      expect(getAgyModelCategory("unknown-custom-model")).toBe("unknown");
    });

    it("5.5 候补条目思考强度标记为 unknown，不臆造强度，标记为 candidate", () => {
      for (const modelId of AGY_55_CANDIDATE_IDS) {
        const candidate = buildAgyCandidateEntry(modelId);
        expect(candidate.nativeId).toBe(modelId);
        expect(candidate.availability).toBe("candidate");
        expect(candidate.effort.status).toBe("unknown");
        expect(candidate.effort.values).toEqual([]);
      }
    });

    it("展示名称正确格式化为 Claude Opus 5.5 与 Claude Sonnet 5.5", () => {
      expect(formatModelName("agy", "claude-opus-5-5")).toBe("Claude Opus 5.5");
      expect(formatModelName("agy", "claude-sonnet-5-5")).toBe("Claude Sonnet 5.5");
    });
  });

  describe("U03: 相反池余额评估、所属窗口耗尽及不跨池串扰", () => {
    const nowMs = 1700000000000;
    const buildAccount = (id: string, email: string): AgyAccount => ({
      id,
      realm_id: "default-agy-realm",
      revision: 1,
      alias: id,
      identity: { email, verified_at: new Date(nowMs).toISOString() },
      secret_ref: `vault-${id}`,
      credential_revision: 1,
      state: "ready",
      enrolled_at: new Date(nowMs).toISOString(),
      auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
    });

    const accountA = buildAccount("acc-a", "a@example.com");
    const accountB = buildAccount("acc-b", "b@example.com");

    // 账号 A: Gemini 0%, Claude 80% (used 20%)
    // 账号 B: Gemini 90% (used 10%), Claude 20% (used 80%)
    const snapshots: AgyQuotaSnapshot[] = [
      {
        id: "snap-a-gemini",
        account_id: "acc-a",
        auth_epoch: 1,
        realm_id: "default-agy-realm",
        pool_id: "Gemini Models",
        model_ids: ["gemini-3.8-flash"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        observed_at: new Date(nowMs).toISOString(),
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.0,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.0,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
        ],
      },
      {
        id: "snap-a-claude",
        account_id: "acc-a",
        auth_epoch: 1,
        realm_id: "default-agy-realm",
        pool_id: "Claude and GPT models",
        model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        observed_at: new Date(nowMs).toISOString(),
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.8,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.8,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
        ],
      },
      {
        id: "snap-b-gemini",
        account_id: "acc-b",
        auth_epoch: 1,
        realm_id: "default-agy-realm",
        pool_id: "Gemini Models",
        model_ids: ["gemini-3.8-flash"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        observed_at: new Date(nowMs).toISOString(),
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.9,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.9,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
        ],
      },
      {
        id: "snap-b-claude",
        account_id: "acc-b",
        auth_epoch: 1,
        realm_id: "default-agy-realm",
        pool_id: "Claude and GPT models",
        model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        observed_at: new Date(nowMs).toISOString(),
        windows: [
          {
            kind: "weekly",
            duration_minutes: 10080,
            remaining_fraction: 0.2,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
          {
            kind: "five_hour",
            duration_minutes: 300,
            remaining_fraction: 0.2,
            reset_at: null,
            observed_at: new Date(nowMs).toISOString(),
            status: "observed",
          },
        ],
      },
    ];

    it("请求 Claude 模型时按 Claude and GPT models 池余额排序，优选账号 A，不被 Gemini 0% 阻断", () => {
      const selection = selectCandidates([accountA, accountB], snapshots, ["Claude and GPT models"], nowMs, {
        required_model_ids: ["claude-opus-5-5"],
      });
      expect(selection.ranked_candidates.length).toBe(2);
      expect(selection.ranked_candidates[0]!.account_id).toBe("acc-a");
      expect(selection.ranked_candidates[1]!.account_id).toBe("acc-b");
    });

    it("请求 Gemini 模型时按 Gemini Models 池余额排序，优选账号 B，不被 Claude 20% 阻断", () => {
      const selection = selectCandidates([accountA, accountB], snapshots, ["Gemini Models"], nowMs, {
        required_model_ids: ["gemini-3.8-flash"],
      });
      expect(selection.ranked_candidates.length).toBe(1);
      expect(selection.ranked_candidates[0]!.account_id).toBe("acc-b");
    });
  });

  describe("U04: 类别占用原子竞争、同类并发与跨类互斥", () => {
    let tmpDir: string;
    let store: Store;
    let repo: AgyAccountRepository;
    let service: AgyAccountService;

    beforeEach(async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "devflow-concurrency-test-"));
      store = new Store(join(tmpDir, "store.db"));
      repo = new AgyAccountRepository(store);
      repo.saveAccount({
        id: "acc-1",
        realm_id: "default-agy-realm",
        revision: 1,
        alias: "acc-1",
        identity: { email: "acc1@example.com", verified_at: new Date().toISOString() },
        secret_ref: "vault-acc-1",
        credential_revision: 1,
        state: "ready",
        enrolled_at: new Date().toISOString(),
        auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
      });
      repo.saveRealm({
        realm_id: "default-agy-realm",
        revision: 1,
        auth_epoch: 1,
        control_generation: 1,
        service_state: "running",
        phase: "idle",
        desired_enabled: true,
        active_account_id: "acc-1",
        active_secret_ref: "vault-acc-1",
        owner: "system",
      });
      const mockAuthHost = {
        capabilities: async () => ({ supported: true, platform: "win32", version: "3.0.0-node", dpapi_available: true, cred_manager_available: true, named_mutex_available: true }),
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
      const mockProbe = {
        probeIdentity: async () => ({
          email: "acc1@example.com",
          cli_version: "1.2.7",
          raw_output: "agy whoami",
        }),
        probeUsage: async () => ({
          email: "acc1@example.com",
          cli_version: "1.2.7",
          windows: [],
          pools: [],
          executable_fingerprint: "fixture",
          capability_verified: true,
        }),
        probeModelAccess: async () => true,
      };
      const mockProcessHost = {
        listManagedProcesses: async () => [],
        findExternalAgyProcesses: async () => [],
        stopProcess: async () => true,
        confirmProcessesStopped: async () => true,
      };
      service = new AgyAccountService(repo, mockAuthHost as any, mockProbe as any, mockProcessHost as any);
      await service.start({ realmId: "default-agy-realm", requestId: "req-start" });

      const realm = repo.getRealm("default-agy-realm")!;
      realm.active_account_id = "acc-1";
      realm.active_secret_ref = "vault-acc-1";
      realm.auth_epoch = 1;
      repo.saveRealm(realm);

      const windows = [
        {
          kind: "weekly" as const,
          duration_minutes: 10080 as const,
          remaining_fraction: 0.8,
          reset_at: null,
          observed_at: new Date().toISOString(),
          status: "observed" as const,
        },
        {
          kind: "five_hour" as const,
          duration_minutes: 300 as const,
          remaining_fraction: 0.8,
          reset_at: null,
          observed_at: new Date().toISOString(),
          status: "observed" as const,
        },
      ];

      repo.saveQuotaSnapshot({
        id: "q-claude",
        realm_id: "default-agy-realm",
        account_id: "acc-1",
        auth_epoch: 1,
        pool_id: "Claude and GPT models",
        model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
        source: "official_cli_usage",
        cli_version: "fixture",
        parser_revision: 1,
        observed_at: new Date().toISOString(),
        windows,
        executable_fingerprint: "fixture",
        capability_verified: true,
      });

      repo.saveQuotaSnapshot({
        id: "q-gemini",
        realm_id: "default-agy-realm",
        account_id: "acc-1",
        auth_epoch: 1,
        pool_id: "Gemini Models",
        model_ids: ["gemini-3.8-flash"],
        source: "official_cli_usage",
        cli_version: "fixture",
        parser_revision: 1,
        observed_at: new Date().toISOString(),
        windows,
        executable_fingerprint: "fixture",
        capability_verified: true,
      });
    });

    afterEach(async () => {
      try {
        await service.close();
      } catch {}
      try {
        store.close();
      } catch {}
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it("同类模型（Opus 5.5 与 Sonnet 5.5）可以同时取得 permit 并发运行", async () => {
      const permit1 = await service.acquireUsagePermit({
        realm_id: "default-agy-realm",
        consumer_id: "run-1",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-opus-5-5"],
      });
      expect(permit1.permit_id).toBeDefined();
      expect(service.getActiveCategory("default-agy-realm").category).toBe("other");

      const permit2 = await service.acquireUsagePermit({
        realm_id: "default-agy-realm",
        consumer_id: "run-2",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-sonnet-5-5"],
      });
      expect(permit2.permit_id).toBeDefined();
      expect(service.getActiveCategory("default-agy-realm").category).toBe("other");
    });

    it("跨类模型（已占用 other 时请求 Gemini）被原子拒绝并给出明确冲突提示", async () => {
      const permit1 = await service.acquireUsagePermit({
        realm_id: "default-agy-realm",
        consumer_id: "run-opus",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-opus-5-5"],
      });
      expect(permit1.permit_id).toBeDefined();

      await expect(
        service.acquireUsagePermit({
          realm_id: "default-agy-realm",
          consumer_id: "run-gemini",
          usage_kind: "execution",
          required_pool_ids: ["Gemini Models"],
          required_model_ids: ["gemini-3.8-flash"],
        })
      ).rejects.toThrow(/当前已有任务正在占用 其他模型类/);

      // 释放任务后，类别占用解除，Gemini 申请成功放行
      await service.releaseUsagePermit(permit1.permit_id, {
        permit_id: permit1.permit_id,
        success: true,
      });
      expect(service.getActiveCategory("default-agy-realm").category).toBe(null);

      const permitGemini = await service.acquireUsagePermit({
        realm_id: "default-agy-realm",
        consumer_id: "run-gemini",
        usage_kind: "execution",
        required_pool_ids: ["Gemini Models"],
        required_model_ids: ["gemini-3.8-flash"],
      });
      expect(permitGemini.permit_id).toBeDefined();
      expect(service.getActiveCategory("default-agy-realm").category).toBe("gemini");
    });
  });
});
