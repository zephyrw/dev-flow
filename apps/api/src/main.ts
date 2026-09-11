import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordController } from "../../../packages/service/src/descriptor.js";
import { loadConfig } from "../../../packages/contracts/src/config.js";
import { Store } from "../../../packages/store/src/store.js";
import { Engine } from "../../../packages/core/src/engine.js";
import { LocalRuntime } from "../../../packages/runtime/src/runtime.js";
import { buildServer } from "./server.js";
import { archiveLogs } from "../../../packages/runtime/src/maintenance.js";
import { acquireControllerLock } from "../../../packages/process/src/controller-lock.js";
const config = loadConfig(process.env.DEVFLOW_CONFIG);
const unlock = await acquireControllerLock(
  config.host.executable,
  config.storage_root,
);
const store = new Store(join(config.storage_root, "devflow.sqlite"));
const engine = new Engine(store, config);
engine.runtime = new LocalRuntime(engine);
const app = await buildServer(engine);
try {
  await app.listen({ host: config.server.host, port: config.server.port });
} catch (e) {
  store.close();
  await unlock();
  throw e;
}
// Bind first: a duplicate controller must fail before mutating persisted runs.
engine.recover();
recordController(config.storage_root, fileURLToPath(import.meta.url));
console.log(`DevFlow ${config.server.human_origin}`);
const tick = setInterval(() => {
  for (const job of store.jobs()) {
    if (job.kind === "dispatch") {
      const w = engine.get(job.workflow_id);
      if (
        ["QUEUED", "REVIEW_QUEUED"].includes(w.state) &&
        !store.get("queue", w.id)
      )
        engine.scheduler.enqueue(w.id, w.project_id);
      store.jobStatus(job.id, "delivered");
    }
  }
  void engine.dispatch().catch((e) => console.error("调度失败", String(e)));
}, 5000);
const maintenance = setInterval(() => {
  try {
    archiveLogs(engine);
  } catch (e) {
    console.error("日志归档失败", String(e));
  }
}, 86400000);
const close = async () => {
  clearInterval(tick);
  clearInterval(maintenance);
  await engine.runtime!.close();
  for (const socket of app.websocketServer.clients) socket.terminate();
  await app.close();
  store.close();
  await unlock();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
