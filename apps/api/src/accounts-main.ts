import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../../packages/store/src/store.js";
import { loadConfig } from "../../../packages/contracts/src/config.js";
import { acquireControllerLock } from "../../../packages/process/src/controller-lock.js";
import { recordController } from "../../../packages/service/src/descriptor.js";
import { bootstrapAccountService } from "./account-service-bootstrap.js";
import { buildAccountsServer } from "./accounts-server.js";
const config = loadConfig(process.env.DEVFLOW_CONFIG);
const unlock = await acquireControllerLock(config.storage_root);
const store = new Store(join(config.storage_root, "devflow.sqlite"));
const accountService = await bootstrapAccountService(store, {
  agyCliPath: config.models.agy_executable,
  settings: config.agy_accounts,
});
const app = buildAccountsServer(accountService, {
  port: config.server.port,
  humanOrigin: config.server.human_origin,
  storageInstance: config.storage_root,
});
try {
  await app.listen({ port: config.server.port, host: config.server.host });
  await accountService.reconcileStartup();
  recordController(
    config.storage_root,
    fileURLToPath(import.meta.url),
    "accounts",
  );
} catch (error) {
  await accountService.close();
  await app.close();
  store.close();
  await unlock();
  throw error;
}
console.log(`DevFlow AGY Accounts ${config.server.human_origin}/accounts`);
const timer = setInterval(() => {
  void accountService
    .tick(Date.now())
    .catch(() => console.error("账号调度失败，请检查管理状态"));
}, 5000);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  // Retain ownership if safe credential/process shutdown fails.
  await accountService.close();
  await app.close();
  store.close();
  await unlock();
}
process.once("SIGINT", () => void close().catch(console.error));
process.once("SIGTERM", () => void close().catch(console.error));
