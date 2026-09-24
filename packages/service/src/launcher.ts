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
  assertBuildIdentity(status);
  return true;
}

export interface ExpectedBuildIdentity {
  application_version?: string;
  build_revision?: string;
  service_protocol_version?: string;
}

let expectedBuildIdentity: ExpectedBuildIdentity = {};

export function setExpectedBuildIdentity(next: ExpectedBuildIdentity) {
  expectedBuildIdentity = { ...next };
}

export function readExpectedBuildIdentityFromInstall(
  installRoot: string,
): ExpectedBuildIdentity {
  const candidates = [
    join(installRoot, "build-info.json"),
    join(installRoot, "install-source.json"),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const identity: ExpectedBuildIdentity = {
        application_version: parsed.application_version ?? parsed.version,
        build_revision: parsed.build_revision,
        service_protocol_version: parsed.service_protocol_version,
      };
      if (
        identity.application_version ||
        identity.build_revision ||
        identity.service_protocol_version
      ) {
        return identity;
      }
    } catch {
      /* try next source */
    }
  }
  return {};
}

/**
 * Actual running build identity (not just the config pointer). Same version
 * directory with a different build is rejected via receipt/build digest.
 */
export function assertBuildIdentity(status: {
  application_version?: unknown;
  build_revision?: unknown;
  service_protocol_version?: unknown;
}): void {
  const expected =
    expectedBuildIdentity.application_version || expectedBuildIdentity.build_revision
      ? expectedBuildIdentity
      : readExpectedBuildIdentityFromInstall(installation);
  const liveVersion = status.application_version;
  const liveRevision = status.build_revision;
  const liveProtocol = status.service_protocol_version;

  if (expected.application_version && typeof liveVersion === "string") {
    if (liveVersion !== expected.application_version) {
      throw new Error(
        "运行中服务的构建版本与本安装不一致（" +
          liveVersion +
          " ≠ " +
          expected.application_version +
          "）。请停止旧服务后再打开。",
      );
    }
  }
  if (expected.build_revision && typeof liveRevision === "string") {
    if (liveRevision !== expected.build_revision) {
      throw new Error(
        "运行中服务的构建提交与本安装收据不一致，拒绝使用不明来源覆盖的服务。",
      );
    }
  }
  if (
    expected.service_protocol_version &&
    typeof liveProtocol === "string" &&
    liveProtocol !== expected.service_protocol_version
  ) {
    throw new Error("服务协议版本不匹配，请更新后重试。");
  }
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
      return {
        endpoint,
        origin: configuration.server.human_origin,
        port: configuration.server.port,
        bind: "127.0.0.1",
      };
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
      return {
        endpoint,
        origin: configuration.server.human_origin,
        port: configuration.server.port,
        bind: "127.0.0.1",
      };
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
        return {
          endpoint,
          origin: configuration.server.human_origin,
          port: configuration.server.port,
          bind: "127.0.0.1",
        };
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

export interface OpenBrowserResult {
  opened: boolean;
  url: string;
  message: string;
}

export async function openBrowser(
  mode: "full" | "accounts" = "full",
): Promise<OpenBrowserResult> {
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
  try {
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
    return {
      opened: true,
      url,
      message:
        "DevFlow 已安装，并已打开设置页面。选择你要使用的编程助手和模型，即可开始。",
    };
  } catch {
    // 降级：打印地址 + 两段成功文案，不把安装标成失败（I-12）。
    return {
      opened: false,
      url,
      message:
        "DevFlow 已安装。浏览器未能自动打开，请访问下方地址，或运行 `devflow` 再次打开。",
    };
  }
}
