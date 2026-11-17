import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, testConsoleHeaders, repository } from "../helpers.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { setAdapterExecutableResolver } from "../../packages/adapters/sdk/src/registry.js";
import { buildServer } from "../../apps/api/src/server.js";
import { parseAgyUsageOutput } from "../../packages/adapters/agy/src/quota-parser.js";
import { agyArguments } from "../../packages/adapters/agy/src/session.js";
import { requiredQuotaPools } from "../../packages/agy-accounts/src/quota.js";
import { evaluateAccountForDemand, selectCandidates } from "../../packages/agy-accounts/src/selector.js";
import { ModelCatalogService } from "../../packages/core/src/model-catalog-service.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { RepairModelService } from "../../packages/core/src/repair-model-service.js";
import { managedAgyAccountContextKey } from "../../packages/core/src/model-identity.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { frozenInvocationFromProfile } from "../../packages/core/src/run-profile.js";
import {
  AgyQuotaSnapshotSchema,
  inheritRoleOverrides,
  type AgyAccount,
  type Run,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { Engine } from "../../packages/core/src/engine.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import type { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import { createGroupModelRunner, type RunModel } from "../../packages/group-chat/src/model-runner.js";

const HYDROGEN_VARIANTS = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
  "gemini-3.8-flash-high",
];

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

function hydrogenProfile(id = "executor", modelId = "gemini-4-hydrogen-xhigh", effort = "xhigh"): ToolProfile {
  return {
    id,
    revision: 1,
    adapterId: "agy",
    modelSelection: "explicit",
    selectionKind: "fixed",
    modelId,
    reasoning: { mode: "explicit", value: effort },
    options: {},
  };
}

function flashProfile(id = "planner"): ToolProfile {
  return {
    id,
    revision: 1,
    adapterId: "agy",
    modelSelection: "explicit",
    selectionKind: "fixed",
    modelId: "gemini-3.8-flash-high",
    reasoning: { mode: "explicit", value: "high" },
    options: {},
  };
}

function seedGeminiQuota(
  fix: ReturnType<typeof accountFixture>,
  accountId: string,
  remainingWeekly: number,
  remainingFiveHour = 0.8,
) {
  const observedAt = new Date().toISOString();
  fix.repository.saveQuotaSnapshot(
    AgyQuotaSnapshotSchema.parse({
      id: `snap-gemini-${accountId}-${randomUUID().slice(0, 8)}`,
      realm_id: "default-agy-realm",
      account_id: accountId,
      auth_epoch: fix.repository.getRealm("default-agy-realm")?.auth_epoch ?? 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-*"],
      source: "official_cli_usage",
      cli_version: "1.5.6",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: observedAt,
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: remainingWeekly,
          reset_at: new Date(Date.now() + 86_400_000).toISOString(),
          observed_at: observedAt,
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: remainingFiveHour,
          reset_at: new Date(Date.now() + 3_600_000).toISOString(),
          observed_at: observedAt,
          status: "observed",
        },
      ],
    }),
  );
}

function attachModels(
  fix: ReturnType<typeof accountFixture>,
  accountId: string,
  nativeIds: string[] | undefined,
  options: { credentialRevision?: number; observedAt?: string } = {},
) {
  const acc = fix.repository.getAccount("default-agy-realm", accountId)!;
  fix.repository.saveAccount({
    ...acc,
    models: nativeIds === undefined
      ? undefined
      : {
          native_ids: nativeIds,
          executable_fingerprint: "fixture-fingerprint",
          observed_at: options.observedAt ?? new Date().toISOString(),
          cli_version: "1.5.6",
          credential_revision: options.credentialRevision ?? acc.credential_revision,
        },
  });
}

function createFakeAgyCli(dir: string): string {
  const cliPath = join(dir, "fake-agy.mjs");
  writeFileSync(
    cliPath,
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('--version')) { console.log('1.5.6'); process.exit(0); }",
      "if (args.includes('--help')) { console.log('Antigravity CLI (agy) usage'); process.exit(0); }",
      "process.exit(0);",
    ].join("\n"),
  );
  return cliPath;
}

describe("A04: Gemini 4 Hydrogen 配额池归属、选号隔离与切换回退", () => {
  it("Hydrogen 归属 Gemini Models 池，选号严格要求 credential_revision 与 15 分钟目录确认且不退化到不支持账号", async () => {
    const parsedUsage = parseAgyUsageOutput([
      "Gemini Models\tWeekly Limit Remaining\t80%\t2026-12-01T00:00:00Z",
      "Gemini Models\tFive Hour Limit Remaining\t60%\t2026-12-01T00:00:00Z",
      "Claude and GPT models\tWeekly Limit Remaining\t95%\t2026-12-01T00:00:00Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t95%\t2026-12-01T00:00:00Z",
    ].join("\n"));
    const poolsWithIds = parsedUsage.pools.map((pool) => ({
      pool_id: pool.pool_id,
      model_ids: pool.models,
    }));
    const required = requiredQuotaPools(poolsWithIds, ["Gemini Models"], ["gemini-4-hydrogen-xhigh"]);
    expect(required?.map((p) => p.pool_id)).toEqual(["Gemini Models"]);

    const test = setup();
    const fix = accountFixture(test.store, "gemini-4-hydrogen-xhigh");
    cleanups.push(async () => {
      await fix.service.close();
      test.store.close();
      rmSync(test.root, { recursive: true, force: true });
    });

    fix.seedAccounts();
    for (const id of ["a", "b", "c"]) fix.addSavedAccount(id);

    // 账号 a：支持 Hydrogen，配额 0.4；账号 b：配额 0.95 但为空目录；账号 c：配额 0.99 但 credential_revision 不匹配
    seedGeminiQuota(fix, "a", 0.4, 0.4);
    seedGeminiQuota(fix, "b", 0.95, 0.95);
    seedGeminiQuota(fix, "c", 0.99, 0.99);
    attachModels(fix, "a", HYDROGEN_VARIANTS);
    attachModels(fix, "b", []);
    attachModels(fix, "c", HYDROGEN_VARIANTS, { credentialRevision: 999 });

    const realm = fix.repository.getRealm("default-agy-realm")!;
    const settings = fix.repository.getSettings("default-agy-realm")!;
    const accounts = fix.repository.listAccounts("default-agy-realm");
    const snapshots = fix.repository.listQuotaSnapshots("default-agy-realm");
    const now = Date.now();
    const policy = {
      required_pool_ids: ["Gemini Models"],
      required_model_ids: ["gemini-4-hydrogen-xhigh"],
      current_executable_fingerprint: "fixture-fingerprint",
      allowed_account_ids: null,
      night_pool: "normal" as const,
      switch_gap_seconds: settings.switch_gap_seconds,
      local_snapshot_stale_hours: settings.local_snapshot_stale_hours,
    };

    const selected = selectCandidates(
      accounts,
      snapshots,
      ["Gemini Models"],
      now,
      policy,
    );
    expect(selected.ranked_candidates.some((item) => item.account_id === "a")).toBe(true);
    expect(selected.ranked_candidates.some((item) => item.account_id === "b")).toBe(false);

    // 账号 c 因 credential_revision 不一致被禁止发许可，账号 b 因不支持模型被直接排除
    const evalA = evaluateAccountForDemand({
      account: accounts.find((x) => x.id === "a")!,
      snapshots,
      policy,
      evaluationTime: now,
    });
    const evalB = evaluateAccountForDemand({
      account: accounts.find((x) => x.id === "b")!,
      snapshots,
      policy,
      evaluationTime: now,
    });
    const evalC = evaluateAccountForDemand({
      account: accounts.find((x) => x.id === "c")!,
      snapshots,
      policy,
      evaluationTime: now,
    });
    expect(evalA.eligible_for_permit).toBe(true);
    expect(evalB.eligible_for_permit).toBe(false);
    expect(evalB.eligible_for_candidate).toBe(false);
    expect(evalC.eligible_for_permit).toBe(false);

    // 超过 15 分钟（AGY 目录缓存上限）也禁止直接发放许可
    attachModels(fix, "a", HYDROGEN_VARIANTS, {
      observedAt: new Date(Date.now() - 16 * 60_000).toISOString(),
    });
    const evalAStale = evaluateAccountForDemand({
      account: fix.repository.getAccount("default-agy-realm", "a")!,
      snapshots,
      policy,
      evaluationTime: now,
    });
    expect(evalAStale.eligible_for_permit).toBe(false);

    // 恢复 a 但配额归零：所有支持账号都耗尽时进入等待，绝不退化选中高配额不支持的 b
    attachModels(fix, "a", HYDROGEN_VARIANTS);
    seedGeminiQuota(fix, "a", 0, 0);
    const noFallback = selectCandidates(
      fix.repository.listAccounts("default-agy-realm"),
      fix.repository.listQuotaSnapshots("default-agy-realm"),
      ["Gemini Models"],
      now,
      policy,
    );
    expect(noFallback.ranked_candidates.some((item) => item.account_id === "b")).toBe(false);
    expect(noFallback.ranked_candidates.some((item) => item.account_id === "a")).toBe(false);
  });

  it("切换目标缺少 models 且 probeModels 发现不支持时淘汰，不落定到不支持账号", async () => {
    const test = setup();
    const fix = accountFixture(test.store, "gemini-4-hydrogen-xhigh");
    cleanups.push(async () => {
      await fix.service.close();
      test.store.close();
      rmSync(test.root, { recursive: true, force: true });
    });

    fix.seedAccounts();
    for (const id of ["a", "b", "c"]) fix.addSavedAccount(id);

    // b 配额最高 0.95 但缺少 models；probeModels 对 b 返回有效空目录 []，对 c 返回支持目录
    attachModels(fix, "a", HYDROGEN_VARIANTS);
    attachModels(fix, "b", undefined);
    attachModels(fix, "c", HYDROGEN_VARIANTS);
    seedGeminiQuota(fix, "a", 0, 0);
    seedGeminiQuota(fix, "b", 0.95, 0.95);
    seedGeminiQuota(fix, "c", 0.6, 0.6);

    const setUsagePools = (remainingFor: (id: string) => number) => {
      fix.probe.probeUsage = async () => {
        const activeId = fix.active();
        const frac = remainingFor(activeId);
        const now = new Date().toISOString();
        const win = [
          { kind: "weekly" as const, duration_minutes: 10080 as const, remaining_fraction: frac, reset_at: new Date(Date.now() + 86_400_000).toISOString(), observed_at: now, status: "observed" as const },
          { kind: "five_hour" as const, duration_minutes: 300 as const, remaining_fraction: frac, reset_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: now, status: "observed" as const },
        ];
        return {
          email: `${activeId}@example.com`,
          cli_version: "1.5.6",
          windows: win,
          raw_output: "",
          pools: [{ pool_id: "Gemini Models", model_ids: ["gemini-*"], windows: win }],
          executable_fingerprint: "fixture-fingerprint",
          capability_verified: true,
        };
      };
    };
    setUsagePools((id) => (id === "a" ? 0 : id === "b" ? 0.95 : 0.6));
    fix.probe.probeModels = async () => {
      const id = fix.active();
      const acc = fix.repository.getAccount("default-agy-realm", id);
      return {
        native_ids: id === "b" ? [] : HYDROGEN_VARIANTS,
        executable_fingerprint: "fixture-fingerprint",
        observed_at: new Date().toISOString(),
        cli_version: "1.5.6",
        credential_revision: acc?.credential_revision ?? 1,
      };
    };

    vi.spyOn(fix.authHost, "inspectActive").mockImplementation(async () => ({
      exists: true,
      auth: { email: `${fix.active() || "a"}@example.com`, has_refresh_credential: true },
    }));
    fix.service.registerConsumer({
      listOccupancy: async () => [],
      prepareSwitch: async () => ({ savedRef: { runs: [{ run_id: "run-switch" }] } }),
      quiesce: async () => {},
      confirmStopped: async () => true,
      onAccountCommitted: async () => {},
    });
    await fix.service.start({ realmId: "default-agy-realm", requestId: "start-op" });

    // 触发因额度耗尽的工作流自动切号：target b 缺少 models 且 probeModels 返回有效空目录，必须淘汰 b 并切到真正支持的 c
    const switchOp = await fix.service.requestWorkflowOperation({
      realm_id: "default-agy-realm",
      kind: "switch",
      request_id: randomUUID(),
      selection: { mode: "auto" },
      trigger: "workflow_quota",
      source_event_key: `quota-${randomUUID()}`,
      expected_epoch: fix.repository.getRealm("default-agy-realm")!.auth_epoch,
      workflow_id: "wf-switch",
      source_run_id: "run-switch",
      model_id: "gemini-4-hydrogen-xhigh",
      required_pool_ids: ["Gemini Models"],
      required_model_ids: ["gemini-4-hydrogen-xhigh"],
      quota_window: "weekly",
    });
    expect(switchOp.operation_id).toBeTruthy();
    await fix.service.tick(Date.now());
    const opRecord = fix.repository.getOperation(switchOp.operation_id);
    expect(fix.active(), JSON.stringify(opRecord)).toBe("c");

    const permit = await fix.service.acquireUsagePermit({
      realm_id: "default-agy-realm",
      consumer_id: "consumer-switch",
      usage_kind: "execution",
      model_id: "gemini-4-hydrogen-xhigh",
      required_pool_ids: ["Gemini Models"],
      required_model_ids: ["gemini-4-hydrogen-xhigh"],
    });
    expect(permit.account_id).toBe("c");
    expect(fix.active()).toBe("c");
    await fix.service.releaseUsagePermit(permit.permit_id, {
      permit_id: permit.permit_id,
      success: true,
    });
  });
});

describe("A05: AgyWorkflowBridge 最终落定重核并重写 frozen_invocation", () => {
  it("落定到新支持账号时重读真实目录并按新账号重算 invocation_fingerprint 与 --model（不含 --effort）", async () => {
    const test = setup();
    const fix = accountFixture(test.store, "gemini-4-hydrogen-xhigh");
    const stop = vi.fn(async () => true);
    const confirm = vi.fn(async () => true);

    fix.seedAccounts();
    for (const id of ["a", "b", "c"]) fix.addSavedAccount(id);
    attachModels(fix, "a", HYDROGEN_VARIANTS);
    attachModels(fix, "b", HYDROGEN_VARIANTS);
    attachModels(fix, "c", []);
    seedGeminiQuota(fix, "a", 0.2, 0.2);
    seedGeminiQuota(fix, "b", 0.9, 0.9);
    seedGeminiQuota(fix, "c", 0.1, 0.1);

    fix.probe.probeUsage = async () => {
      const id = fix.active();
      const frac = id === "a" ? 0.2 : id === "b" ? 0.9 : 0.1;
      const now = new Date().toISOString();
      const win = [
        { kind: "weekly" as const, duration_minutes: 10080 as const, remaining_fraction: frac, reset_at: new Date(Date.now() + 86_400_000).toISOString(), observed_at: now, status: "observed" as const },
        { kind: "five_hour" as const, duration_minutes: 300 as const, remaining_fraction: frac, reset_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: now, status: "observed" as const },
      ];
      return {
        email: `${id}@example.com`,
        cli_version: "1.5.6",
        windows: win,
        raw_output: "",
        pools: [{ pool_id: "Gemini Models", model_ids: ["gemini-*"], windows: win }],
        executable_fingerprint: "fixture-fingerprint",
        capability_verified: true,
      };
    };
    fix.probe.probeModels = async () => {
      const id = fix.active();
      const acc = fix.repository.getAccount("default-agy-realm", id);
      return {
        native_ids: id === "c" ? [] : HYDROGEN_VARIANTS,
        executable_fingerprint: "fixture-fingerprint",
        observed_at: new Date().toISOString(),
        cli_version: "1.5.6",
        credential_revision: acc?.credential_revision ?? 1,
      };
    };

    vi.spyOn(fix.authHost, "inspectActive").mockImplementation(async () => ({
      exists: true,
      auth: { email: `${fix.active() || "a"}@example.com`, has_refresh_credential: true },
    }));
    await fix.service.start({ realmId: "default-agy-realm", requestId: "bridge-start" });
    // 将当前真实激活账号从 a 切换到另一个支持账号 b（模拟启动执行时已落定到新支持账号）
    await fix.service.requestOperation({
      realm_id: "default-agy-realm",
      request_id: randomUUID(),
      kind: "switch",
      selection: { mode: "explicit", account_id: "b" },
    });
    await fix.service.tick(Date.now());
    expect(fix.active()).toBe("b");

    const fakeCli = createFakeAgyCli(test.root);
    const restoreResolver = setAdapterExecutableResolver((adapterId) => (adapterId === "agy" ? fakeCli : undefined));
    cleanups.push(restoreResolver);

    const catalog = new ModelCatalogService(test.store, {
      readAgyModels: async (expected) => fix.service.readActiveModelSnapshot("default-agy-realm", expected),
    });

    const profile = hydrogenProfile("executor", "gemini-4-hydrogen-xhigh", "xhigh");
    const run = {
      id: "run-hydrogen-1",
      workflow_id: "wf-hydrogen-1",
      purpose: "implement",
      role: "executor",
      profile: { ...profile, executableRef: fakeCli },
      conversation_id: "conv-1",
      workspace_root: test.root,
      allowed_paths: [test.root],
      prompt_kind: "user",
      timeout_ms: 120_000,
      frozen_invocation: {
        ...frozenInvocationFromProfile(profile, "profile-native"),
        accountScope: "stale-scope-from-a",
        providerScope: "default",
        identityConfidence: "verified",
      },
      invocation_fingerprint: "stale-fingerprint-a",
    } as unknown as Run;
    test.store.put("run", run.id, run.workflow_id, run);

    const workflow: Workflow = {
      id: "wf-hydrogen-1",
      title: "Hydrogen 运行冻结核验",
      request: "验证",
      state: "EXECUTING",
      version: 1,
      run_id: run.id,
      plan_revision: 1,
      plan_hash: "h",
    } as unknown as Workflow;
    test.store.put("workflow", workflow.id, workflow.id, workflow);

    const engine = {
      store: test.store,
      get: () => workflow,
      waitForIdle: async () => {},
      restoreFailedRole: vi.fn(() => true),
      dispatch: async () => {},
      block: vi.fn(),
    } as unknown as Engine;

    const bridge = new AgyWorkflowBridge(
      fix.service,
      { stop, get: () => undefined, hasStartAttempt: () => false } as unknown as ProcessManager,
      undefined,
      engine,
      { confirmJobsStopped: confirm } as unknown as AgyAccountProcessHost,
    );
    cleanups.push(async () => {
      bridge.dispose();
      await fix.service.close();
      test.store.close();
      rmSync(test.root, { recursive: true, force: true });
    });

    const binding = await bridge.prepareProfileRun(workflow.id, run, "gemini-4-hydrogen-xhigh", "executor");
    expect(binding).toBeDefined();
    expect(binding!.account_id).toBe("b");

    const updatedRun = test.store.get<Run>("run", run.id)!;
    expect(updatedRun.frozen_invocation?.accountScope).not.toBe("stale-scope-from-a");
    expect(updatedRun.invocation_fingerprint).not.toBe("stale-fingerprint-a");
    expect(updatedRun.frozen_invocation?.modelToken).toBe("gemini-4-hydrogen-xhigh");
    expect(updatedRun.frozen_invocation?.effortArgs).toEqual([]);
    expect(updatedRun.frozen_invocation?.transport).toBe("variant-id");
    const renderedArgs = agyArguments(
      updatedRun.frozen_invocation!.modelToken!,
      "test",
      5,
      undefined,
      undefined,
      undefined,
      updatedRun.frozen_invocation!.effortArgs,
    );
    expect(renderedArgs).toContain("gemini-4-hydrogen-xhigh");
    expect(renderedArgs).not.toContain("--effort");

    // 落定账号最终重读真实目录发现不支持（有效空目录）时：必须立刻释放 permit 并拒绝启动
    await bridge.releaseRun(run.id, true);
    fix.probe.probeModels = async () => ({
      native_ids: [],
      executable_fingerprint: "fixture-fingerprint",
      observed_at: new Date().toISOString(),
      cli_version: "1.5.6",
      credential_revision: fix.repository.getAccount("default-agy-realm", fix.active())?.credential_revision ?? 1,
    });
    // 使已缓存目录过期，触发 prepareProfileRun 在拿到 binding 后通过 readActiveModelSnapshot 重读并识别出不支持
    for (const ptr of test.store.list<{ catalogId: string }>("model_catalog_pointer", "agy")) {
      const cat = test.store.get<any>("model_catalog", ptr.catalogId);
      if (cat) {
        test.store.put("model_catalog", ptr.catalogId, "agy", {
          ...cat,
          status: "stale",
          discoveredAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          staleAfter: new Date(Date.now() - 10_000).toISOString(),
        });
      }
    }
    await expect(
      bridge.prepareProfileRun(workflow.id, updatedRun, "gemini-4-hydrogen-xhigh", "executor"),
    ).rejects.toMatchObject({ code: "MODEL_NOT_LISTED", status: 422 });
    expect(fix.repository.listPermits("default-agy-realm").every((p) => p.status === "released")).toBe(true);
  });
});

describe("A06: 全路径 HTTP 配置保存/修改校验与不支持账号拒跑但不降档", () => {
  it("覆盖默认设置、创建工作流、执行规格/角色覆盖、模型切换、修复指派、群聊增改与 sync/执行拒跑", async () => {
    const test = setup();
    const { repo } = await repository(test.root);
    const fix = accountFixture(test.store, "gemini-4-hydrogen-xhigh");
    fix.seedAccounts();
    for (const id of ["a", "b", "c"]) fix.addSavedAccount(id);

    // 让当前激活的 a 支持 Hydrogen，b 为有效空目录
    let currentHostId = "a";
    attachModels(fix, "a", HYDROGEN_VARIANTS);
    attachModels(fix, "b", []);
    attachModels(fix, "c", []);
    seedGeminiQuota(fix, "a", 0.9, 0.9);
    seedGeminiQuota(fix, "b", 0.95, 0.95);
    seedGeminiQuota(fix, "c", 0.1, 0.1);

    fix.probe.probeModels = async () => {
      const acc = fix.repository.getAccount("default-agy-realm", currentHostId);
      return {
        native_ids: currentHostId === "a" ? HYDROGEN_VARIANTS : [],
        executable_fingerprint: "fixture-fingerprint",
        observed_at: new Date().toISOString(),
        cli_version: "1.5.6",
        credential_revision: acc?.credential_revision ?? 1,
      };
    };
    fix.probe.probeUsage = async () => {
      const now = new Date().toISOString();
      const win = [
        { kind: "weekly" as const, duration_minutes: 10080 as const, remaining_fraction: 0.9, reset_at: new Date(Date.now() + 86_400_000).toISOString(), observed_at: now, status: "observed" as const },
        { kind: "five_hour" as const, duration_minutes: 300 as const, remaining_fraction: 0.9, reset_at: new Date(Date.now() + 3_600_000).toISOString(), observed_at: now, status: "observed" as const },
      ];
      return {
        email: `${currentHostId}@example.com`,
        cli_version: "1.5.6",
        windows: win,
        raw_output: "",
        pools: [{ pool_id: "Gemini Models", model_ids: ["gemini-*"], windows: win }],
        executable_fingerprint: "fixture-fingerprint",
        capability_verified: true,
      };
    };

    vi.spyOn(fix.authHost, "inspectActive").mockImplementation(async () => ({
      exists: true,
      auth: { email: `${currentHostId}@example.com`, has_refresh_credential: true },
    }));
    await fix.service.start({ realmId: "default-agy-realm", requestId: "http-start" });

    const fakeCli = createFakeAgyCli(test.root);
    const restoreResolver = setAdapterExecutableResolver((adapterId) => (adapterId === "agy" ? fakeCli : undefined));
    const app = await buildServer(test.engine, {
      accountService: fix.service,
    });
    cleanups.push(async () => {
      restoreResolver();
      await app.close();
      await fix.service.close();
      test.store.close();
      rmSync(test.root, { recursive: true, force: true });
    });
    const headers = testConsoleHeaders(test.config);

    const refreshAgyCatalog = async () => {
      const refresh = await app.inject({
        method: "POST",
        url: "/api/model-tools/agy/models/refresh",
        headers,
        payload: { request_id: randomUUID() },
      });
      expect([200, 202]).toContain(refresh.statusCode);
      const deadline = Date.now() + 5000;
      let lastBody: unknown;
      while (Date.now() < deadline) {
        const peek = await app.inject({
          method: "GET",
          url: "/api/model-tools/agy/models",
          headers,
        });
        lastBody = peek.json();
        if ((lastBody as any).status === "fresh" && (lastBody as any).discoveryStatus === "complete") {
          return lastBody;
        }
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`timed out waiting for fresh AGY catalog: ${JSON.stringify(lastBody)} op=${refresh.body}`);
    };

    // 1. 账号 A 刷新 AGY 目录并预置 CLI 基础 probe verified（模拟已测通一次模型探测）
    await refreshAgyCatalog();

    const planner = flashProfile("planner");
    const hydrogenExec = hydrogenProfile("executor", "gemini-4-hydrogen-xhigh", "xhigh");
    const fixerProfile = hydrogenProfile("functional_fixer", "gemini-4-hydrogen-high", "high");
    const access = new ModelAccessService(test.store, {
      catalog: new ModelCatalogService(test.store),
    });
    access.seedVerified(planner, access.identityFromProfile(planner, repo));
    access.seedVerified(hydrogenExec, access.identityFromProfile(hydrogenExec, repo));
    access.seedVerified(fixerProfile, access.identityFromProfile(fixerProfile, repo));
    const plannerGlobal = flashProfile("planner");
    const hydrogenGlobal = hydrogenProfile("executor", "gemini-4-hydrogen-xhigh", "xhigh");
    access.seedVerified(plannerGlobal, access.identityFromProfile(plannerGlobal));
    access.seedVerified(hydrogenGlobal, access.identityFromProfile(hydrogenGlobal));

    const readDefaultsRev = async () =>
      (await app.inject({ method: "GET", url: "/api/settings/model-defaults", headers })).json().defaults.revision as number;
    const readSpecRev = async () =>
      (await app.inject({ method: "GET", url: `/api/workflows/${workflowId}/execution-spec`, headers })).json().spec_revision as number;

    const initialDefaultsRev = await readDefaultsRev();

    // 2. 账号 A 下全入口保存通过
    const defaultsRes = await app.inject({
      method: "PUT",
      url: "/api/settings/model-defaults",
      headers,
      payload: {
        request_id: randomUUID(),
        expected_defaults_revision: initialDefaultsRev,
        planner_profile: plannerGlobal,
        executor_profile: hydrogenGlobal,
        reviewer_binding: { mode: "inherit" },
      },
    });
    expect([200, 201], defaultsRes.body).toContain(defaultsRes.statusCode);
    const savedDefaultsRev = await readDefaultsRev();

    const createWfRes = await app.inject({
      method: "POST",
      url: "/api/workflows",
      headers,
      payload: {
        request_id: randomUUID(),
        workspace_root: repo,
        workspace_mode: "existing_workspace",
        title: "Hydrogen 全路径验收任务",
        request_text: "测试创建时携带 Hydrogen",
        planner_profile: planner,
        executor_profile: hydrogenExec,
        role_overrides: { ...inheritRoleOverrides(), functional_fixer: { mode: "explicit", profile: fixerProfile } },
      },
    });
    expect(createWfRes.statusCode, createWfRes.body).toBe(200);
    const workflowId = createWfRes.json().workflow.id as string;

    const specUpdateRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execution-spec`,
      headers,
      payload: {
        request_id: randomUUID(),
        expected_spec_revision: await readSpecRev(),
        planner_profile: planner,
        executor_profile: hydrogenExec,
        role_overrides: inheritRoleOverrides(),
      },
    });
    expect(specUpdateRes.statusCode, specUpdateRes.body).toBe(200);

    const wfAfterSpec = test.engine.get(workflowId);
    const switchRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/model-switch`,
      headers,
      payload: {
        request_id: randomUUID(),
        expected_spec_revision: await readSpecRev(),
        expected_workflow_version: wfAfterSpec.version,
        expected_run_id: null,
        planner_profile: planner,
        executor_profile: hydrogenExec,
        role_overrides: { ...inheritRoleOverrides(), functional_fixer: { mode: "explicit", profile: fixerProfile } },
        resume_after_switch: false,
      },
    });
    expect(switchRes.statusCode, switchRes.body).toBe(200);

    // 开一个功能修复批，验证 repair-model-assignment 在账号 A 通过
    const repairService = new RepairModelService(test.store, new ExecutionSpecService(test.store));
    repairService.attachIssueRepair({
      workflow_id: workflowId,
      request_id: randomUUID(),
      issue: {
        issue_id: "issue-h1",
        workflow_id: workflowId,
        created_seq: 1,
        description: "触发修复批",
        refs: [],
        attachment_ids: [],
        created_at: new Date().toISOString(),
        status: "open",
      },
    });
    const repairAssignRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/repair-model-assignment`,
      headers,
      payload: {
        request_id: randomUUID(),
        batch_id: test.store.list<any>("repair_model_batch", workflowId)[0]!.id,
        expected_assignment_revision: 0,
        expected_spec_revision: await readSpecRev(),
        selection: { mode: "custom", profile: fixerProfile },
      },
    });
    expect(repairAssignRes.statusCode, repairAssignRes.body).toBe(200);

    // 群聊创建与编辑在账号 A 通过
    const groupCreateRes = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers,
      payload: {
        title: "Hydrogen 讨论组",
        human: "我",
        admin: 0,
        members: [
          {
            nickname: "Hydrogen",
            tool: "agy",
            model: "gemini-4-hydrogen-xhigh",
            effort: "xhigh",
          },
          {
            nickname: "Flash",
            tool: "agy",
            model: "gemini-3.8-flash-high",
            effort: "high",
          },
        ],
      },
    });
    expect(groupCreateRes.statusCode, groupCreateRes.body).toBe(200);
    const groupId = groupCreateRes.json().id as string;
    const stripMemberIds = (items: Array<any>) => items.map(({ id: _id, ...rest }) => rest);

    const groupPutRes = await app.inject({
      method: "PUT",
      url: `/api/groups/${groupId}`,
      headers,
      payload: {
        version: groupCreateRes.json().version,
        title: "Hydrogen 讨论组更新",
        human: "我",
        admin: 0,
        members: stripMemberIds(groupCreateRes.json().members),
      },
    });
    expect(groupPutRes.statusCode, groupPutRes.body).toBe(200);

    // 创建群聊会话（sync 阶段先发生前仍保留成员）
    const sessionRes = await app.inject({
      method: "POST",
      url: `/api/groups/${groupId}/sessions`,
      headers,
      payload: {
        title: "测试跨账号保留不降档",
        scene: "open",
      },
    });
    expect(sessionRes.statusCode, sessionRes.body).toBe(200);
    const sessionId = sessionRes.json().id as string;

    // 3. 切换到不支持（有效空目录）的账号 B 并刷新目录
    currentHostId = "b";
    await fix.authHost.activateSaved("default-agy-realm", "b", "saved-b");
    const realm = fix.repository.getRealm("default-agy-realm")!;
    fix.repository.saveRealm({
      ...realm,
      active_account_id: "b",
      auth_epoch: realm.auth_epoch + 1,
      revision: realm.revision + 1,
    });
    await refreshAgyCatalog();
    // 给账号 B 预置非 Hydrogen 模型（planner / plannerGlobal）为 verified，确保下面全部拦截精确落在 Hydrogen 目录校验本身
    access.seedVerified(plannerGlobal, access.identityFromProfile(plannerGlobal));
    access.seedVerified(planner, access.identityFromProfile(planner, repo));

    const verifyReject = await app.inject({
      method: "POST",
      url: "/api/model-access/verify",
      headers,
      payload: {
        request_id: randomUUID(),
        profile: hydrogenGlobal,
      },
    });
    expect(verifyReject.statusCode, verifyReject.body).toBe(422);
    expect(verifyReject.json().error?.code ?? verifyReject.json().code).toBe("MODEL_NOT_LISTED");

    // 即使仍存在 A 时代缓存的 verified，全部新建/修改/设置写接口在账号 B 下必须全部返回 422 MODEL_NOT_LISTED
    const defaultsReject = await app.inject({
      method: "PUT",
      url: "/api/settings/model-defaults",
      headers,
      payload: {
        request_id: randomUUID(),
        expected_defaults_revision: savedDefaultsRev,
        planner_profile: plannerGlobal,
        executor_profile: hydrogenGlobal,
      },
    });
    expect(defaultsReject.statusCode, defaultsReject.body).toBe(422);
    expect(defaultsReject.json().error?.code ?? defaultsReject.json().code).toBe("MODEL_NOT_LISTED");

    const wfReject = await app.inject({
      method: "POST",
      url: "/api/workflows",
      headers,
      payload: {
        request_id: randomUUID(),
        workspace_root: repo,
        workspace_mode: "existing_workspace",
        title: "应被拒绝的任务",
        request_text: "B 账号不应允许创建 Hydrogen",
        planner_profile: planner,
        executor_profile: hydrogenExec,
      },
    });
    expect(wfReject.statusCode, wfReject.body).toBe(422);
    expect(wfReject.json().error?.code ?? wfReject.json().code, wfReject.body).toBe("MODEL_NOT_LISTED");

    const specReject = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/execution-spec`,
      headers,
      payload: {
        request_id: randomUUID(),
        expected_spec_revision: await readSpecRev(),
        planner_profile: planner,
        executor_profile: hydrogenExec,
        role_overrides: inheritRoleOverrides(),
      },
    });
    expect(specReject.statusCode, specReject.body).toBe(422);
    expect(specReject.json().error?.code ?? specReject.json().code, specReject.body).toBe("MODEL_NOT_LISTED");

    const switchReject = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/model-switch`,
      headers,
      payload: {
        request_id: randomUUID(),
        expected_spec_revision: await readSpecRev(),
        expected_workflow_version: test.engine.get(workflowId).version,
        expected_run_id: null,
        planner_profile: planner,
        executor_profile: hydrogenExec,
        role_overrides: inheritRoleOverrides(),
        resume_after_switch: false,
      },
    });
    expect(switchReject.statusCode, switchReject.body).toBe(422);
    expect(switchReject.json().error?.code ?? switchReject.json().code, switchReject.body).toBe("MODEL_NOT_LISTED");

    const repairReject = await app.inject({
      method: "POST",
      url: `/api/workflows/${workflowId}/repair-model-assignment`,
      headers,
      payload: {
        request_id: randomUUID(),
        batch_id: test.store.list<any>("repair_model_batch", workflowId)[0]!.id,
        expected_assignment_revision: 1,
        expected_spec_revision: await readSpecRev(),
        selection: { mode: "custom", profile: fixerProfile },
      },
    });
    expect(repairReject.statusCode, repairReject.body).toBe(422);
    expect(repairReject.json().error?.code ?? repairReject.json().code, repairReject.body).toBe("MODEL_NOT_LISTED");

    const groupPostReject = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers,
      payload: {
        title: "B 账号禁建群",
        human: "我",
        admin: 0,
        members: [
          {
            nickname: "Hydrogen",
            tool: "agy",
            model: "gemini-4-hydrogen-xhigh",
            effort: "xhigh",
          },
        ],
      },
    });
    expect(groupPostReject.statusCode, groupPostReject.body).toBe(422);
    expect(groupPostReject.json().error?.code ?? groupPostReject.json().code, groupPostReject.body).toBe("MODEL_NOT_LISTED");

    const groupPutReject = await app.inject({
      method: "PUT",
      url: `/api/groups/${groupId}`,
      headers,
      payload: {
        version: groupPutRes.json().version,
        title: "B 账号禁改群",
        human: "我",
        admin: 0,
        members: stripMemberIds(groupPutRes.json().members),
      },
    });
    expect(groupPutReject.statusCode, groupPutReject.body).toBe(422);
    expect(groupPutReject.json().error?.code ?? groupPutReject.json().code, groupPutReject.body).toBe("MODEL_NOT_LISTED");

    // sync 必须保留成员配置原样，不得静默改写或降档；且将 a 配额设为 0 后群聊实际触发运行应明确拒跑
    const updatedGroupInStore = await app.inject({ method: "GET", url: `/api/groups`, headers });
    const savedGroup = (updatedGroupInStore.json() as Array<any>).find((g) => g.id === groupId);
    const hMember = savedGroup.members.find((m: any) => m.nickname === "Hydrogen");
    expect(hMember.model).toBe("gemini-4-hydrogen-xhigh");
    expect(hMember.effort).toBe("xhigh");

    const syncRes = await app.inject({
      method: "POST",
      url: `/api/group-sessions/${sessionId}/actions`,
      headers,
      payload: {
        version: sessionRes.json().version,
        request: randomUUID(),
        input: { action: "sync" },
      },
    });
    expect(syncRes.statusCode, syncRes.body).toBe(200);
    const sessionAfterSync = await app.inject({ method: "GET", url: `/api/group-sessions/${sessionId}`, headers });
    const hSessionMember = sessionAfterSync.json().session.members.find((m: any) => m.nickname === "Hydrogen");
    expect(hSessionMember.model).toBe("gemini-4-hydrogen-xhigh");
    expect(hSessionMember.effort).toBe("xhigh");

    // 4. 在仅余不支持账号（a/b/c 均不支持 Hydrogen）下通过真实 HTTP 触发群聊 Hydrogen 成员运行：必须拒绝启动且保留配置不降档
    attachModels(fix, "a", []);
    attachModels(fix, "c", []);
    const sendRejectRes = await app.inject({
      method: "POST",
      url: `/api/group-sessions/${sessionId}/actions`,
      headers,
      payload: {
        version: sessionAfterSync.json().session.version,
        request: randomUUID(),
        input: {
          action: "send",
          text: "验证运行拒跑",
          targets: [hSessionMember.id],
          mode: "reply",
        },
      },
    });
    expect(sendRejectRes.statusCode, sendRejectRes.body).toBe(200);

    let failedJob: any;
    const failDeadline = Date.now() + 8000;
    while (Date.now() < failDeadline) {
      const view = (await app.inject({ method: "GET", url: `/api/group-sessions/${sessionId}`, headers })).json();
      const job = view.round?.jobs?.find((j: any) => j.member === hSessionMember.id);
      if (job && job.state !== "queued" && job.state !== "running") {
        failedJob = job;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(failedJob?.state).toBe("failed");
    expect(String(failedJob?.error ?? "")).toMatch(/active_account_unavailable|no_eligible_account|目录|Hydrogen|gemini-4-hydrogen|账号/i);

    const finalSession = (await app.inject({ method: "GET", url: `/api/group-sessions/${sessionId}`, headers })).json().session;
    const finalHydrogenMember = finalSession.members.find((m: any) => m.id === hSessionMember.id);
    expect(finalHydrogenMember.model).toBe("gemini-4-hydrogen-xhigh");
    expect(finalHydrogenMember.effort).toBe("xhigh");
  });
});
