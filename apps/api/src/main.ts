import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordController } from "../../../packages/service/src/descriptor.js";
import { loadConfig } from "../../../packages/contracts/src/config.js";
import { Store } from "../../../packages/store/src/store.js";
import { Engine } from "../../../packages/core/src/engine.js";
import { WorkspaceObserver } from "../../../packages/runtime/src/workspace-observer.js";
import { LocalRuntime } from "../../../packages/runtime/src/runtime.js";
import { resumeModelWaits } from "../../../packages/runtime/src/recovery.js";
import { buildServer } from "./server.js";
import { archiveLogs } from "../../../packages/runtime/src/maintenance.js";
import { acquireControllerLock } from "../../../packages/process/src/controller-lock.js";
process.on("uncaughtException", (err) => {
  console.error("[CRITICAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL] Unhandled rejection:", reason);
});
const config = loadConfig(process.env.DEVFLOW_CONFIG);
const unlock = await acquireControllerLock(config.storage_root);
import { bootstrapAccountService } from "./account-service-bootstrap.js";

const store = new Store(join(config.storage_root, "devflow.sqlite"));
const engine = new Engine(store, config);
const runtime = new LocalRuntime(engine);
engine.runtime = runtime;

const accountService = await bootstrapAccountService(store, {
  agyCliPath: config.models.agy_executable,
  processManager: runtime.processes,
  settings: config.agy_accounts,
});
const bridge = runtime.attachAccountService(accountService);

const developmentFrontendOrigin = process.env.DEVFLOW_DEV_FRONTEND_ORIGIN;
const app = await buildServer(engine, {
  accountService,
  developmentFrontendOrigin,
});
try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (e) {
  store.close();
  await unlock();
  throw e;
}
await accountService.reconcileStartup();
// Bind first: a duplicate controller must fail before mutating persisted runs.
engine.recover();
const workspaceObserver = new WorkspaceObserver(engine);
recordController(config.storage_root, fileURLToPath(import.meta.url), "full");
console.log(`DevFlow ${config.server.human_origin}`);
const tick = setInterval(() => {
  void engine.dispatch().catch((e) => console.error("调度失败", String(e)));
  void resumeModelWaits(engine).catch((e) =>
    console.error("额度恢复调度失败", String(e)),
  );
  void accountService
    .tick(Date.now())
    .catch((e) => console.error("账号调度tick失败", String(e)));
}, 5000);
const maintenance = setInterval(() => {
  try {
    archiveLogs(engine);
  } catch (e) {
    console.error("日志归档失败", String(e));
  }
}, 86400000);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  accountService.beginShutdown();
  workspaceObserver.close();
  clearInterval(tick);
  clearInterval(maintenance);
  await engine.runtime!.close();
  bridge.dispose();
  for (const socket of app.websocketServer.clients) socket.terminate();
  // Cancel model probes before waiting for the account coordinator to drain.
  await app.close();
  await accountService.close();
  store.close();
  await unlock();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
