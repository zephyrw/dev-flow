import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const root = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const cache = join(root, ".cache");
const dist = join(root, "dist");
const cli = join(dist, "packages/cli/src/main.js");
const configPath = resolve(root, process.env.DEVFLOW_CONFIG || "devflow.yaml");
const env = { ...process.env, DEVFLOW_CONFIG: configPath, DEVFLOW_VERSION_ROOT: root, DEVFLOW_INSTALL_ROOT: root };
const canonical = path => resolve(path).toLowerCase();
const importFile = path => import(pathToFileURL(path).href);
const readBuild = directory => JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8"));

function run(executable, args, childEnv = env) {
  const result = spawnSync(executable, args, { cwd: root, env: childEnv, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`命令执行失败（${result.status ?? result.signal}）：${args.join(" ")}`);
}

async function health(endpoint) {
  let response;
  try {
    response = await fetch(endpoint + "/api/health", {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED") return null;
    throw error;
  }
  const status = await response.json();
  if (!response.ok || !status.ok || status.service !== "devflow" ||
      typeof status.runtime_root !== "string" || canonical(status.runtime_root) !== canonical(root)) {
    throw new Error("端口上的服务不属于此工作区，无法切换。");
  }
  return status;
}

async function moveBuild(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt === 9 || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
      await wait(500);
    }
  }
}

async function startDist() {
  process.env.DEVFLOW_CONFIG = configPath;
  const { ensureService } = await importFile(join(dist, "packages/service/src/launcher.js"));
  return ensureService();
}

async function restart() {
  if (process.platform !== "win32") throw new Error("此入口仅支持 Windows。");
  if (!existsSync(configPath)) throw new Error(`找不到 ${configPath}，请先配置本地 DevFlow。`);
  process.chdir(root);
  mkdirSync(cache, { recursive: true });
  if (canonical(realpathSync(cache)) !== canonical(cache)) throw new Error(".cache 必须位于当前工作区。");
  const lock = join(cache, "restart-local-devflow.lock");
  let lockFd;
  try {
    lockFd = openSync(lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`已有重启脚本正在执行。若上次异常退出，请确认脚本已退出，再移除 ${lock}。`);
  }

  let stage;
  let keepStage = false;
  try {
    stage = mkdtempSync(join(cache, "restart-local-devflow-"));
    const candidate = join(stage, "candidate");
    const previous = join(stage, "previous-dist");
    const shell = process.env.ComSpec || "cmd.exe";
    console.log("正在同步依赖并构建当前工作区。");
    run(shell, ["/d", "/c", "pnpm install --frozen-lockfile"]);
    run(shell, ["/d", "/c", "pnpm build"], { ...env, DEVFLOW_BUILD_OUTDIR: candidate });
    const build = readBuild(candidate);
    if (!build.build_revision || !build.application_version) throw new Error("新版构建缺少版本信息。");
    const { loadConfig } = await importFile(join(candidate, "packages/contracts/src/config.js"));
    const config = loadConfig(configPath);
    const endpoint = `http://127.0.0.1:${config.server.port}`;
    const maintenanceMarker = join(config.storage_root, "maintenance-state.json");
    const maintenanceLock = join(config.storage_root, "maintenance.lock");
    const assertNoMaintenance = () => {
      if (existsSync(maintenanceMarker) || existsSync(maintenanceLock)) {
        throw new Error("DevFlow 正在维护或等待恢复，请处理后重试。");
      }
    };

    assertNoMaintenance();
    const hadDist = existsSync(dist);
    if (hadDist) {
      if (!lstatSync(dist).isDirectory() || canonical(realpathSync(dist)) !== canonical(dist)) {
        throw new Error("dist 必须是当前工作区下的普通目录。");
      }
      if (!readBuild(dist).build_revision) throw new Error("无法确认现有 dist 是 DevFlow 构建产物。");
    }
    mkdirSync(config.storage_root, { recursive: true });
    const startupLock = join(config.storage_root, "startup-lock.json");
    try {
      writeFileSync(startupLock, JSON.stringify({ owner: "local-restart", expires: Date.now() + 180000 }), { flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error("另一个 DevFlow 启动操作尚未结束，请稍后重试。");
    }
    let oldService;
    let activated = false;
    try {
      try {
        assertNoMaintenance();
        oldService = await health(endpoint);
        if (oldService) {
          if (!existsSync(cli)) throw new Error("找不到现有服务的停止命令。");
          console.log("正在安全停止当前服务。");
          run(process.execPath, [cli, "stop"]);
          if (await health(endpoint)) throw new Error("服务仍在运行，请稍后重试。");
        }
        assertNoMaintenance();
        console.log("正在切换构建目录。");
        if (hadDist) {
          await moveBuild(dist, previous);
          keepStage = true;
        }
        try {
          await moveBuild(candidate, dist);
          activated = true;
        } catch (error) {
          if (hadDist) await moveBuild(previous, dist);
          keepStage = false;
          throw error;
        }
      } finally {
        unlinkSync(startupLock);
      }
    } catch (error) {
      if (oldService && !activated) {
        try {
          if (!keepStage && !(await health(endpoint))) {
            await startDist();
            const recovered = await health(endpoint);
            if (recovered?.build_revision !== oldService.build_revision) throw new Error("旧版构建号校验失败。");
            console.error("本次切换失败，旧服务已恢复。");
          }
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "切换失败，旧服务也未能恢复。");
        }
      }
      throw error;
    }

    console.log("正在启动新版服务并核对构建版本。");
    const service = await startDist();
    const live = await health(endpoint);
    if (live?.build_revision !== build.build_revision || live.application_version !== build.application_version) {
      throw new Error("运行中的服务与本次构建不一致。");
    }
    keepStage = false;
    console.log(`DevFlow ${live.application_version} 已启动（${live.build_revision}）。`);
    console.log(service.origin);
  } finally {
    try {
      if (keepStage) console.error(`旧版构建保存在 ${join(stage, "previous-dist")}。`);
      else if (stage && dirname(realpathSync(stage)) === cache) rmSync(stage, { recursive: true, force: true });
    } finally {
      closeSync(lockFd);
      unlinkSync(lock);
    }
  }
}

try {
  await restart();
} catch (error) {
  console.error(error.message);
  if (error instanceof AggregateError) {
    for (const cause of error.errors) console.error(cause.message);
  }
  process.exitCode = 1;
}
