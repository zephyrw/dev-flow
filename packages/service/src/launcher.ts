import { assertServiceMode } from "./service-mode.js";
export { assertServiceMode } from "./service-mode.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../contracts/src/config.js";
import { Store } from "../../store/src/store.js";
import { Auth } from "../../core/src/auth.js";
import { atomicWrite, hash } from "../../core/src/util.js";
import { cleanProcessEnvironment } from "../../process/src/manager.js";

// Resolve the installation, never the business repository that invoked Codex.
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const installation = resolve(moduleDirectory, "../../../..");
const configurationFile =
  process.env.DEVFLOW_CONFIG ?? join(installation, "devflow.yaml");
export const configuration = loadConfig(configurationFile);
export const instanceId = hash(
  resolve(configuration.storage_root).toLowerCase(),
);
const tokenFile = join(configuration.storage_root, "codex-planner-token.txt");
const endpoint = `http://127.0.0.1:${configuration.server.port}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function assertNotUpdating() {
  const path = join(configuration.storage_root, "maintenance.lock");
  if (!existsSync(path)) return;
  try {
    // The installer holds FileShare.None. An openable marker is left by a crash.
    const fd = openSync(path, "r+");
    closeSync(fd);
    rmSync(path);
  } catch (error: any) {
    if (error.code === "ENOENT") return;
    throw new Error("DevFlow 正在更新，请等安装窗口完成后再打开任务。");
  }
}

async function running(mode: "full" | "accounts") {
  let response: Response;
  try {
    response = await fetch(endpoint + "/api/health", {
      signal: AbortSignal.timeout(1200),
      redirect: "error",
    });
  } catch {
    return false;
  }
  let status: any;
  try {
    status = await response.json();
  } catch {
    /* Fail closed on an occupied port. */
  }
  if (
    !response.ok ||
    status?.service !== "devflow" ||
    status?.instance !== instanceId
  )
    throw new Error(
      "DevFlow 端口已被其他程序或旧版本服务占用。请先关闭本安装的旧服务；不会终止无关进程。",
    );
  assertServiceMode(status, mode);
  const canonical = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (
    status.runtime_backend !== "node-v1" ||
    typeof status.runtime_root !== "string" ||
    canonical(status.runtime_root) !== canonical(installation)
  )
    throw new Error(
      "本端口运行的是另一版本安装，请先停止旧服务再启动当前版本。",
    );
  return true;
}

export async function ensureService(mode: "full" | "accounts" = "full") {
  assertNotUpdating();
  mkdirSync(configuration.storage_root, { recursive: true });
  const lockFile = join(configuration.storage_root, "startup-lock.json");
  const owner = crypto.randomUUID();
  let acquired = false;
  for (let i = 0; i < 45; i++) {
    assertNotUpdating();
    if (await running(mode))
      return { endpoint, origin: configuration.server.human_origin };
    try {
      const fd = openSync(lockFile, "wx");
      try {
        writeFileSync(
          fd,
          JSON.stringify({ owner, expires: Date.now() + 180000 }),
        );
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      try {
        const previous = JSON.parse(readFileSync(lockFile, "utf8"));
        if (previous.expires < Date.now()) rmSync(lockFile);
      } catch {
        // A crashed writer can leave an empty file; it must not block every future start.
        try {
          if (Date.now() - statSync(lockFile).mtimeMs > 180000)
            rmSync(lockFile);
        } catch {}
      }
      await pause(1000);
    }
  }
  if (!acquired)
    throw new Error(
      "DevFlow 正在启动，稍后重新打开即可。启动日志在 .devflow/controller.stderr.log。",
    );
  try {
    if (await running(mode))
      return { endpoint, origin: configuration.server.human_origin };
    const entry = join(
      installation,
      mode === "accounts"
        ? "dist/apps/api/src/accounts-main.js"
        : "dist/apps/api/src/main.js",
    );
    // R09 修复：不再检查 host.executable（已移除）
    // 检查入口文件和 credential-worker 是否存在
    const credentialWorker = join(
      installation,
      "dist/packages/agy-accounts/src/credential-worker.js",
    );
    if (!existsSync(entry))
      throw new Error('安装尚未完成，请双击"安装或更新 DevFlow.cmd"。');
    if (process.platform === "win32" && !existsSync(credentialWorker))
      throw new Error("凭据 Worker 不存在，请重新安装。");
    const output = openSync(
      join(configuration.storage_root, "controller.stdout.log"),
      "a",
    );
    const errors = openSync(
      join(configuration.storage_root, "controller.stderr.log"),
      "a",
    );
    try {
      assertNotUpdating();
      const child = spawn(process.execPath, [entry], {
        cwd: installation,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", output, errors],
        env: cleanProcessEnvironment({ DEVFLOW_CONFIG: configurationFile }),
      });
      await new Promise<void>((yes, no) => {
        child.once("spawn", yes);
        child.once("error", no);
      });
      child.unref();
    } finally {
      closeSync(output);
      closeSync(errors);
    }
    for (let i = 0; i < 90; i++) {
      if (await running(mode))
        return { endpoint, origin: configuration.server.human_origin };
      await pause(1000);
    }
    throw new Error(
      "DevFlow 未能启动，请打开 .devflow/controller.stderr.log 查看具体错误。",
    );
  } finally {
    try {
      if (JSON.parse(readFileSync(lockFile, "utf8")).owner === owner)
        rmSync(lockFile);
    } catch {}
  }
}

export function plannerToken() {
  // Token registration is serialized by SQLite; it never goes through model output.
  const store = new Store(join(configuration.storage_root, "devflow.sqlite"));
  try {
    return store.transaction(() => {
      const auth = new Auth(store, configuration.server.human_origin);
      if (existsSync(tokenFile)) {
        const token = readFileSync(tokenFile, "utf8").trim();
        try {
          auth.verify(token, "planner");
          return token;
        } catch {}
      }
      const token = auth.issue({ role: "planner" }, 365 * 86400000);
      atomicWrite(tokenFile, token);
      return token;
    });
  } finally {
    store.close();
  }
}

export function browserUrl() {
  return configuration.server.human_origin;
}

export async function openBrowser(mode: "full" | "accounts" = "full") {
  await ensureService(mode);
  const baseUrl = browserUrl();
  const url = mode === "accounts" ? `${baseUrl}/accounts` : baseUrl;
  const command =
    process.platform === "win32"
      ? "powershell.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-Command",
          "Start-Process -FilePath $env:DEVFLOW_OPEN_URL",
        ]
      : [url];
  const child = spawn(command, args, {
    env: { ...process.env, DEVFLOW_OPEN_URL: url },
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((yes, no) => {
    child.once("error", no);
    child.once("exit", (code) =>
      code === 0 ? yes() : no(new Error("无法打开默认浏览器")),
    );
  });
}
