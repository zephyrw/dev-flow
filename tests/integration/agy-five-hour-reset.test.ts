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

  it("API derives ready/100% while preserving raw quota, account state and active identity", async () => {
    const app = buildAccountsServer(fixture.service, { port: 14951, humanOrigin: "http://127.0.0.1:14951", storageInstance: root });
    try {
      const response = await app.inject({ method: "GET", url: "/api/agy-accounts", headers: { host: "127.0.0.1:14951", origin: "http://127.0.0.1:14951", "sec-fetch-site": "same-origin" } });
      expect(response.statusCode).toBe(200);
      const view = response.json();
      expect(view.accounts.find((account: { id: string }) => account.id === "b").state).toBe("ready");
      expect(view.snapshots.find((snap: { account_id: string }) => snap.account_id === "b").windows[1].remaining_fraction).toBe(1);
      expect(fixture.repository.getAccount("default-agy-realm", "b")!.state).toBe("waiting_quota");
      expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "b")[0]!.windows[1]!.remaining_fraction).toBe(0);
      expect(fixture.active()).toBe("a");
    } finally { await app.close(); }
  });

  it("reports a failed account refresh without losing its raw observation or leaving the account active", async () => {
    const original = fixture.probe.probeUsage;
    fixture.probe.probeUsage = async options => {
      if (fixture.active() === "b") throw new Error("official_usage_probe_failed");
      return original(options);
    };
    const view = await fixture.service.syncAndRefreshQuotas();
    expect(view.refresh_errors).toEqual([{ account_id: "b" }]);
    expect(view.accounts.find(account => account.id === "b")!.state).toBe("ready");
    expect(fixture.repository.listQuotaSnapshots("default-agy-realm", "b")[0]!.id).toBe("expired-b");
    expect(fixture.active()).toBe("a");
  });
});
