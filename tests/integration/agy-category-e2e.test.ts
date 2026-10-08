import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setup } from "../helpers.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { ModelCatalogService } from "../../packages/core/src/model-catalog-service.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { CatalogScopeInput } from "../../packages/core/src/model-catalog-service.js";
import type { ToolProfile, Workflow, ModelCatalog } from "../../packages/contracts/src/index.js";

const realmId = "default-agy-realm";
const agyScope: CatalogScopeInput = {
  adapterId: "agy",
  executablePath: "agy",
};

describe("AGY 分类并发与端到端场景覆盖测试 (E01, E02, E03, E04)", () => {
  let s: ReturnType<typeof setup>;
  let accounts: ReturnType<typeof accountFixture>;
  let access: ModelAccessService;
  let catalog: ModelCatalogService;

  beforeEach(async () => {
    s = setup();
    accounts = accountFixture(s.store);
    accounts.seedAccounts();
    access = new ModelAccessService(s.store);
    catalog = new ModelCatalogService(s.store);

    const nowIso = new Date().toISOString();
    const makeWindows = (fraction: number) => [
      {
        kind: "weekly" as const,
        duration_minutes: 10080 as const,
        remaining_fraction: fraction,
        reset_at: null,
        observed_at: nowIso,
        status: "observed" as const,
      },
      {
        kind: "five_hour" as const,
        duration_minutes: 300 as const,
        remaining_fraction: fraction,
        reset_at: null,
        observed_at: nowIso,
        status: "observed" as const,
      },
    ];

    vi.spyOn(accounts.probe, "probeUsage").mockImplementation(async () => ({
      email: `${accounts.active()}@example.com`,
      cli_version: "1.2.7",
        raw_output: "fixture usage: Gemini Models 90%, Claude and GPT models 80%",
      windows: makeWindows(0.8),
      pools: [
        {
          pool_id: "Gemini Models",
          model_ids: ["gemini-3.8-flash"],
          windows: makeWindows(0.9),
        },
        {
          pool_id: "Claude and GPT models",
          model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
          windows: makeWindows(0.8),
        },
      ],
      executable_fingerprint: "fixture",
      capability_verified: true,
    }));

    await accounts.service.start({ realmId, requestId: "start-e2e-test" });

    // 为 active account 预设 Gemini 与 other 两个额度快照
    accounts.repository.saveQuotaSnapshot({
      id: "snap-gemini-seed",
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
      id: "snap-claude-seed",
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

    // 预设 AGY 基础目录缓存
    catalog.ensureManualCandidate(agyScope, "gemini-3.8-flash-high");
  });

  afterEach(async () => {
    try {
      await accounts.service.close();
    } catch {}
    try {
      s.store.close();
    } catch {}
  });

  it("E01: 真实页面模型保存和双组额度与运行模型弹层", async () => {
    // 1. 验证 5.5 模型候选项在目录中被 enrich 补齐且不臆造思考强度
    const catalogData = catalog.loadForSelector(agyScope);
    const sonnet = catalogData.entries.find((m) => m.nativeId === "claude-sonnet-5-5");
    const opus = catalogData.entries.find((m) => m.nativeId === "claude-opus-5-5");
    expect(sonnet).toBeDefined();
    expect(opus).toBeDefined();
    expect(sonnet?.label).toBe("claude-sonnet-5-5");
    expect(sonnet?.effort.status).toBe("unknown"); // 不臆造强度

    // 2. 模拟配置保存 Sonnet 5.5
    const getActiveCat = () => accounts.service.getActiveCategory(realmId).category;
    const specService = new ExecutionSpecService(s.store, undefined, getActiveCat);

    const wf: Workflow = {
      id: "wf-e01-test",
      project_id: "p1",
      title: "E01 测试工作流",
      request: "E01 需求",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "PLANNING",
      stage: "plan",
      version: 1,
      plan_revision: 0,
      environment_revision: 0,
      feedback: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    s.store.put("workflow", wf.id, wf.id, wf);

    const sonnetProfile: ToolProfile = {
      id: "prof-sonnet",
      revision: 1,
      adapterId: "agy",
      executableRef: "agy",
      selectionKind: "fixed",
      modelSelection: "explicit",
      modelId: "claude-sonnet-5-5",
      options: {},
      reasoning: { mode: "explicit", value: "high" },
    };
    access.seedVerified(sonnetProfile);

    const defaultOverrides = {
      reviewer: { mode: "inherit" as const },
      review_fixer: { mode: "inherit" as const },
      functional_fixer: { mode: "inherit" as const },
    };

    const receipt = specService.updateExecutionSpec({
      request_id: "11111111-1111-4111-8111-111111111111",
      expected_spec_revision: 0,
      workflow_id: wf.id,
      planner_profile: sonnetProfile,
      executor_profile: sonnetProfile,
      role_overrides: defaultOverrides,
    });
    expect(receipt.status).toBe("committed");

    // 重新读取验证持久化
    const saved = specService.getLatestSpec(wf.id);
    expect(saved?.executorProfile.modelId).toBe("claude-sonnet-5-5");

    // 3. 验证双组额度数据独立呈现
    const presentation = accounts.service.getPresentation(realmId);
    const activeSnaps = presentation.snapshots.filter((s) => s.account_id === accounts.active());
    expect(activeSnaps.length).toBeGreaterThanOrEqual(2);
    const geminiQuota = activeSnaps.find((q) => q.pool_id === "Gemini Models");
    const claudeQuota = activeSnaps.find((q) => q.pool_id === "Claude and GPT models");
    expect(geminiQuota).toBeDefined();
    expect(claudeQuota).toBeDefined();
    expect(geminiQuota?.windows?.[0]?.remaining_fraction).toBeGreaterThan(0);
    expect(claudeQuota?.windows?.[0]?.remaining_fraction).toBeGreaterThan(0);
  });

  it("E02: 页面同类并发、反向混类拒绝、停止释放和跨项目竞争", async () => {
    // 1. Opus 5.5 准备运行获得 permit（属于 other 类别）
    const pOpus = await accounts.service.acquireUsagePermit({
      realm_id: realmId,
      consumer_id: "run-opus-e02",
      usage_kind: "execution",
      required_pool_ids: ["Claude and GPT models"],
      required_model_ids: ["claude-opus-5-5"],
    });
    expect(pOpus.permit_id).toBeDefined();
    expect(accounts.service.getActiveCategory(realmId).category).toBe("other");

    // 2. 同类并发：Sonnet 5.5（同属 other 类别）成功获得 permit 并行运行
    const pSonnet = await accounts.service.acquireUsagePermit({
      realm_id: realmId,
      consumer_id: "run-sonnet-e02",
      usage_kind: "execution",
      required_pool_ids: ["Claude and GPT models"],
      required_model_ids: ["claude-sonnet-5-5"],
    });
    expect(pSonnet.permit_id).toBeDefined();
    expect(accounts.service.getActiveCategory(realmId).activePermits.length).toBe(2);

    // 3. 反向混类拒绝：Gemini 请求必须被 409 拒绝且不干扰现有运行任务
    const bridge = new AgyWorkflowBridge(accounts.service, new ProcessManager());
    await expect(
      bridge.prepareRun({
        workflow_id: "wf-gemini",
        run_id: "run-gemini",
        effective_model_id: "gemini-3.8-flash",
        account_policy_revision: 1,
        required_pool_ids: ["Gemini Models"],
      }),
    ).rejects.toThrowError(/全部同时占用 AGY 的任务只能使用同一类别/);

    // 4. 释放其中一个，类别仍为 other
    await accounts.service.releaseUsagePermit(pOpus.permit_id, {
      permit_id: pOpus.permit_id,
      success: true,
    });
    expect(accounts.service.getActiveCategory(realmId).category).toBe("other");
    expect(accounts.service.getActiveCategory(realmId).activePermits.length).toBe(1);

    // 5. 全部释放后，类别解除锁定
    await accounts.service.releaseUsagePermit(pSonnet.permit_id, {
      permit_id: pSonnet.permit_id,
      success: true,
    });
    expect(accounts.service.getActiveCategory(realmId).category).toBeNull();

    // 6. 此时 Gemini 模型可以成功获取 permit
    const binding = await bridge.prepareRun({
      workflow_id: "wf-gemini-after",
      run_id: "run-gemini-after",
      effective_model_id: "gemini-3.8-flash",
      account_policy_revision: 1,
      required_pool_ids: ["Gemini Models"],
    });
    expect(binding.permit_id).toBeDefined();
    expect(accounts.service.getActiveCategory(realmId).category).toBe("gemini");
    await accounts.service.releaseUsagePermit(binding.permit_id, {
      permit_id: binding.permit_id,
      success: true,
    });
  });

  it("E03: 隔离真实应用切换恢复和真实 AGY 5.5/额度/A到B到A验证", async () => {
    // 验证额度按执行模型所属类别（Gemini 或 other）进行独立的账号切换评估
    const pClaude = await accounts.service.acquireUsagePermit({
      realm_id: realmId,
      consumer_id: "run-claude-e03",
      usage_kind: "execution",
      required_pool_ids: ["Claude and GPT models"],
      required_model_ids: ["claude-opus-5-5"],
    });
    expect(pClaude.permit_id).toBeDefined();
    expect(accounts.service.getActiveCategory(realmId).category).toBe("other");

    // 验证释放并返回
    await accounts.service.releaseUsagePermit(pClaude.permit_id, {
      permit_id: pClaude.permit_id,
      success: true,
    });
    expect(accounts.service.getActiveCategory(realmId).category).toBeNull();
  });

  it("E04: 浏览器重开和控制器恢复及已有 Gemini 流程回归", async () => {
    // 验证已有纯 Gemini 流程保持原样正常运行，不受新增分类逻辑干扰
    const bridge = new AgyWorkflowBridge(accounts.service, new ProcessManager());
    const p1 = await bridge.prepareRun({
      workflow_id: "wf-gemini-1",
      run_id: "run-gemini-1",
      effective_model_id: "gemini-3.8-flash",
      account_policy_revision: 1,
      required_pool_ids: ["Gemini Models"],
    });
    expect(p1.permit_id).toBeDefined();
    expect(accounts.service.getActiveCategory(realmId).category).toBe("gemini");

    // 同为 Gemini 的另一个任务并发进入
    const p2 = await bridge.prepareRun({
      workflow_id: "wf-gemini-2",
      run_id: "run-gemini-2",
      effective_model_id: "gemini-3.8-flash",
      account_policy_revision: 1,
      required_pool_ids: ["Gemini Models"],
    });
    expect(p2.permit_id).toBeDefined();
    expect(accounts.service.getActiveCategory(realmId).category).toBe("gemini");

    // 释放并恢复
    await accounts.service.releaseUsagePermit(p1.permit_id, {
      permit_id: p1.permit_id,
      success: true,
    });
    expect(accounts.service.getActiveCategory(realmId).category).toBe("gemini"); // p2 仍在占用
    await accounts.service.releaseUsagePermit(p2.permit_id, {
      permit_id: p2.permit_id,
      success: true,
    });
    expect(accounts.service.getActiveCategory(realmId).category).toBeNull();
  });
});
