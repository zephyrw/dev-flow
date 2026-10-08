import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/store/src/store.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";

const realmId = "default-agy-realm";
const identity = { realm_id: realmId, account_id: "a" };
let root: string, store: Store, fixture: ReturnType<typeof accountFixture>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "devflow-model-account-fence-"));
  store = new Store(join(root, "store.sqlite"));
  fixture = accountFixture(store);
  fixture.seedAccounts();
  await fixture.service.start({ realmId, requestId: "start" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.service.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("accepts refreshed credentials only after confirming the same authenticated account", async () => {
  const compare = fixture.authHost.compareActive.bind(fixture.authHost);
  const oldRef = fixture.repository.getRealm(realmId)!.active_secret_ref;
  vi.spyOn(fixture.authHost, "compareActive").mockImplementation(async (realm, ref) =>
    ref === oldRef ? false : compare(realm, ref));
  const epoch = fixture.repository.getRealm(realmId)!.auth_epoch;
  const verify = vi.fn(async () => "verified");
  await expect(fixture.service.withModelVerification(identity, verify)).resolves.toBe("verified");
  expect(verify).toHaveBeenCalledOnce();
  expect(fixture.repository.getRealm(realmId)!.auth_epoch).toBe(epoch);
  expect(fixture.repository.getRealm(realmId)!.active_secret_ref).not.toBe(oldRef);
});

it("allows a read-only model probe alongside an external CLI on the same account", async () => {
  fixture.setExternal([{ pid: 42, exe_path: "agy.exe" }]);
  const stop = vi.spyOn(fixture.processHost, "stopProcess");
  const activate = vi.spyOn(fixture.authHost, "activateSaved");
  await expect(fixture.service.withModelVerification(identity, async () => "verified")).resolves.toBe("verified");
  expect(stop).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
});

it("uses safe credential identity when official usage output has no email", async () => {
  const account = fixture.repository.getAccount(realmId, "a")!;
  const oldRef = fixture.repository.getRealm(realmId)!.active_secret_ref;
  const compare = fixture.authHost.compareActive.bind(fixture.authHost);
  vi.spyOn(fixture.authHost, "compareActive").mockImplementation(async (realm, ref) =>
    ref === oldRef ? false : compare(realm, ref));
  vi.spyOn(fixture.authHost, "inspectActive").mockResolvedValue({
    exists: true, auth: { email: account.identity.email },
  });
  const probe = vi.spyOn(fixture.probe, "probeIdentity").mockRejectedValue(new Error("usage has no email"));
  await expect(fixture.service.withModelVerification(identity, async () => "verified")).resolves.toBe("verified");
  expect(probe).not.toHaveBeenCalled();
});

it("rejects an external credential change before launching the read-only model probe", async () => {
  fixture.setExternal([{ pid: 42, exe_path: "agy.exe" }]);
  await fixture.authHost.activateSaved(realmId, "b", "saved-b");
  const verify = vi.fn(async () => "verified");
  await expect(fixture.service.withModelVerification(identity, verify))
    .rejects.toMatchObject({ code: "external_change" });
  expect(verify).not.toHaveBeenCalled();
});

it("can verify after an external-owner block without relaxing other blocked states", async () => {
  const realm = fixture.repository.getRealm(realmId)!;
  fixture.repository.saveRealm({ ...realm, phase: "blocked", last_error: "external_owner" });
  await expect(fixture.service.withModelVerification(identity, async () => "verified")).resolves.toBe("verified");
  fixture.repository.saveRealm({ ...realm, phase: "blocked", last_error: "rollback_verification_failed" });
  const verify = vi.fn(async () => true);
  await expect(fixture.service.withModelVerification(identity, verify))
    .rejects.toMatchObject({ code: "model_verification_environment_unavailable" });
  expect(verify).not.toHaveBeenCalled();
});

it("allows unrelated realm updates during a probe without overwriting them", async () => {
  await expect(fixture.service.withModelVerification(identity, async () => {
    const realm = fixture.repository.getRealm(realmId)!;
    fixture.repository.saveRealm({ ...realm, revision: realm.revision + 1, last_capture_at: "2026-10-08T00:00:00Z" });
    return "verified";
  })).resolves.toBe("verified");
  expect(fixture.repository.getRealm(realmId)!.last_capture_at).toBe("2026-10-08T00:00:00Z");
});

it.each([false, true])("binds quota-only CLI output to credential identity, changed=%s", async (changed) => {
  for (const snapshot of fixture.repository.listQuotaSnapshots(realmId).filter(s => s.account_id === "a")) {
    fixture.repository.saveQuotaSnapshot({ ...snapshot, windows: snapshot.windows.map(w => ({
      ...w, reset_at: new Date(Date.now() - 120_000).toISOString(),
    })) });
  }
  const usage = fixture.probe.probeUsage.bind(fixture.probe);
  vi.spyOn(fixture.probe, "probeUsage").mockImplementation(async () => ({ ...await usage(), email: undefined }));
  vi.spyOn(fixture.authHost, "inspectActive")
    .mockResolvedValueOnce({ exists: true, auth: { email: "a@example.com" } })
    .mockResolvedValue({ exists: true, auth: { email: changed ? "b@example.com" : "a@example.com" } });
  const permit = fixture.service.acquireUsagePermit({
    realm_id: realmId, consumer_id: "quota-only-run", usage_kind: "execution",
    required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"],
  });
  if (changed) await expect(permit).rejects.toThrow("active_account_unavailable");
  else await expect(permit).resolves.toMatchObject({ account_id: "a" });
});

it("runs the exact caller probe without adding an account model probe", async () => {
  const count = fixture.probeCalls();
  const output = { model: "exact-variant", reasoning: "high", success: true };
  const verify = vi.fn(async () => output);
  expect(await fixture.service.withModelVerification(identity, verify)).toBe(
    output,
  );
  expect(verify).toHaveBeenCalledTimes(1);
  expect(fixture.probeCalls()).toBe(count);
});

it("rejects a queued request for another account before starting its probe", async () => {
  const verify = vi.fn(async () => true);
  await expect(
    fixture.service.withModelVerification(
      { ...identity, account_id: "b" },
      verify,
    ),
  ).rejects.toMatchObject({ code: "model_verification_account_changed" });
  expect(verify).not.toHaveBeenCalled();
});

it("does not publish a probe result after the account epoch changes", async () => {
  await expect(
    fixture.service.withModelVerification(identity, async () => {
      const realm = fixture.repository.getRealm(realmId)!;
      fixture.repository.saveRealm({
        ...realm,
        auth_epoch: realm.auth_epoch + 1,
      });
      return true;
    }),
  ).rejects.toMatchObject({ code: "model_verification_account_changed" });
});

it("rejects a stale queued epoch before launching a probe", async () => {
  const verify = vi.fn(async () => true);
  const realm = fixture.repository.getRealm(realmId)!;
  await expect(fixture.service.withModelVerification(
    { ...identity, auth_epoch: realm.auth_epoch - 1 }, verify,
  )).rejects.toMatchObject({ code: "model_verification_account_changed" });
  expect(verify).not.toHaveBeenCalled();
});

it("does not publish a probe result after an external credential change", async () => {
  await expect(
    fixture.service.withModelVerification(identity, async () => {
      await fixture.authHost.activateSaved(realmId, "b", "saved-b");
      return true;
    }),
  ).rejects.toMatchObject({ code: "external_change" });
});

it("releases the coordinator after a failed probe so the next request can proceed", async () => {
  await expect(
    fixture.service.withModelVerification(identity, async () => {
      throw new Error("probe failed");
    }),
  ).rejects.toThrow("probe failed");
  await expect(
    fixture.service.withModelVerification(identity, async () => "verified"),
  ).resolves.toBe("verified");
});
