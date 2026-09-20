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
  await fixture.service.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
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
