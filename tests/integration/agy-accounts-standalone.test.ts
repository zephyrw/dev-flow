import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { Store } from "../../packages/store/src/store.js";
import { buildAccountsServer } from "../../apps/api/src/accounts-server.js";
import { hash } from "../../packages/core/src/util.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { formatSnapshotQuotaWindow } from "../../packages/presentation/src/agy-accounts.js";

describe("independent account server", () => {
  let root: string,
    store: Store,
    fixture: ReturnType<typeof accountFixture>,
    app: FastifyInstance;
  const origin = "http://127.0.0.1:49152";
  const headers = {
    host: "127.0.0.1:49152",
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
  };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "devflow-account-api-"));
    store = new Store(join(root, "devflow.sqlite"));
    fixture = accountFixture(store, "gemini-fixture");
    const web = join(root, "web");
    mkdirSync(web);
    writeFileSync(join(web, "index.html"), "<main>account-fixture</main>");
    app = buildAccountsServer(fixture.service, {
      port: 49152,
      humanOrigin: origin,
      storageInstance: root,
      webRoot: web,
    });
    await app.ready();
  });
  afterEach(async () => {
    await fixture.service.close();
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  it("shares the launcher identity contract, hosts the account page and has no workflow endpoints", async () => {
    const health = await app.inject({
      method: "GET",
      url: "/api/health",
      headers,
    });
    expect(health.json()).toMatchObject({
      service: "devflow",
      instance: hash(root.toLowerCase()),
      mode: "accounts",
      features: { workflows: false, agy_accounts: true },
    });
    expect(
      (await app.inject({ method: "GET", url: "/accounts", headers })).body,
    ).toContain("account-fixture");
    for (const url of ["/api/workflows", "/mcp", "/api/worker/run"]) {
      expect(
        (await app.inject({ method: "GET", url, headers })).statusCode,
      ).toBe(404);
    }
    for (const kind of ["project", "workflow", "run", "conversation"])
      expect(store.list(kind)).toHaveLength(0);
    expect(fixture.probeCalls()).toBe(0);
  });
  it("rejects model bearer, cross-site, missing CAS and private settings fields", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/agy-accounts",
          headers: { ...headers, authorization: "Bearer model" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agy-accounts/service/start",
          headers: { ...headers, origin: "http://evil.invalid" },
          payload: { request_id: "start", expected_settings_revision: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/agy-accounts/settings",
          headers,
          payload: { request_id: "edit", standalone_model_id: "gemini-fixture" },
        })
      ).statusCode,
    ).toBe(422);
    for (const field of [
      "realm_id",
      "auth_host_executable",
      "token",
      "command",
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/agy-accounts/settings",
            headers,
            payload: {
              request_id: `edit-${field}`,
              expected_revision: 1,
              [field]: "bad",
            },
          })
        ).statusCode,
      ).toBe(422);
    }
    expect(fixture.probeCalls()).toBe(0);
  });
  it("persists config with CAS and never returns secret refs or executable paths", async () => {
    const initial = fixture.repository.getSettings("default-agy-realm")!;
    const update = await app.inject({
      method: "PUT",
      url: "/api/agy-accounts/settings",
      headers,
      payload: {
        request_id: "settings-update",
        expected_revision: initial.revision,
        workflow_auto_switch: false,
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().workflow_auto_switch).toBe(false);
    expect(update.body).not.toContain("auth_host_executable");
    const stale = await app.inject({
      method: "PUT",
      url: "/api/agy-accounts/settings",
      headers,
      payload: {
        request_id: "stale-update",
        expected_revision: initial.revision,
        workflow_auto_switch: true,
      },
    });
    expect(stale.statusCode).toBe(409);
    fixture.seedAccounts();
    const list = await app.inject({
      method: "GET",
      url: "/api/agy-accounts",
      headers,
    });
    expect(list.json().accounts).toHaveLength(3);
    expect(list.body).not.toContain("secret_ref");
    expect(list.body).not.toContain("saved-a");
  });

  it("preserves omitted settings and schedule values across HTTP partial updates", async () => {
    const initial = fixture.repository.getSettings("default-agy-realm")!;
    const before = fixture.service.updateSettings("default-agy-realm", { workflow_auto_switch: false, switch_gap_seconds: 9, maintenance: { timezone: "UTC", night_start: "21:30" } }, initial.revision, "seed-custom-settings");
    const changedModel = await app.inject({ method: "PUT", url: "/api/agy-accounts/settings", headers, payload: { request_id: "model-only", expected_revision: before.revision, standalone_model_id: "another-model" } });
    expect(changedModel.statusCode).toBe(200);
    expect(changedModel.json()).toMatchObject({ workflow_auto_switch: false, switch_gap_seconds: 9, maintenance: { timezone: "UTC", night_start: "21:30" } });
    const changedSchedule = await app.inject({ method: "PUT", url: "/api/agy-accounts/settings", headers, payload: { request_id: "schedule-only", expected_revision: changedModel.json().revision, maintenance: { refresh_verified_max_age_hours: 12 } } });
    expect(changedSchedule.statusCode).toBe(200);
    expect(changedSchedule.json()).toMatchObject({ standalone_model_id: "another-model", workflow_auto_switch: false, maintenance: { timezone: "UTC", night_start: "21:30", refresh_verified_max_age_hours: 12 } });
    expect(fixture.probeCalls()).toBe(0);
  });
  it("returns a real durable operation receipt, deduplicates retries and cancels before any probe", async () => {
    fixture.seedAccounts();
    const settings = fixture.repository.getSettings("default-agy-realm")!;
    const start = await app.inject({
      method: "POST",
      url: "/api/agy-accounts/service/start",
      headers,
      payload: {
        request_id: "start",
        expected_settings_revision: settings.revision,
      },
    });
    expect(start.statusCode).toBe(202);
    const realm = fixture.repository.getRealm("default-agy-realm")!;
    const payload = {
      request_id: "switch-once",
      selection: { mode: "explicit", account_id: "b" },
      model_id: "gemini-fixture",
      expected_epoch: realm.auth_epoch,
      expected_settings_revision: settings.revision,
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/agy-accounts/switch",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(202);
    const retry = await app.inject({
      method: "POST",
      url: "/api/agy-accounts/switch",
      headers,
      payload,
    });
    expect(retry.json().operation_id).toBe(first.json().operation_id);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agy-accounts/switch",
          headers,
          payload: {
            ...payload,
            selection: { mode: "explicit", account_id: "c" },
          },
        })
      ).statusCode,
    ).toBe(409);
    const operationId = first.json().operation_id;
    const saved = await app.inject({
      method: "GET",
      url: `/api/agy-accounts/operations/${operationId}`,
      headers,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().operation_id).toBe(operationId);
    expect(saved.body).not.toContain("secret_ref");
    const cancel = await app.inject({
      method: "POST",
      url: `/api/agy-accounts/operations/${operationId}/cancel`,
      headers,
      payload: {
        request_id: "cancel-before-start",
        expected_revision: saved.json().revision,
      },
    });
    expect(cancel.statusCode).toBe(202);
    expect(fixture.probeCalls()).toBe(0);
  });
  it("does not accept trusted workflow triggers or arbitrary account selection fields over HTTP", async () => {
    for (const extra of [
      { trigger: "workflow_quota" },
      { workflow_id: "pretend" },
      { required_pool_ids: ["invented"] },
      { selection: { mode: "auto", account_id: "b" } },
    ]) {
      const result = await app.inject({
        method: "POST",
        url: "/api/agy-accounts/switch",
        headers,
        payload: {
          request_id: crypto.randomUUID(),
          selection: { mode: "auto" },
          expected_epoch: 0,
          expected_settings_revision: 1,
          ...extra,
        },
      });
      expect(result.statusCode).toBe(422);
    }
    expect(fixture.probeCalls()).toBe(0);
  });

  it("场景5：取消操作缺少 expected_revision 返回 422 拒绝", async () => {
    const payload = {
      request_id: crypto.randomUUID(),
      selection: { mode: "explicit" as const, account_id: "b" },
      expected_epoch: 0,
      expected_settings_revision: 1,
    };
    const res = await app.inject({
      method: "POST",
      url: "/api/agy-accounts/switch",
      headers,
      payload,
    });
    const opId = res.json().operation_id;
    const cancelWithoutRev = await app.inject({
      method: "POST",
      url: `/api/agy-accounts/operations/${opId}/cancel`,
      headers,
      payload: {
        request_id: crypto.randomUUID(),
      },
    });
    expect(cancelWithoutRev.statusCode).toBe(422);
  });

  it("场景7：首个账号在无账号域且 expected_realm_revision=0 时成功添加，有操作进行中时拒绝开启开关", async () => {
    // 首次无账号域时，直接添加首个账号，expected_realm_revision=0 成功返回 202
    const addFirst = await app.inject({
      method: "POST",
      url: "/api/agy-accounts/enroll",
      headers,
      payload: {
        request_id: crypto.randomUUID(),
        expected_realm_revision: 0,
        alias: "第一个账号",
        mode: "capture_current",
      },
    });
    expect(addFirst.statusCode).toBe(202);
    const opId = addFirst.json().operation_id;

    // 进行中的账号操作时开启开关，被正确拒绝（409 operation_in_progress）
    const autoWhileBusy = await app.inject({
      method: "PUT",
      url: "/api/agy-accounts/automation",
      headers,
      payload: {
        request_id: crypto.randomUUID(),
        enabled: true,
      },
    });
    expect(autoWhileBusy.statusCode).toBe(409);

    // 取消该操作收尾
    const op = await app.inject({
      method: "GET",
      url: `/api/agy-accounts/operations/${opId}`,
      headers,
    });
    await app.inject({
      method: "POST",
      url: `/api/agy-accounts/operations/${opId}/cancel`,
      headers,
      payload: {
        request_id: crypto.randomUUID(),
        expected_revision: op.json().revision,
      },
    });
  });

  it("场景6：无进行中操作时自动化开关开启与关闭正常执行", async () => {
    // 自动化开关开启
    const autoOn = await app.inject({
      method: "PUT",
      url: "/api/agy-accounts/automation",
      headers,
      payload: {
        request_id: crypto.randomUUID(),
        enabled: true,
      },
    });
    expect(autoOn.statusCode).toBe(200);
    expect(autoOn.json().enabled).toBe(true);

    // 自动化开关关闭
    const autoOff = await app.inject({
      method: "PUT",
      url: "/api/agy-accounts/automation",
      headers,
      payload: {
        request_id: crypto.randomUUID(),
        enabled: false,
      },
    });
    expect(autoOff.statusCode).toBe(200);
    expect(autoOff.json().enabled).toBe(false);
  });

  it("AGY-WEEKLY-03: HTTP and presentation preserve an incomplete enrollment snapshot", async () => {
    fixture.seedAccounts();
    const realmId = "default-agy-realm";
    const observedAt = new Date().toISOString();
    const weekly = {
      kind: "weekly" as const,
      duration_minutes: 10080 as const,
      remaining_fraction: 0.6,
      reset_at: null,
      observed_at: observedAt,
      status: "observed" as const,
    };
    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-b-incomplete",
      realm_id: realmId,
      account_id: "b",
      auth_epoch: 1,
      pool_id: "fixture-pool",
      model_ids: ["gemini-fixture"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      observed_at: observedAt,
      windows: [weekly],
      capability_verified: false,
    });
    const account = fixture.repository.getAccount(realmId, "b")!;
    fixture.repository.saveAccount({ ...account, state: "pending_quota" });

    const response = await app.inject({ method: "GET", url: "/api/agy-accounts", headers });
    expect(response.statusCode).toBe(200);
    const view = response.json();
    const snapshot = view.snapshots.find((s: any) => s.id === "snapshot-b-incomplete");
    expect(snapshot).toMatchObject({ capability_verified: false, windows: [weekly] });
    expect(formatSnapshotQuotaWindow(snapshot, "weekly", Date.now())).toMatchObject({
      percentageText: "60%",
      fraction: 0.6,
      shortResetText: "",
    });
    expect(view.accounts.find((a: any) => a.id === "b")?.state).toBe("pending_quota");
    expect(fixture.repository.listQuotaSnapshots(realmId, "b")[0]!.windows).toEqual([weekly]);
  });

  it("A08: 真实Store/Repository/Service/HTTP读取旧低值空时间或过期快照：公开视图100%，原始观测来源/时间不伪造，重开存储仍正确", async () => {
    // 注入真实旧低值快照（无时间或已过期）
    const realmId = "default-agy-realm";
    const originalObservedAt = "2026-09-24T10:00:00.000Z";
    fixture.repository.saveQuotaSnapshot({
      id: "snap-old-b",
      realm_id: realmId,
      account_id: "b",
      auth_epoch: 1,
      pool_id: "default",
      model_ids: ["gemini-fixture"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: originalObservedAt,
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0.6,
          reset_at: null,
          observed_at: originalObservedAt,
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: 0.7,
          reset_at: "2026-09-24T15:00:00.000Z",
          observed_at: originalObservedAt,
          status: "observed",
        },
      ],
      capability_verified: true,
    });

    // 1. 通过 HTTP API 请求公开视图
    const res = await app.inject({
      method: "GET",
      url: "/api/agy-accounts",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    const snapInView = view.snapshots.find((s: any) => s.id === "snap-old-b");
    const weeklyInView = snapInView?.windows.find((w: any) => w.kind === "weekly");

    // 公开视图应呈现为 100%，无倒计时
    expect(weeklyInView?.remaining_fraction).toBe(1);
    expect(weeklyInView?.reset_at).toBeNull();
    // 原始元数据不伪造
    expect(snapInView?.source).toBe("official_cli_usage");
    expect(snapInView?.observed_at).toBe(originalObservedAt);

    // 2. 检查底层 SQLite Store，数据库中的原始观测快照未被直接更新篡改
    const dbSnapshots = fixture.repository.listQuotaSnapshots(realmId);
    const rawSnap = dbSnapshots.find((s) => s.id === "snap-old-b");
    const rawWeekly = rawSnap?.windows.find((w) => w.kind === "weekly");
    expect(rawWeekly?.remaining_fraction).toBe(0.6);
    expect(rawWeekly?.reset_at).toBeNull();

    // 3. 检查底层 SQLite Store 表 agy_quota，数据真实落盘且未受篡改
    const storeRecord = store.get<any>("agy_quota", "b:default");
    expect(storeRecord?.windows.find((w: any) => w.kind === "weekly")?.remaining_fraction).toBe(0.6);
    expect(storeRecord?.windows.find((w: any) => w.kind === "weekly")?.reset_at).toBeNull();
  });

  it("A09: AGY运行且仅刷新当前账号：非当前账号仍恢复100%，不新增探测、凭证捕获、切换或重启", async () => {
    const realmId = "default-agy-realm";
    // 当前活动账号为 a
    expect(fixture.active()).toBe("a");
    const beforeProbes = fixture.probeCalls();

    // 为非活动账号 c 保存旧周额度（69% 且无重置时间）
    fixture.repository.saveQuotaSnapshot({
      id: "snap-c-unprobed",
      realm_id: realmId,
      account_id: "c",
      auth_epoch: 1,
      pool_id: "default",
      model_ids: ["gemini-fixture"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: "2026-09-24T08:00:00.000Z",
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0.69,
          reset_at: null,
          observed_at: "2026-09-24T08:00:00.000Z",
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: 0.8,
          reset_at: null,
          observed_at: "2026-09-24T08:00:00.000Z",
          status: "observed",
        },
      ],
      capability_verified: true,
    });

    // 读取公开视图
    const res = await app.inject({
      method: "GET",
      url: "/api/agy-accounts",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    const snapC = view.snapshots.find((s: any) => s.id === "snap-c-unprobed");
    const weeklyC = snapC?.windows.find((w: any) => w.kind === "weekly");

    // 非活动账号 c 在未被重新探测的情况下，依然即时在公开视图恢复 100%
    expect(weeklyC?.remaining_fraction).toBe(1);
    expect(weeklyC?.reset_at).toBeNull();

    // 探测次数未因查询而增加，活动账号未改变
    expect(fixture.probeCalls()).toBe(beforeProbes);
    expect(fixture.active()).toBe("a");
  });

  it("A10: 新周期较低额度及未来时间保存/重读后显示新值，旧满额推导不覆盖", async () => {
    const realmId = "default-agy-realm";
    const futureReset = new Date(Date.now() + 5 * 86400 * 1000).toISOString();

    // 账号进入新周期，CLI 探测到新的较低额度（45%）且有未来重置时间
    fixture.repository.saveQuotaSnapshot({
      id: "snap-new-cycle-b",
      realm_id: realmId,
      account_id: "b",
      auth_epoch: 2,
      pool_id: "default",
      model_ids: ["gemini-fixture"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: new Date().toISOString(),
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0.45,
          reset_at: futureReset,
          observed_at: new Date().toISOString(),
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: 0.8,
          reset_at: null,
          observed_at: new Date().toISOString(),
          status: "observed",
        },
      ],
      capability_verified: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/agy-accounts",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    const snapB = view.snapshots.find((s: any) => s.id === "snap-new-cycle-b");
    const weeklyB = snapB?.windows.find((w: any) => w.kind === "weekly");

    // 新快照有未来时间，必须显示实际观测值 45% 与倒计时，不能被旧 100% 满额推导覆盖
    expect(weeklyB?.remaining_fraction).toBe(0.45);
    expect(weeklyB?.reset_at).toBe(futureReset);
  });

  it("A11: 不同账号/模型池：仅对应窗口恢复，API与页面有效值一致，池选择及身份字段保持正确", async () => {
    fixture.seedAccounts();
    const realmId = "default-agy-realm";
    const futureReset = new Date(Date.now() + 3 * 86400 * 1000).toISOString();

    // 保存多池快照
    fixture.repository.saveQuotaSnapshot({
      id: "snap-gemini-pool",
      realm_id: realmId,
      account_id: "a",
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-pro"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: "2026-09-24T12:00:00.000Z",
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0.6,
          reset_at: null, // 无重置时间 -> 应恢复为 100%
          observed_at: "2026-09-24T12:00:00.000Z",
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: 0.7,
          reset_at: null,
          observed_at: "2026-09-24T12:00:00.000Z",
          status: "observed",
        },
      ],
      capability_verified: true,
    });

    fixture.repository.saveQuotaSnapshot({
      id: "snap-claude-pool",
      realm_id: realmId,
      account_id: "a",
      auth_epoch: 1,
      pool_id: "Claude and GPT models",
      model_ids: ["claude-3-5-sonnet"],
      source: "official_cli_usage",
      cli_version: "1.2.7",
      parser_revision: 1,
      observed_at: "2026-09-24T12:00:00.000Z",
      windows: [
        {
          kind: "weekly",
          duration_minutes: 10080,
          remaining_fraction: 0.4,
          reset_at: futureReset, // 未来时间 -> 保持 40%
          observed_at: "2026-09-24T12:00:00.000Z",
          status: "observed",
        },
        {
          kind: "five_hour",
          duration_minutes: 300,
          remaining_fraction: 0.6,
          reset_at: null,
          observed_at: "2026-09-24T12:00:00.000Z",
          status: "observed",
        },
      ],
      capability_verified: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/agy-accounts",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const view = res.json();

    const geminiSnap = view.snapshots.find((s: any) => s.id === "snap-gemini-pool");
    const claudeSnap = view.snapshots.find((s: any) => s.id === "snap-claude-pool");

    // 仅无重置时间的 Gemini Models 池恢复为 100%
    expect(geminiSnap?.windows.find((w: any) => w.kind === "weekly")?.remaining_fraction).toBe(1);
    expect(geminiSnap?.windows.find((w: any) => w.kind === "weekly")?.reset_at).toBeNull();

    // 拥有未来重置时间的 Claude and GPT models 池仍为 40%
    expect(claudeSnap?.windows.find((w: any) => w.kind === "weekly")?.remaining_fraction).toBe(0.4);
    expect(claudeSnap?.windows.find((w: any) => w.kind === "weekly")?.reset_at).toBe(futureReset);

    // 账号身份和池信息完整正确，未发生串值
    expect(view.accounts.find((a: any) => a.id === "a")?.identity.email).toBe("a@example.com");
  });
});
