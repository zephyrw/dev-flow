import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { buildAccountsServer } from "../../apps/api/src/accounts-server.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
const port = Number(process.env.DEVFLOW_ACCOUNTS_E2E_PORT ?? 14839);
const root = mkdtempSync(join(tmpdir(), "devflow-accounts-browser-"));
const store = new Store(join(root, "devflow.sqlite"));
const fixture = accountFixture(store, "gemini-3.8-flash");
fixture.seedAccounts();

const initialNow = Date.now();
const initialFutureReset = new Date(initialNow + 2 * 86400 * 1000).toISOString();
const initialNowIso = new Date(initialNow).toISOString();

let scenario = false;
const originalProbe = fixture.probe.probeUsage;
fixture.probe.probeUsage = async (...args) => {
  if (scenario) {
    const observed = await originalProbe(...args);
    const snapshot = fixture.repository.getQuotaSnapshot("default-agy-realm", fixture.active(), "Gemini Models");
    const other = fixture.repository.getQuotaSnapshot("default-agy-realm", fixture.active(), "Claude and GPT models");
    const now = new Date().toISOString();
    const windows = (snapshot?.windows ?? observed.windows).map(window => ({ ...window, observed_at: now }));
    return { ...observed, windows, pools: [
      { pool_id: "Gemini Models", model_ids: ["gemini-3.8-flash"], windows },
      ...(other ? [{ pool_id: other.pool_id, model_ids: other.model_ids, windows: other.windows.map(window => ({ ...window, observed_at: now })) }] : []),
    ] };
  }
  const curNow = Date.now();
  const curIso = new Date(curNow).toISOString();
  const curReset = new Date(curNow + 2 * 86400 * 1000).toISOString();
  return {
    email: `${fixture.active()}@example.com`,
    cli_version: "1.2.7",
    raw_output: "fixture usage: Gemini Models 90%, Claude and GPT models 80%",
    windows: [
      { kind: "weekly" as const, duration_minutes: 10080 as const, remaining_fraction: 0.9, reset_at: curReset, observed_at: curIso, status: "observed" as const },
      { kind: "five_hour" as const, duration_minutes: 300 as const, remaining_fraction: 0.85, reset_at: curReset, observed_at: curIso, status: "observed" as const },
    ],
    pools: [
      {
        pool_id: "Gemini Models",
        model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
        windows: [
          { kind: "weekly" as const, duration_minutes: 10080 as const, remaining_fraction: 0.9, reset_at: curReset, observed_at: curIso, status: "observed" as const },
          { kind: "five_hour" as const, duration_minutes: 300 as const, remaining_fraction: 0.85, reset_at: curReset, observed_at: curIso, status: "observed" as const },
        ],
      },
      {
        pool_id: "Claude and GPT models",
        model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
        windows: [
          { kind: "weekly" as const, duration_minutes: 10080 as const, remaining_fraction: 0.75, reset_at: curReset, observed_at: curIso, status: "observed" as const },
          { kind: "five_hour" as const, duration_minutes: 300 as const, remaining_fraction: 0.6, reset_at: curReset, observed_at: curIso, status: "observed" as const },
        ],
      },
    ],
    executable_fingerprint: "fixture",
    capability_verified: true,
  };
};

for (const id of ["a", "b", "c"]) {
  fixture.repository.saveQuotaSnapshot({
    id: `snap-gemini-${id}`,
    realm_id: "default-agy-realm",
    account_id: id,
    auth_epoch: 1,
    pool_id: "Gemini Models",
    model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
    source: "official_cli_usage",
    cli_version: "1.2.7",
    parser_revision: 1,
    capability_verified: true,
    executable_fingerprint: "fixture",
    observed_at: initialNowIso,
    windows: [
      { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.9, reset_at: initialFutureReset, observed_at: initialNowIso, status: "observed" },
      { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.85, reset_at: initialFutureReset, observed_at: initialNowIso, status: "observed" },
    ],
  });
  fixture.repository.saveQuotaSnapshot({
    id: `snap-claude-${id}`,
    realm_id: "default-agy-realm",
    account_id: id,
    auth_epoch: 1,
    pool_id: "Claude and GPT models",
    model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
    source: "official_cli_usage",
    cli_version: "1.2.7",
    parser_revision: 1,
    capability_verified: true,
    executable_fingerprint: "fixture",
    observed_at: initialNowIso,
    windows: [
      { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.75, reset_at: initialFutureReset, observed_at: initialNowIso, status: "observed" },
      { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.6, reset_at: initialFutureReset, observed_at: initialNowIso, status: "observed" },
    ],
  });
}


fixture.addSavedAccount("d");
const origin = `http://127.0.0.1:${port}`;
const app = buildAccountsServer(fixture.service, {
  port,
  humanOrigin: origin,
  storageInstance: root,
  webRoot: process.env.DEVFLOW_E2E_WEB_ROOT ?? "dist/web",
});
const timer = setInterval(
  () => void fixture.service.tick(Date.now()).catch(console.error),
  100,
);
app.get("/api/account-fixture/facts", async () => ({
  counts: {
    project: store.list("project").length,
    workflow: store.list("workflow").length,
    run: store.list("run").length,
  },
  active: fixture.active(),
  probe_calls: fixture.probeCalls(),
}));
app.route({
  method: ["GET", "POST"],
  url: "/api/account-fixture/setup-quota-scenarios",
  handler: async () => {
    scenario = true;
    const realmId = "default-agy-realm";
    const now = Date.now();
    const pastReset = new Date(now - 3600_000).toISOString();
    const futureReset = new Date(now + 2 * 86400 * 1000).toISOString();

    // 配置活动账号探测返回已重置周额度 (reset_at: null)
    fixture.setCustomWindows((activeId) => [
      {
        kind: "weekly" as const,
        duration_minutes: 10080 as const,
        remaining_fraction: activeId === "a" ? 0.6 : 0.69,
        reset_at: null,
        observed_at: new Date().toISOString(),
        status: "observed" as const,
      },
      {
        kind: "five_hour" as const,
        duration_minutes: 300 as const,
        remaining_fraction: 0.7,
        reset_at: futureReset,
        observed_at: new Date().toISOString(),
        status: "observed" as const,
      },
    ]);

    // 添加第四个账号 d 作为未来时间对照账号
    const nowIso = new Date(now).toISOString();
    fixture.repository.saveAccount({
      id: "d",
      realm_id: realmId,
      revision: 1,
      alias: "Account D",
      identity: { email: "d@example.com", verified_at: nowIso },
      secret_ref: "saved-d",
      credential_revision: 1,
      state: "ready",
      enrolled_at: nowIso,
      enrollment_completed_at: nowIso,
      auth: { has_refresh_credential: true, metadata_status: "verified", refresh_expiry_source: "not_provided" },
    });

    // 账号 a: 旧 60% 且 reset_at=null（已重置）
    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-a",
      realm_id: realmId,
      account_id: "a",
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: nowIso,
      windows: [
        { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.6, reset_at: null, observed_at: nowIso, status: "observed" },
        { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.7, reset_at: futureReset, observed_at: nowIso, status: "observed" },
      ],
    });

    // 账号 b: 旧 69% 且 reset_at=null（已重置）
    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-b",
      realm_id: realmId,
      account_id: "b",
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: nowIso,
      windows: [
        { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.69, reset_at: null, observed_at: nowIso, status: "observed" },
        { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.8, reset_at: futureReset, observed_at: nowIso, status: "observed" },
      ],
    });

    // 账号 c: 旧 0% 且 reset_at 已过期（到期重置）
    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-c",
      realm_id: realmId,
      account_id: "c",
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: nowIso,
      windows: [
        { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0, reset_at: pastReset, observed_at: nowIso, status: "observed" },
        { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.5, reset_at: futureReset, observed_at: nowIso, status: "observed" },
      ],
    });

    // 账号 d: 83% 且未来重置时间（对照组，未重置）
    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-d",
      realm_id: realmId,
      account_id: "d",
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: nowIso,
      windows: [
        { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.83, reset_at: futureReset, observed_at: nowIso, status: "observed" },
        { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.9, reset_at: futureReset, observed_at: nowIso, status: "observed" },
      ],
    });

    return { ok: true };
  },
});

app.route({
  method: ["GET", "POST"],
  url: "/api/account-fixture/setup-dual-quota-scenarios",
  handler: async () => {
    const realmId = "default-agy-realm";
    const now = Date.now();
    const futureReset = new Date(now + 2 * 86400 * 1000).toISOString();
    const nowIso = new Date(now).toISOString();

    for (const id of ["a", "b", "c", "d"]) {
      fixture.repository.saveQuotaSnapshot({
        id: `snap-gemini-${id}`,
        realm_id: realmId,
        account_id: id,
        auth_epoch: 1,
        pool_id: "Gemini Models",
        model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        capability_verified: true,
        executable_fingerprint: "fixture",
        observed_at: nowIso,
        windows: [
          { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.9, reset_at: futureReset, observed_at: nowIso, status: "observed" },
          { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.85, reset_at: futureReset, observed_at: nowIso, status: "observed" },
        ],
      });

      fixture.repository.saveQuotaSnapshot({
        id: `snap-claude-${id}`,
        realm_id: realmId,
        account_id: id,
        auth_epoch: 1,
        pool_id: "Claude and GPT models",
        model_ids: ["claude-opus-5-5", "claude-sonnet-5-5"],
        source: "official_cli_usage",
        cli_version: "1.2.7",
        parser_revision: 1,
        capability_verified: true,
        executable_fingerprint: "fixture",
        observed_at: nowIso,
        windows: [
          { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.75, reset_at: futureReset, observed_at: nowIso, status: "observed" },
          { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.6, reset_at: futureReset, observed_at: nowIso, status: "observed" },
        ],
      });
    }

    return { ok: true };
  },
});

app.route({
  method: ["GET", "POST"],
  url: "/api/account-fixture/set-reset-soon",
  handler: async (req: any) => {
    const realmId = "default-agy-realm";
    const now = Date.now();
    const delay = Number(req.query?.delayMs ?? 4000);
    const soonReset = new Date(now + delay).toISOString();
    const nowIso = new Date(now).toISOString();

    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-d",
      realm_id: realmId,
      account_id: "d",
      auth_epoch: 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: nowIso,
      windows: [
        { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.35, reset_at: soonReset, observed_at: nowIso, status: "observed" },
        { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.9, reset_at: soonReset, observed_at: nowIso, status: "observed" },
      ],
    });
    return { ok: true, soonReset };
  },
});

app.route({
  method: ["GET", "POST"],
  url: "/api/account-fixture/save-new-cycle",
  handler: async () => {
    const realmId = "default-agy-realm";
    const now = Date.now();
    const futureReset = new Date(now + 6 * 86400 * 1000).toISOString();
    const nowIso = new Date(now).toISOString();

    // 更新探测返回值为新周期
    fixture.setCustomWindows(() => [
      {
        kind: "weekly" as const,
        duration_minutes: 10080 as const,
        remaining_fraction: 0.45,
        reset_at: futureReset,
        observed_at: new Date().toISOString(),
        status: "observed" as const,
      },
      {
        kind: "five_hour" as const,
        duration_minutes: 300 as const,
        remaining_fraction: 0.88,
        reset_at: futureReset,
        observed_at: new Date().toISOString(),
        status: "observed" as const,
      },
    ]);

    // 账号 a 在新周期探测到 45% 额度与未来 6 天重置时间
    fixture.repository.saveQuotaSnapshot({
      id: "snapshot-a-new-cycle",
      realm_id: realmId,
      account_id: "a",
      auth_epoch: fixture.repository.getRealm(realmId)?.auth_epoch ?? 1,
      pool_id: "Gemini Models",
      model_ids: ["gemini-3.8-flash", "gemini-3.7-flash"],
      source: "official_cli_usage",
      cli_version: "2.0.0",
      parser_revision: 1,
      capability_verified: true,
      executable_fingerprint: "fixture-fingerprint",
      observed_at: nowIso,
      windows: [
        { kind: "weekly", duration_minutes: 10080, remaining_fraction: 0.45, reset_at: futureReset, observed_at: nowIso, status: "observed" },
        { kind: "five_hour", duration_minutes: 300, remaining_fraction: 0.88, reset_at: futureReset, observed_at: nowIso, status: "observed" },
      ],
    });
    return { ok: true };
  },
});
await app.listen({ host: "127.0.0.1", port });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await fixture.service.close();
  await app.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
