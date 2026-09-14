import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const nodeCmd = process.execPath;
const require = createRequire(import.meta.url);
const packageFile = (name, path) =>
  resolve(dirname(require.resolve(`${name}/package.json`)), path);

const port = process.env.DEVFLOW_PORT;
const dataDir = process.env.DEVFLOW_DATA_DIR;
const identity = process.env.DEVFLOW_IDENTITY;

if (!port || !dataDir || !identity) {
  console.error(
    "缺少必需的隔离环境变量: DEVFLOW_PORT, DEVFLOW_DATA_DIR, DEVFLOW_IDENTITY",
  );
  process.exit(1);
}

const parsedPort = Number(port);
if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
  console.error("无效的端口号 DEVFLOW_PORT:", port);
  process.exit(1);
}

const distApi = resolve(root, "dist/apps/api/src/server.js");
const distWeb = resolve(root, "dist/web/index.html");

if (!existsSync(distApi) || !existsSync(distWeb)) {
  const r1 = spawnSync(
    nodeCmd,
    [
      packageFile("typescript", "bin/tsc"),
      "-p",
      "tsconfig.build.json",
      "--noEmitOnError",
    ],
    {
      cwd: root,
      stdio: "inherit",
      shell: false,
    },
  );
  if (r1.status !== 0) {
    console.error("构建失败(tsc)");
    process.exit(r1.status ?? 1);
  }
  const r2 = spawnSync(
    nodeCmd,
    [
      packageFile("vite", "bin/vite.js"),
      "build",
      "--config",
      "apps/web/vite.config.ts",
    ],
    {
      cwd: root,
      stdio: "inherit",
      shell: false,
    },
  );
  if (r2.status !== 0) {
    console.error("构建失败(vite)");
    process.exit(r2.status ?? 1);
  }
}

mkdirSync(dataDir, { recursive: true });

const { ConfigSchema } = await import(
  pathToFileURL(resolve(root, "dist/packages/contracts/src/config.js")).href
);
const { Store } = await import(
  pathToFileURL(resolve(root, "dist/packages/store/src/store.js")).href
);
const { Engine } = await import(
  pathToFileURL(resolve(root, "dist/packages/core/src/engine.js")).href
);
const { LocalRuntime } = await import(
  pathToFileURL(resolve(root, "dist/packages/runtime/src/runtime.js")).href
);
const { buildServer } = await import(
  pathToFileURL(resolve(root, "dist/apps/api/src/server.js")).href
);

const config = ConfigSchema.parse({
  storage_root: dataDir,
  workspace_root: join(dataDir, "worktrees"),
  server: {
    host: "127.0.0.1",
    port: parsedPort,
    human_origin: `http://127.0.0.1:${parsedPort}`,
  },
  host: { required: false },
});

const store = new Store(join(dataDir, "devflow.sqlite"));
const engine = new Engine(store, config);
engine.runtime = new LocalRuntime(engine);

const app = await buildServer(engine);

app.addHook("onRequest", async (req, reply) => {
  reply.header("x-devflow-identity", identity);
});
app.addHook("preHandler", async (req, reply) => {
  reply.header("x-devflow-identity", identity);
});
app.addHook("onSend", async (req, reply, payload) => {
  reply.header("x-devflow-identity", identity);
  return payload;
});

await app.listen({ host: "127.0.0.1", port: parsedPort });
console.log(
  `DevFlow Stage Preview running on http://127.0.0.1:${parsedPort} (identity: ${identity})`,
);

const close = async () => {
  try {
    await engine.runtime?.close();
    for (const socket of app.websocketServer?.clients || []) {
      socket.terminate();
    }
    await app.close();
    store.close();
  } catch (err) {
    console.error("关闭预览服务异常", err);
  }
  process.exit(0);
};

process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
