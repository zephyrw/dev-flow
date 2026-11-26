import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { buildAccountsServer } from "../../apps/api/src/accounts-server.js";

describe("persisted five-hour reset and failed refresh", () => {
  let root: string;
  let store: Store;
  let fixture: ReturnType<typeof accountFixture>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devflow-five-hour-reset-"));
    store = new Store(join(root, "test.sqlite"));
    fixture = accountFixture(store);
    fixture.seedAccounts();
    const account = fixture.repository.getAccount("default-agy-realm", "b")!;
    fixture.repository.saveAccount({ ...account, state: "waiting_quota" });
    const snap = fixture.repository.listQuotaSnapshots("default-agy-realm", "b")[0]!;
    fixture.repository.retainQuotaPools("default-agy-realm", "b", []);
    const observedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    fixture.repository.saveQuotaSnapshot({ ...snap, observed_at: observedAt,
      windows: snap.windows.map(window => ({ ...window,
        observed_at: observedAt,
        remaining_fraction: window.kind === "five_hour" ? 0 : 1,
        reset_at: window.kind === "five_hour" ? new Date(Date.now() - 3600_000).toISOString() : null,
      })),
    });
  });
  afterEach(async () => {
    await fixture.service.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("API retains the elapsed zero observation and projects the display state without changing identity", async () => {
    const app = buildAccountsServer(fixture.service, { port: 14951, humanOrigin: "http://127.0.0.1:14951", storageInstance: root });
    try {
      const response = await app.inject({ method: "GET", url: "/api/agy-accounts", headers: { host: "127.0.0.1:14951", origin: "http://127.0.0.1:14951", "sec-fetch-site": "same-origin" } });
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(view.accounts.find((account: { id: string }) => account.id === "b").state).toBe("ready");
      expect(view.snapshots.find((snap: { account_id: string }) => snap.account_id === "b").windows[1].remaining_fraction).toBe(0);
      expect(fixture.repository.getAccount("default-agy-realm", "b")!.state).toBe("waiting_quota");
      expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "b")[0]!.windows[1]!.remaining_fraction).toBe(0);
      expect(fixture.active()).toBe("a");
    } finally { await app.close(); }
  });

  it("refreshes only the active account and retains an inactive account's expired observation", async () => {
    const before = fixture.repository.listQuotaSnapshots("default-agy-realm", "b");
    const original = fixture.probe.probeUsage;
    fixture.probe.probeUsage = async options => {
      if (fixture.active() === "b") throw new Error("official_usage_probe_failed");
      return original(options);
    };
    const view = await fixture.service.syncAndRefreshQuotas();
    expect(view.refresh_scope).toBe("active_only");
    expect(view.refresh_errors).toEqual([]);
    expect(view.accounts.find(account => account.id === "b")!.state).toBe("ready");
    expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "b")).toEqual(before);
    expect(fixture.active()).toBe("a");
  });

  it("automatically samples an elapsed current-account window with switching disabled", async () => {
    const realmId = "default-agy-realm";
    await fixture.service.syncAndRefreshQuotas();
    const priorRefresh = fixture.service.getQuotaRefresh()!.id;
    const active = fixture.repository.getQuotaSnapshot(realmId, "a", "fixture-pool")!;
    const expired = fixture.repository.getQuotaSnapshot(realmId, "b", "fixture-pool")!;
    fixture.repository.saveQuotaSnapshot({ ...active, windows: expired.windows });
    await fixture.service.tick(Date.now());
    expect(fixture.service.getQuotaRefresh()?.id).not.toBe(priorRefresh);
    await fixture.service.syncAndRefreshQuotas();
    expect(fixture.service.getQuotaRefresh()?.status).toBe("succeeded");
    expect(fixture.repository.getQuotaSnapshot(realmId, "a", "fixture-pool")?.windows[1]?.remaining_fraction).toBe(0.7);
    expect(fixture.repository.getQuotaSnapshot(realmId, "b", "fixture-pool")).toEqual(expired);
    expect(fixture.active()).toBe("a");
  });

  it("reports an active refresh failure and preserves the last real observation", async () => {
    const before = fixture.repository.listQuotaSnapshots("default-agy-realm", "a");
    fixture.probe.probeUsage = async () => { throw new Error("official_usage_probe_failed"); };
    const view = await fixture.service.syncAndRefreshQuotas();
    expect(view.refresh_errors).toEqual([{ account_id: "a", error: "quota_probe_failed" }]);
    expect(fixture.service.getQuotaRefresh()?.status).toBe("failed");
    expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "a")).toEqual(before);
    expect(fixture.active()).toBe("a");
  });

  it.each(["probe_timeout", "network_error"])("recovers from %s within one active refresh", async reason => {
    const realmId = "default-agy-realm";
    const before = fixture.repository.getQuotaSnapshot(realmId, "a", "fixture-pool");
    const probe = fixture.probe.probeUsage;
    let attempts = 0;
    fixture.probe.probeUsage = async options => {
      expect(fixture.service.getQuotaRefresh()?.status).toBe("running");
      if (++attempts === 1) throw new Error(reason);
      return probe(options);
    };
    const refresh = fixture.service.requestQuotaRefresh(realmId, true);
    expect(refresh?.status).toBe("running");
    const view = await fixture.service.syncAndRefreshQuotas(realmId);
    expect(attempts).toBe(2);
    expect(view.refresh_errors).toEqual([]);
    expect(fixture.service.getQuotaRefresh()).toMatchObject({ id: refresh && "id" in refresh ? refresh.id : undefined, status: "succeeded" });
    expect(fixture.repository.getQuotaSnapshot(realmId, "a", "fixture-pool")?.id).not.toBe(before?.id);
    expect(fixture.repository.listAudits(realmId, 1)[0]).toMatchObject({
      action: "quota_refresh_attempt_failed", account_id: "a", details: { attempt: 1, reason },
    });
  });

  it("stops after the second transient failure and retains the last observation", async () => {
    const realmId = "default-agy-realm";
    const before = fixture.repository.listQuotaSnapshots(realmId, "a");
    let attempts = 0;
    fixture.probe.probeUsage = async () => { attempts++; throw new Error("network_error"); };
    const view = await fixture.service.syncAndRefreshQuotas(realmId);
    expect(attempts).toBe(2);
    expect(view.refresh_errors).toEqual([{ account_id: "a", error: "network_error" }]);
    expect(fixture.service.getQuotaRefresh()?.status).toBe("failed");
    expect(fixture.repository.listQuotaSnapshots(realmId, "a")).toEqual(before);
  });

  it("does not retry under another desktop login or replace the previous quota", async () => {
    const realmId = "default-agy-realm";
    const before = fixture.repository.listQuotaSnapshots(realmId, "a");
    let attempts = 0;
    fixture.probe.probeUsage = async () => {
      attempts++;
      await fixture.authHost.activateSaved(realmId, "b", "saved-b");
      throw new Error("probe_timeout");
    };
    await fixture.service.syncAndRefreshQuotas(realmId);
    expect(attempts).toBe(1);
    expect(fixture.service.getQuotaRefresh()?.status).toBe("failed");
    expect(fixture.repository.listQuotaSnapshots(realmId, "a")).toEqual(before);
    expect(fixture.active()).toBe("b");
  });

  it("omits historical Argon quota from account presentation", () => {
    const realmId = "default-agy-realm";
    const current = fixture.repository.getQuotaSnapshot(realmId, "a", "fixture-pool")!;
    const argon = { ...current, id: "legacy-argon", pool_id: "Gemini 4 Argon",
      windows: [{ ...current.windows[0]!, remaining_fraction: 0 }] };
    fixture.repository.saveQuotaSnapshot(argon);
    const view = fixture.service.getPresentation(realmId);
    expect(view.snapshots).not.toContainEqual(argon);
    expect(view.accounts.find(account => account.id === "a")?.state).toBe("ready");
    expect(fixture.repository.getQuotaSnapshot(realmId, "a", argon.pool_id)).toEqual(argon);
  });

  it("records a revoked login and skips probing the same saved credential again", async () => {
    const realmId = "default-agy-realm";
    const before = fixture.repository.listQuotaSnapshots(realmId, "a");
    let probes = 0;
    fixture.probe.probeUsage = async () => {
      probes++;
      throw Object.assign(new Error("authentication_required"), { code: "authentication_required" });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const view = await fixture.service.syncAndRefreshQuotas(realmId);
      expect(view.refresh_errors).toEqual([{ account_id: "a", error: "authentication_required" }]);
    }
    expect(probes).toBe(1);
    expect(fixture.repository.getAccount(realmId, "a")).toMatchObject({
      state: "reauth_required", auth: { last_auth_error: "authentication_required", last_local_auth_failure_revision: 1 },
    });
    expect(fixture.repository.listQuotaSnapshots(realmId, "a")).toEqual(before);
  });

  it("can revalidate the current login after a historical authentication result", async () => {
    const realmId = "default-agy-realm";
    const account = fixture.repository.getAccount(realmId, "a")!;
    fixture.repository.saveAccount({ ...account, state: "reauth_required",
      auth: { ...account.auth, last_auth_error: "authentication_required" } });
    expect(fixture.service.getPresentation(realmId).accounts.find(a => a.id === "a")?.saved_credential_status)
      .toBe("unverified");
    const result = await fixture.service.syncAndRefreshQuotas(realmId);
    expect(result.refresh_errors).toEqual([]);
    expect(fixture.repository.getAccount(realmId, "a")?.state).toBe("ready");
  });
});
