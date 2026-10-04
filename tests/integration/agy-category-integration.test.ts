import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setup } from "../helpers.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { inferPermitCategory } from "../../packages/agy-accounts/src/service.js";
import type { ToolProfile, Workflow } from "../../packages/contracts/src/index.js";
import type { AgyUsagePermit } from "../../packages/contracts/src/agy-account.js";

const realmId = "default-agy-realm";

describe("AGY 分类并发与额度池集成测试 (I01, I02, I03, I04)", () => {
  let s: ReturnType<typeof setup>;
  let accounts: ReturnType<typeof accountFixture>;
  let access: ModelAccessService;

  beforeEach(async () => {
    s = setup();
    accounts = accountFixture(s.store);
    accounts.seedAccounts();
    access = new ModelAccessService(s.store);

    const nowIso = new Date().toISOString();
    const makeWindows = (fraction: number) => [
      {
        kind: "weekly" as const,
        duration_minutes: 10080,
        remaining_fraction: fraction,
        reset_at: null,
        observed_at: nowIso,
        status: "observed" as const,
      },
      {
        kind: "five_hour" as const,
        duration_minutes: 300,
        remaining_fraction: fraction,
        reset_at: null,
        observed_at: nowIso,
        status: "observed" as const,
      },
    ];

    vi.spyOn(accounts.probe, "probeUsage").mockImplementation(async () => {
      const curIso = new Date().toISOString();
      return {
        email: `${accounts.active()}@example.com`,
        cli_version: "1.2.7",
        windows: makeWindows(0.8),
        pools: [
          {
            pool_id: "Gemini Models",
            model_ids: ["gemini-3.8-flash"],
            windows: [
              {
                kind: "weekly" as const,
                duration_minutes: 10080,
                remaining_fraction: 0.9,
                reset_at: null,
                observed_at: curIso,
                status: "observed" as const,
              },
              {
                kind: "five_hour" as const,
                duration_minutes: 300,
                remaining_fraction: 0.9,
                reset_at: null,
                observed_at: curIso,
                status: "observed" as const,
              },
            ],
          },
          {
            pool_id: "Claude and GPT models",
            model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
            windows: [
              {
                kind: "weekly" as const,
                duration_minutes: 10080,
                remaining_fraction: 0.8,
                reset_at: null,
                observed_at: curIso,
                status: "observed" as const,
              },
              {
                kind: "five_hour" as const,
                duration_minutes: 300,
                remaining_fraction: 0.8,
                reset_at: null,
                observed_at: curIso,
                status: "observed" as const,
              },
            ],
          },
        ],
        executable_fingerprint: "fixture",
        capability_verified: true,
      };
    });

    await accounts.service.start({ realmId, requestId: "start-test" });

    // 为 active account 保存两组额度快照
    accounts.repository.saveQuotaSnapshot({
      id: "snap-gemini",
      realm_id: realmId,
      account_id: accounts.active(),
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: nowIso,
      windows: makeWindows(0.9),
      executable_fingerprint: "fixture",
      capability_verified: true,
    });

    accounts.repository.saveQuotaSnapshot({
      id: "snap-claude",
      realm_id: realmId,
      account_id: accounts.active(),
      auth_epoch: 1,
      pool_id: "Claude and GPT models",
      model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: nowIso,
      windows: makeWindows(0.8),
      executable_fingerprint: "fixture",
      capability_verified: true,
    });
  });

  afterEach(async () => {
    try {
      await accounts.service.close();
    } catch {}
    try {
      s.store.close();
    } catch {}
  });

  describe("I01: 配置保存、冻结模型与 permit 接线及混类直接拒绝 (409)", () => {
    it("当 AGY 正被 other 类占用时，保存 Gemini 模型到 ExecutionSpec 会被拒绝抛出 409", async () => {
      // 模拟当前被 other 任务占用
      const getActiveCategory = vi.fn().mockReturnValue("other");
      const specService = new ExecutionSpecService(s.store, undefined, getActiveCategory);

      // 创建一个 workflow
      const wf: Workflow = {
        id: "wf-test-1",
        project_id: "p1",
        revision: 1,
        title: "Test",
        goal: "Test",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        state: "PLANNING",
      };
      s.store.put("workflow", wf.id, wf.id, wf);

      const defaultOverrides = {
        reviewer: { mode: "inherit" as const },
        review_fixer: { mode: "inherit" as const },
        functional_fixer: { mode: "inherit" as const },
      };

      const geminiProfile: ToolProfile = {
        id: "prof-gemini",
        revision: 1,
        adapterId: "agy",
        executableRef: "agy",
        modelSelection: "explicit",
        modelId: "gemini-3.8-flash",
        selectionKind: "fixed",
        options: {},
      };
      const claudeProfile: ToolProfile = {
        id: "prof-claude",
        revision: 1,
        adapterId: "agy",
        executableRef: "agy",
        modelSelection: "explicit",
        modelId: "claude-opus-5-5",
        selectionKind: "fixed",
        options: {},
      };
      const codexProfile: ToolProfile = {
        id: "prof-codex",
        revision: 1,
        adapterId: "codex",
        executableRef: "codex",
        modelSelection: "explicit",
        modelId: "o3-mini",
        selectionKind: "fixed",
        options: {},
      };

      access.seedVerified(geminiProfile);
      access.seedVerified(claudeProfile);
      access.seedVerified(codexProfile);

      // 尝试保存 Gemini 配置 -> 拒绝
      expect(() => {
        specService.updateExecutionSpec({
          request_id: "11111111-1111-4111-8111-111111111111",
          expected_spec_revision: 0,
          workflow_id: wf.id,
          planner_profile: geminiProfile,
          executor_profile: geminiProfile,
          role_overrides: defaultOverrides,
        });
      }).toThrowError(/AGY 当前正被 其他模型类（Claude \/ GPT） 任务占用/);

      // 尝试保存同类 Claude 配置 -> 放行
      const saved = specService.updateExecutionSpec({
        request_id: "22222222-2222-4222-8222-222222222222",
        expected_spec_revision: 0,
        workflow_id: wf.id,
        planner_profile: claudeProfile,
        executor_profile: claudeProfile,
        role_overrides: defaultOverrides,
      });
      expect(saved.status).toBe("committed");
      expect(saved.entity_revision).toBe(1);

      // 非 AGY 工具不受影响
      const savedCodex = specService.updateExecutionSpec({
        request_id: "33333333-3333-4333-8333-333333333333",
        expected_spec_revision: saved.entity_revision,
        workflow_id: wf.id,
        planner_profile: codexProfile,
        executor_profile: codexProfile,
        role_overrides: defaultOverrides,
      });
      expect(savedCodex.status).toBe("committed");
      expect(savedCodex.entity_revision).toBe(2);
    });

    it("直接使用 AgyWorkflowBridge.prepareRun 时，跨类申请 permit 被捕获并映射为 409 AGY_CATEGORY_CONFLICT", async () => {
      // 先申请一个 other 类 permit
      const permitOther = await accounts.service.acquireUsagePermit({
        realm_id: realmId,
        consumer_id: "run-other",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-opus-5-5"],
      });
      expect(permitOther.permit_id).toBeDefined();

      const bridge = new AgyWorkflowBridge(accounts.service);

      await expect(
        bridge.prepareRun({
          workflow_id: "wf-bridge-test",
          run_id: "run-gemini-cross",
          effective_model_id: "gemini-3.8-flash",
          account_policy_revision: 1,
          required_pool_ids: ["Gemini Models"],
        })
      ).rejects.toThrowError(/全部同时占用 AGY 的任务只能使用同一类别/);

      // 释放后 Gemini 即可成功
      await accounts.service.releaseUsagePermit(permitOther.permit_id, {
        permit_id: permitOther.permit_id,
        success: true,
      });

      const binding = await bridge.prepareRun({
        workflow_id: "wf-bridge-test",
        run_id: "run-gemini-cross",
        effective_model_id: "gemini-3.8-flash",
        account_policy_revision: 1,
        required_pool_ids: ["Gemini Models"],
      });
      expect(binding.permit_id).toBeDefined();
    });
  });

  describe("I02: 所属额度耗尽按类别切换，且多任务恢复保持各自分类与模型", () => {
    it("执行 Claude 模型时只受 Claude 额度池影响，Gemini 额度耗尽不触发 Claude 任务异常", async () => {
      const emptyIso = new Date().toISOString();
      const emptyWindows = [
        {
          kind: "weekly" as const,
          duration_minutes: 10080 as const,
          remaining_fraction: 0.0,
          reset_at: null,
          observed_at: emptyIso,
          status: "observed" as const,
        },
        {
          kind: "five_hour" as const,
          duration_minutes: 300 as const,
          remaining_fraction: 0.0,
          reset_at: null,
          observed_at: emptyIso,
          status: "observed" as const,
        },
      ];

      // 将 Gemini 池额度设为 0，而 Claude 池额度充足 (0.8)
      accounts.repository.saveQuotaSnapshot({
        id: "snap-gemini-empty",
        realm_id: realmId,
        account_id: accounts.active(),
        auth_epoch: 1,
        pool_id: "Gemini Models",
        model_ids: ["gemini-3.8-flash"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        observed_at: emptyIso,
        windows: emptyWindows,
        executable_fingerprint: "fixture",
        capability_verified: true,
      });

      // 申请 Claude 模型 permit 成功放行，不受 Gemini 0% 影响
      const permitClaude = await accounts.service.acquireUsagePermit({
        realm_id: realmId,
        consumer_id: "run-claude-ok",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-opus-5-5"],
      });
      expect(permitClaude.permit_id).toBeDefined();
      expect(accounts.service.getActiveCategory(realmId).category).toBe("other");

      // 清理
      await accounts.service.releaseUsagePermit(permitClaude.permit_id, {
        permit_id: permitClaude.permit_id,
        success: true,
      });
    });
  });

  describe("I03: 旧记录迁移、重启、最后消费者退出与同类并发占用释放", () => {
    it("支持从旧 permit 推断类别（inferPermitCategory），兼容无 model_category 历史记录", () => {
      const legacyPermitWithoutCategory: AgyUsagePermit = {
        permit_id: "permit-old",
        realm_id: realmId,
        account_id: "acc-1",
        auth_epoch: 1,
        consumer_id: "run-legacy",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        allowed_account_ids: null,
        issued_at: new Date().toISOString(),
        status: "issued",
      };
      expect(inferPermitCategory(legacyPermitWithoutCategory)).toBe("other");

      const legacyPermitWithModel: AgyUsagePermit = {
        permit_id: "permit-old-2",
        realm_id: realmId,
        account_id: "acc-1",
        auth_epoch: 1,
        consumer_id: "run-legacy-2",
        usage_kind: "execution",
        required_pool_ids: [],
        allowed_account_ids: null,
        model_id: "gemini-3.8-flash",
        issued_at: new Date().toISOString(),
        status: "issued",
      };
      expect(inferPermitCategory(legacyPermitWithModel)).toBe("gemini");
    });

    it("同类多任务（Opus 与 Sonnet）并发占用，部分释放后保持占用，全部释放后解除限制", async () => {
      const p1 = await accounts.service.acquireUsagePermit({
        realm_id: realmId,
        consumer_id: "run-opus-1",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-opus-5-5"],
      });

      const p2 = await accounts.service.acquireUsagePermit({
        realm_id: realmId,
        consumer_id: "run-sonnet-2",
        usage_kind: "execution",
        required_pool_ids: ["Claude and GPT models"],
        required_model_ids: ["claude-sonnet-5-5"],
      });

      const activeState = accounts.service.getActiveCategory(realmId);
      expect(activeState.category).toBe("other");
      expect(activeState.activePermits.length).toBe(2);

      // 释放第一个任务（Opus）
      await accounts.service.releaseUsagePermit(p1.permit_id, {
        permit_id: p1.permit_id,
        success: true,
      });

      // 仍然有 Sonnet 存活，类别仍为 other
      const stateAfterP1 = accounts.service.getActiveCategory(realmId);
      expect(stateAfterP1.category).toBe("other");
      expect(stateAfterP1.activePermits.length).toBe(1);

      // 此时尝试 Gemini 仍然被拒绝
      await expect(
        accounts.service.acquireUsagePermit({
          realm_id: realmId,
          consumer_id: "run-gemini-blocked",
          usage_kind: "execution",
          required_pool_ids: ["Gemini Models"],
          required_model_ids: ["gemini-3.8-flash"],
        })
      ).rejects.toThrowError(/当前已有任务正在占用 其他模型类/);

      // 释放最后一个任务（Sonnet）
      await accounts.service.releaseUsagePermit(p2.permit_id, {
        permit_id: p2.permit_id,
        success: true,
      });

      // 类别完全释放为 null
      expect(accounts.service.getActiveCategory(realmId).category).toBe(null);
      expect(accounts.service.getActiveCategory(realmId).activePermits.length).toBe(0);

      // 现在 Gemini 能够顺利获取
      const pGemini = await accounts.service.acquireUsagePermit({
        realm_id: realmId,
        consumer_id: "run-gemini-success",
        usage_kind: "execution",
        required_pool_ids: ["Gemini Models"],
        required_model_ids: ["gemini-3.8-flash"],
      });
      expect(pGemini.permit_id).toBeDefined();
      expect(accounts.service.getActiveCategory(realmId).category).toBe("gemini");

      await accounts.service.releaseUsagePermit(pGemini.permit_id, {
        permit_id: pGemini.permit_id,
        success: true,
      });
    });
  });

  describe("I04: 额度 API 返回两组完整数据，不串池，不改写原始观测", () => {
    it("getPresentation 包含 active_category 且包含独立的两组池额度数据", async () => {
      const presentation = accounts.service.getPresentation(realmId);
      expect(presentation.active_category).toBe(null);

      // 验证存在两个独立的池快照：Gemini Models 与 Claude and GPT models
      const activeSnaps = presentation.snapshots.filter((s) => s.account_id === accounts.active());
      expect(activeSnaps.length).toBeGreaterThanOrEqual(2);

      const geminiQuota = activeSnaps.find((q) => q.pool_id === "Gemini Models");
      const claudeQuota = activeSnaps.find((q) => q.pool_id === "Claude and GPT models");

      expect(geminiQuota).toBeDefined();
      expect(claudeQuota).toBeDefined();

      // 各自的 windows 独立存在
      expect(geminiQuota?.windows.length).toBe(2);
      expect(claudeQuota?.windows.length).toBe(2);
    });
  });
});
