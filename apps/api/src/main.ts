import { readMaintenanceMarker } from "../../../packages/installer/src/transaction.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordController } from "./controller-descriptor.js";
import { loadConfig } from "../../../packages/contracts/src/config.js";
import { Store } from "../../../packages/store/src/store.js";
import { Engine } from "../../../packages/core/src/engine.js";
import { WorkspaceObserver } from "../../../packages/runtime/src/workspace-observer.js";
import { LocalRuntime } from "../../../packages/runtime/src/runtime.js";
import { resumeModelWaits, reconcileInactiveRuns } from "../../../packages/runtime/src/recovery.js";
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
let maintenanceBlocked = false;

const onMaintenancePrepare = (body: {
  transaction_id?: string;
  target_version?: string;
}) => {
  maintenanceBlocked = true;
  engine.maintenanceBlocked = true;
};

const onMaintenanceQuiesce = async (mode: "wait" | "pause-and-update") => {
  maintenanceBlocked = true;
  engine.maintenanceBlocked = true;
  if (mode === "pause-and-update") {
    for (const id of engine.getActiveWorkflowIds()) {
      try {
        await engine.stop(id, "controller");
      } catch {
        /* best effort */
      }
    }
    await runtime.processes.close().catch(() => undefined);
  } else {
    const deadline = Date.now() + 60000;
    while (engine.hasActiveRuns() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

const app = await buildServer(engine, {
  accountService,
  developmentFrontendOrigin,
  onMaintenancePrepare,
  onMaintenanceQuiesce,
  onMaintenanceShutdown: () => close(),
});
let workspaceObserver: WorkspaceObserver | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let maintenance: ReturnType<typeof setInterval> | undefined;
let closing: Promise<void> | undefined;
function close(): Promise<void> {
  return closing ??= (async () => {
    accountService.beginShutdown();
    workspaceObserver?.close();
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
  })();
}
process.once("SIGINT", () => void close().catch(console.error));
process.once("SIGTERM", () => void close().catch(console.error));
try {
  // Persist ownership and initialize shutdown before health can report success.
  recordController(config.storage_root, fileURLToPath(import.meta.url), "full");
  await app.listen({ host: config.server.host, port: config.server.port });
  await accountService.reconcileStartup();
  if (!closing) {
    // Bind first: a duplicate controller must fail before mutating persisted runs.
    reconcileInactiveRuns(engine);
    engine.recover();
    workspaceObserver = new WorkspaceObserver(engine);
    console.log(`DevFlow ${config.server.human_origin}`);
    tick = setInterval(() => {
      maintenanceBlocked = !!readMaintenanceMarker(config.storage_root)?.block_new_dispatch;
      engine.maintenanceBlocked = maintenanceBlocked;
      if (maintenanceBlocked) return;
      void engine.dispatch().catch((e) => console.error("调度失败", String(e)));
      void resumeModelWaits(engine).catch((e) =>
        console.error("额度恢复调度失败", String(e)),
      );
      void accountService
        .tick(Date.now())
        .catch((e) => console.error("账号调度tick失败", String(e)));
    }, 5000);
    maintenance = setInterval(() => {
      maintenanceBlocked = !!readMaintenanceMarker(config.storage_root)?.block_new_dispatch;
      engine.maintenanceBlocked = maintenanceBlocked;
      if (maintenanceBlocked) return;
      try {
        archiveLogs(engine);
      } catch (e) {
        console.error("日志归档失败", String(e));
      }
    }, 86400000);
  }
} catch (error) {
  await close();
  throw error;
}
