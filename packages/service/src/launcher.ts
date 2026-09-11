import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../contracts/src/config.js";
import { Store } from "../../store/src/store.js";
import { Auth } from "../../core/src/auth.js";
import { atomicWrite, hash } from "../../core/src/util.js";

// Resolve the installation, never the business repository that invoked Codex.
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const installation = resolve(moduleDirectory, "../../../..");
const configurationFile = process.env.DEVFLOW_CONFIG ?? join(installation, "devflow.yaml");
export const configuration = loadConfig(configurationFile);
export const instanceId = hash(resolve(configuration.storage_root).toLowerCase());
const tokenFile = join(configuration.storage_root, "codex-planner-token.txt");
const endpoint = `http://127.0.0.1:${configuration.server.port}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

async function running() {
  let response: Response;
  try { response = await fetch(endpoint + "/api/health", { signal: AbortSignal.timeout(1200), redirect: "error" }); }
  catch { return false; }
  let status: any;
  try { status = await response.json(); } catch { /* Fail closed on an occupied port. */ }
  if (!response.ok || status?.service !== "devflow" || status?.instance !== instanceId)
    throw new Error("DevFlow 端口已被其他程序或旧版本服务占用。请先关闭本安装的旧服务；不会终止无关进程。");
  return true;
}

export async function ensureService() {
  assertNotUpdating();
  mkdirSync(configuration.storage_root, { recursive: true });
  const lockFile = join(configuration.storage_root, "startup-lock.json");
  const owner = crypto.randomUUID();
  let acquired = false;
  for (let i = 0; i < 45; i++) {
    assertNotUpdating();
    if (await running()) return { endpoint, origin: configuration.server.human_origin };
    try {
      const fd = openSync(lockFile, "wx");
      try { writeFileSync(fd, JSON.stringify({ owner, expires: Date.now() + 60000 })); }
      finally { closeSync(fd); }
      acquired = true;
      break;
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      try {
        const previous = JSON.parse(readFileSync(lockFile, "utf8"));
        if (previous.expires < Date.now()) rmSync(lockFile);
      } catch {
        // A crashed writer can leave an empty file; it must not block every future start.
        try { if (Date.now() - statSync(lockFile).mtimeMs > 60000) rmSync(lockFile); } catch {}
      }
      await pause(1000);
    }
  }
  if (!acquired) throw new Error("DevFlow 正在启动，稍后重新打开即可。启动日志在 .devflow/controller.stderr.log。");
  try {
    if (await running()) return { endpoint, origin: configuration.server.human_origin };
    const entry = join(installation, "dist/apps/api/src/main.js");
    if (!existsSync(entry) || !existsSync(configuration.host.executable))
      throw new Error("安装尚未完成，请双击“安装或更新 DevFlow.cmd”。");
    const output = openSync(join(configuration.storage_root, "controller.stdout.log"), "a");
    const errors = openSync(join(configuration.storage_root, "controller.stderr.log"), "a");
    try {
      assertNotUpdating();
      const child = spawn(process.execPath, [entry], {
        cwd: installation, detached: true, windowsHide: true,
        stdio: ["ignore", output, errors],
        env: { ...process.env, DEVFLOW_CONFIG: configurationFile },
      });
      await new Promise<void>((yes, no) => { child.once("spawn", yes); child.once("error", no); });
      child.unref();
    } finally { closeSync(output); closeSync(errors); }
    for (let i = 0; i < 30; i++) {
      if (await running()) return { endpoint, origin: configuration.server.human_origin };
      await pause(1000);
    }
    throw new Error("DevFlow 未能启动，请打开 .devflow/controller.stderr.log 查看具体错误。");
  } finally {
    try { if (JSON.parse(readFileSync(lockFile, "utf8")).owner === owner) rmSync(lockFile); } catch {}
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
        try { auth.verify(token, "planner"); return token; } catch {}
      }
      const token = auth.issue({ role: "planner" }, 365 * 86400000);
      atomicWrite(tokenFile, token);
      return token;
    });
  } finally { store.close(); }
}

export function browserUrl() {
  return configuration.server.human_origin;
}

export async function openBrowser() {
  await ensureService();
  const url = browserUrl();
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
    "Start-Process -FilePath $env:DEVFLOW_OPEN_URL"], {
    env: { ...process.env, DEVFLOW_OPEN_URL: url }, stdio: "ignore", windowsHide: true,
  });
  await new Promise<void>((yes, no) => {
    child.once("error", no);
    child.once("exit", code => code === 0 ? yes() : no(new Error("无法打开默认浏览器")));
  });
}
