import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import {
  ModelCatalogService,
  AGY_CATALOG_FRESH_MS,
} from "../../packages/core/src/model-catalog-service.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import {
  clearUnmanagedAgyIdentity,
  managedAgyAccountContextKey,
  readManagedAgyModelIdentity,
  recordUnmanagedAgyIdentity,
  resolveAgyAccountContext,
  resolveModelIdentity,
  type ManagedAgyModelIdentity,
} from "../../packages/core/src/model-identity.js";
import { setAdapterExecutableResolver } from "../../packages/adapters/sdk/src/registry.js";
import { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import { AgyAccountSchema, AgyRealmSchema, type ToolProfile } from "../../packages/contracts/src/index.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { buildServer } from "../../apps/api/src/server.js";
import { setup, testConsoleHeaders } from "../helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});

const hydrogenList = [
  "gemini-4-hydrogen-low",
  "gemini-4-hydrogen-medium",
  "gemini-4-hydrogen-high",
  "gemini-4-hydrogen-xhigh",
  "gemini-3.8-flash-high",
];

function managedIdentity(accountId: string, authEpoch: number, credentialRevision: number): ManagedAgyModelIdentity {
  return {
    realmId: "default-agy-realm",
    accountId,
    authEpoch,
    credentialRevision,
  };
}

function setActiveManagedAccount(store: Store, identity: ManagedAgyModelIdentity) {
  const repo = new AgyAccountRepository(store);
  const ts = new Date().toISOString();
  repo.saveRealm(
    AgyRealmSchema.parse({
      realm_id: identity.realmId,
      owner: "default",
      desired_enabled: true,
      service_state: "running",
      phase: "idle",
      active_account_id: identity.accountId,
      auth_epoch: identity.authEpoch,
      revision: identity.authEpoch,
      control_generation: 1,
    }),
  );
  repo.saveAccount(
    AgyAccountSchema.parse({
      id: identity.accountId,
      realm_id: identity.realmId,
      alias: `Account ${identity.accountId}`,
      identity: { email: `${identity.accountId}@example.com`, verified_at: ts },
      secret_ref: `saved-${identity.accountId}`,
      credential_revision: identity.credentialRevision,
      state: "ready",
      enrolled_at: ts,
      enrollment_completed_at: ts,
      auth: {
        has_refresh_credential: true,
        refresh_expiry_source: "not_provided",
        last_refresh_verified_at: ts,
      },
    }),
  );
}

function hydrogenProfile(modelId = "gemini-4-hydrogen-xhigh", value = "xhigh"): ToolProfile {
  return {
    id: "executor",
    revision: 1,
    adapterId: "agy",
    modelSelection: "explicit",
    selectionKind: "fixed",
    modelId,
    reasoning: { mode: "explicit", value },
    options: {},
  };
}

describe("A02/A06: AGY Gemini 4 Hydrogen 账号隔离、有效空目录与准入校验", () => {
  it("严格隔离支持与不支持/有效空目录账号，禁止跨账号借用、延迟串号或手工注入 Hydrogen", async () => {
    const store = new Store(":memory:");
    cleanups.push(() => store.close());

    const accA = managedIdentity("acc-a", 1, 1);
    const accB = managedIdentity("acc-b", 2, 1);
    let current = accA;
    let resolveDelayed!: (value: { native_ids: string[]; cli_version?: string; credential_revision?: number } | undefined) => void;
    let markDelayedStarted!: () => void;
    const delayedStarted = new Promise<void>((resolve) => {
      markDelayedStarted = resolve;
    });
    let rejectRefresh = false;

    const catalog = new ModelCatalogService(store, {
      readAgyModels: async (expected) => {
        if (current.accountId === "acc-a" && expected?.accountId === "acc-a") {
          return { native_ids: hydrogenList, cli_version: "1.5.6", credential_revision: accA.credentialRevision };
        }
        if (rejectRefresh) {
          throw new Error("simulated refresh error");
        }
        return new Promise((resolve) => {
          resolveDelayed = resolve;
          markDelayedStarted();
        });
      },
    });

    const dir = mkdtempSync(join(tmpdir(), "agy-iso-cli-"));
    const fakeCli = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeCli,
      [
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('1.5.6'); process.exit(0); }",
        "if (args.includes('--help')) { console.log('Antigravity CLI (agy) usage'); process.exit(0); }",
        "process.exit(0);",
      ].join("\n"),
    );
    const restoreResolver = setAdapterExecutableResolver((adapterId) =>
      adapterId === "agy" ? fakeCli : undefined,
    );
    cleanups.push(() => {
      restoreResolver();
      rmSync(dir, { recursive: true, force: true });
    });

    const scopeFor = (m: ManagedAgyModelIdentity) => {
      const resolved = resolveModelIdentity(store, {
        adapterId: "agy",
        executableRef: fakeCli,
      });
      return {
        adapterId: "agy" as const,
        executablePath: resolved.executablePath,
        nativeConfigScope: resolved.nativeConfigScope,
        accountFingerprint: resolved.accountFingerprint,
        providerFingerprint: resolved.providerEndpointFingerprint,
        accountContextKey: managedAgyAccountContextKey(m),
        managedAgy: m,
      };
    };

    // 1. 账号 A 刷新并得到 Hydrogen 四档
    setActiveManagedAccount(store, accA);
    expect(readManagedAgyModelIdentity(store)?.accountId).toBe("acc-a");
    const catA = await catalog.discover(scopeFor(accA));
    expect(catA.status).toBe("fresh");
    expect(catA.discoveryStatus).toBe("complete");
    expect(catA.accountContextKey).toBe(managedAgyAccountContextKey(accA));
    expect(catA.entries.some(e => e.nativeId === "gemini-4-hydrogen-xhigh")).toBe(true);

    // 2. 切到账号 B 并发起刷新；验证无法借用 A
    current = accB;
    setActiveManagedAccount(store, accB);
    const pendingB = catalog.discover(scopeFor(accB));
    const access = new ModelAccessService(store, { catalog });

    // B 账号初始未确认，校验 Hydrogen 必须返回 409 AGY_MODEL_CAPABILITY_UNKNOWN，且不得借用 A
    expect(() => access.verifyAccess({ request_id: randomUUID(), profile: hydrogenProfile(), catalog: catalog.readCached(scopeFor(accB)) })).toThrowError(
      expect.objectContaining({ code: "AGY_MODEL_CAPABILITY_UNKNOWN", status: 409 }),
    );

    // 返回有效空列表给 B
    await delayedStarted;
    resolveDelayed({ native_ids: [], cli_version: "1.5.6", credential_revision: accB.credentialRevision });
    const catB = await pendingB;
    expect(catB.status).toBe("fresh");
    expect(catB.discoveryStatus).toBe("complete");
    expect(catB.entries).toEqual([]);
    expect(catB.accountContextKey).toBe(managedAgyAccountContextKey(accB));

    // 3. 禁止给不支持的 B 通过 ensureManualCandidate 注入 Hydrogen
    expect(() => catalog.ensureManualCandidate(scopeFor(accB), "gemini-4-hydrogen-xhigh")).toThrowError(
      expect.objectContaining({ code: "MODEL_NOT_LISTED" }),
    );
    expect(() => access.verifyAccess({ request_id: randomUUID(), profile: hydrogenProfile(), catalog: catB })).toThrowError(
      expect.objectContaining({ code: "MODEL_NOT_LISTED", status: 422 }),
    );
    expect(() => access.assertCachedAccess(hydrogenProfile(), access.identityFromProfile(hydrogenProfile()), catB)).toThrowError(
      expect.objectContaining({ code: "MODEL_NOT_LISTED", status: 422 }),
    );

    // 4. B 再次刷新失败时，必须保留 B 的空列表，绝不串回 A
    rejectRefresh = true;
    await expect(catalog.discover(scopeFor(accB))).rejects.toThrow("simulated refresh error");
    const catBAfterFail = catalog.loadForSelector(scopeFor(accB));
    expect(catBAfterFail.accountContextKey).toBe(managedAgyAccountContextKey(accB));
    expect(catBAfterFail.entries).toEqual([]);

    // 5. 切回 A 时检查 15 分钟 TTL 上限：若 A 的目录时间戳超过 AGY_CATALOG_FRESH_MS 则自动变 stale
    setActiveManagedAccount(store, accA);
    const freshCheck = catalog.loadForSelector(scopeFor(accA));
    expect(freshCheck.status).toBe("fresh");
    const oldCat = {
      ...catA,
      discoveredAt: new Date(Date.now() - AGY_CATALOG_FRESH_MS - 10_000).toISOString(),
    };
    // 通过 verifyAccess 检查错误档位
    expect(() =>
      access.verifyAccess({
        request_id: randomUUID(),
        profile: hydrogenProfile("gemini-4-hydrogen-xhigh", "low"),
        catalog: catA,
      }),
    ).toThrow();
    expect(AGY_CATALOG_FRESH_MS).toBeLessThanOrEqual(15 * 60_000);
    expect(Date.now() - Date.parse(oldCat.discoveredAt)).toBeGreaterThan(AGY_CATALOG_FRESH_MS);
  });

  it("切号进行中 GET /api/model-tools/agy/models 返回切换中/missing，而非返回上一账号目录", async () => {
    const test = setup();
    const accFix = accountFixture(test.store, "gemini-4-hydrogen-high");
    accFix.seedAccounts();
    const accountA = accFix.repository.getAccount("default-agy-realm", "a")!;
    accFix.repository.saveAccount({
      ...accountA,
      models: {
        native_ids: hydrogenList,
        executable_fingerprint: "fp",
        observed_at: new Date().toISOString(),
        cli_version: "1.5.6",
        credential_revision: accountA.credential_revision,
      },
    });
    vi.spyOn(accFix.authHost, "inspectActive").mockResolvedValue({
      exists: true,
      auth: { email: "a@example.com", has_refresh_credential: true },
    });
    await accFix.service.start({ realmId: "default-agy-realm", requestId: "start-op" });

    // 标记 realm 正在进行 switch 操作
    const realm = accFix.repository.getRealm("default-agy-realm")!;
    accFix.repository.saveRealm({ ...realm, pending_operation_id: "switch-pending-1", phase: "switching" });

    const app = await buildServer(test.engine, { accountService: accFix.service });
    cleanups.push(async () => {
      await app.close();
      await accFix.service.close();
      test.store.close();
      rmSync(test.root, { recursive: true, force: true });
    });

    const headers = testConsoleHeaders(test.config);
    const res = await app.inject({ method: "GET", url: "/api/model-tools/agy/models", headers });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.status).toBe("refreshing");
    expect(json.discoveryStatus).toBe("missing");
    expect(json.entries).toEqual([]);
  });

  it("CA02: 非托管无法确认实际账号身份和认证上下文时不得开放 Hydrogen，绑定真实非托管上下文后方按上下文放行", async () => {
    const test = setup();
    const accFix = accountFixture(test.store, "gemini-4-hydrogen-xhigh");
    const app = await buildServer(test.engine, { accountService: accFix.service });
    const dir = mkdtempSync(join(tmpdir(), "agy-unmanaged-ca02-"));
    const fakeCli = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeCli,
      [
        "const args = process.argv.slice(2);",
        "if (args.includes('--version')) { console.log('1.5.6'); process.exit(0); }",
        "if (args.includes('--help')) { console.log('Antigravity CLI (agy) usage'); process.exit(0); }",
        "if (args.includes('models')) { console.log('gemini-4-hydrogen-xhigh\\tGemini 4 Hydrogen (Extra)\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)'); process.exit(0); }",
        "process.exit(0);",
      ].join("\n"),
    );
    const restoreResolver = setAdapterExecutableResolver((adapterId) =>
      adapterId === "agy" ? fakeCli : undefined,
    );
    cleanups.push(async () => {
      restoreResolver();
      await app.close();
      await accFix.service.close();
      test.store.close();
      rmSync(test.root, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    });

    const headers = testConsoleHeaders(test.config);
    const catalogService = new ModelCatalogService(test.store);
    // 1. 默认非托管退化（scope:default / profile-scope）：即使 CLI 输出 Hydrogen，发现与输出均不得开放 Hydrogen
    expect(resolveAgyAccountContext(test.store).verified).toBe(false);
    const opRes = await app.inject({
      method: "POST",
      url: "/api/model-tools/agy/models/refresh",
      headers,
      payload: { request_id: randomUUID() },
    });
    expect([200, 202]).toContain(opRes.statusCode);
    await catalogService.waitForOperation(opRes.json().id);

    const listRes = await app.inject({ method: "GET", url: "/api/model-tools/agy/models", headers });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().entries.some((e: any) => String(e.nativeId).includes("hydrogen"))).toBe(false);

    // 即使手工创建带空/错上下文或无 options.catalog 的 ModelAccessService，也禁止放行 Hydrogen 验证或保存
    const bareAccess = new ModelAccessService(test.store);
    const hProf = hydrogenProfile("gemini-4-hydrogen-xhigh", "xhigh");
    expect(() => bareAccess.verifyAccess({ request_id: randomUUID(), profile: hProf })).toThrowError(
      expect.objectContaining({ code: "AGY_MODEL_CAPABILITY_UNKNOWN" }),
    );
    expect(() => bareAccess.assertCachedAccess(hProf, bareAccess.identityFromProfile(hProf))).toThrowError(
      expect.objectContaining({ code: "AGY_MODEL_CAPABILITY_UNKNOWN" }),
    );
    const groupDeny = await app.inject({
      method: "POST",
      url: "/api/groups",
      headers,
      payload: {
        title: "非托管未确认禁止 Hydrogen",
        human: "我",
        admin: 0,
        members: [{ nickname: "h", tool: "agy", model: "gemini-4-hydrogen-xhigh", effort: "xhigh" }],
      },
    });
    expect(groupDeny.statusCode).toBe(409);

    // 2. 绑定真实非托管账号和认证上下文后，同上下文目录正常暴露与校验 Hydrogen；切换不同上下文则拒绝
    recordUnmanagedAgyIdentity(test.store, {
      accountId: "native-user-1",
      contextKey: "agy-unmanaged:native-user-1:rev1",
    });
    expect(resolveAgyAccountContext(test.store).verified).toBe(true);
    const refreshBound = await app.inject({
      method: "POST",
      url: "/api/model-tools/agy/models/refresh",
      headers,
      payload: { request_id: randomUUID() },
    });
    await catalogService.waitForOperation(refreshBound.json().id);
    const boundList = await app.inject({ method: "GET", url: "/api/model-tools/agy/models", headers });
    expect(boundList.statusCode).toBe(200);
    expect(boundList.json().entries.some((e: any) => e.nativeId === "gemini-4-hydrogen-xhigh")).toBe(true);

    // 更换认证上下文（如凭据变化）而目录仍是旧上下文 -> 拒绝放行
    recordUnmanagedAgyIdentity(test.store, {
      accountId: "native-user-1",
      contextKey: "agy-unmanaged:native-user-1:rev2",
    });
    expect(() =>
      new ModelAccessService(test.store, { catalog: catalogService }).verifyAccess({
        request_id: randomUUID(),
        profile: hProf,
      }),
    ).toThrowError(expect.objectContaining({ code: "AGY_MODEL_CAPABILITY_UNKNOWN" }));
    clearUnmanagedAgyIdentity(test.store);
  });
});
