import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { buildAccountsServer } from "../../apps/api/src/accounts-server.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
const port = Number(process.env.DEVFLOW_ACCOUNTS_E2E_PORT ?? 14839);
const root = mkdtempSync(join(tmpdir(), "devflow-accounts-browser-"));
const store = new Store(join(root, "devflow.sqlite"));
const fixture = accountFixture(store);
fixture.seedAccounts();
const settings = fixture.repository.getSettings("default-agy-realm")!;
fixture.service.updateSettings(
  "default-agy-realm",
  { standalone_model_id: null },
  settings.revision,
  "fixture-empty-model",
);
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
