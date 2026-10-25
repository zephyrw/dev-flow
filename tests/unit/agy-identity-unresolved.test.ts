import { expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { readManagedAgyModelIdentity } from "../../packages/core/src/model-identity.js";
import { runtimeFailureResolution } from "../../packages/contracts/src/runtime-failure.js";

it("an unresolved managed identity does not claim that a logged-in CLI needs reauthentication", async () => {
  const store = new Store(":memory:"), f = accountFixture(store);
  try {
    f.seedAccounts();
    await f.service.start({ realmId: "default-agy-realm", requestId: "start" });
    const realm = f.repository.getRealm("default-agy-realm")!;
    f.repository.saveRealm({ ...realm, active_account_id: null });
    expect(() => readManagedAgyModelIdentity(store)).toThrow(expect.objectContaining({ code: "AGY_ACCOUNT_IDENTITY_UNRESOLVED" }));
    expect(runtimeFailureResolution("AGY_ACCOUNT_IDENTITY_UNRESOLVED")?.title).toBe("AGY 账号身份待同步");
    await f.service.syncActiveAccountFromHost();
    expect(readManagedAgyModelIdentity(store)?.accountId).toBe("a");
    expect(runtimeFailureResolution("MODEL_LOGIN_REQUIRED")?.title).toBe("模型需要重新登录");
  } finally { await f.service.close(); store.close(); }
});
