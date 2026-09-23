import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { Store } from "../../packages/store/src/store.js";
import { buildAccountsServer } from "../../apps/api/src/accounts-server.js";
import { hash } from "../../packages/core/src/util.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";

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
    fixture = accountFixture(store);
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
          payload: { request_id: "edit", standalone_model_id: "fixture-model" },
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
      model_id: "fixture-model",
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
});

