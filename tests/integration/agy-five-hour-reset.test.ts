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
    fixture.repository.saveQuotaSnapshot({ ...snap, id: "expired-b", observed_at: new Date().toISOString(),
      windows: snap.windows.map(window => ({ ...window,
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

  it("API retains an elapsed zero observation and requires verification without changing identity", async () => {
    const app = buildAccountsServer(fixture.service, { port: 14951, humanOrigin: "http://127.0.0.1:14951", storageInstance: root });
    try {
      const response = await app.inject({ method: "GET", url: "/api/agy-accounts", headers: { host: "127.0.0.1:14951", origin: "http://127.0.0.1:14951", "sec-fetch-site": "same-origin" } });
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(view.accounts.find((account: { id: string }) => account.id === "b").state).toBe("pending_quota");
      expect(view.snapshots.find((snap: { account_id: string }) => snap.account_id === "b").windows[1].remaining_fraction).toBe(0);
      expect(fixture.repository.getAccount("default-agy-realm", "b")!.state).toBe("waiting_quota");
      expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "b")[0]!.windows[1]!.remaining_fraction).toBe(0);
      expect(fixture.active()).toBe("a");
    } finally { await app.close(); }
  });

  it("refreshes only the active account and retains an inactive account's expired observation", async () => {
    const original = fixture.probe.probeUsage;
    fixture.probe.probeUsage = async options => {
      if (fixture.active() === "b") throw new Error("official_usage_probe_failed");
      return original(options);
    };
    const view = await fixture.service.syncAndRefreshQuotas();
    expect(view.refresh_scope).toBe("active_only");
    expect(view.refresh_errors).toEqual([]);
    expect(view.accounts.find(account => account.id === "b")!.state).toBe("pending_quota");
    expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "b")[0]!.id).toBe("expired-b");
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
