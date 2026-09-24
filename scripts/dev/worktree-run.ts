import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";
import {
  ProcessManager,
  type ManagedProcess,
} from "../../packages/process/src/manager.js";
import { executablePath } from "../../packages/process/src/executable.js";
import { hash } from "../../packages/core/src/util.js";
import {
  ConfigSchema,
  loadConfig,
} from "../../packages/contracts/src/config.js";
import {
  getWorktreeRoot,
  reservePorts,
  releasePorts,
  type WorktreeInstanceConfig,
} from "./worktree-env.js";

class Interrupted extends Error {
  constructor(readonly code: number) {
    super("运行已中断");
  }
}

function exitCode(result: { code: number | null; signal?: string }) {
  if (result.signal)
    return (
      128 +
      (constants.signals[result.signal as keyof typeof constants.signals] ?? 1)
    );
  return result.code === null ? 1 : result.code < 0 ? 1 : result.code;
}

function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveResult, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolveResult, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function health(
  url: string,
  instance: WorktreeInstanceConfig,
): Promise<boolean> {
  return new Promise((resolveResult) => {
    const req = get(url, { timeout: 1500 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolveResult(false);
        return;
      }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 65536) {
          req.destroy();
          resolveResult(false);
        }
      });
      res.on("error", () => resolveResult(false));
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          const normalize = (path: string) => resolve(path).toLowerCase();
          resolveResult(
            body.ok === true &&
              body.service === "devflow" &&
              body.mode === "full" &&
              body.instance === hash(normalize(instance.paths.storage_root)) &&
              typeof body.runtime_root === "string" &&
              normalize(body.runtime_root) ===
                normalize(instance.worktree_path),
          );
        } catch {
          resolveResult(false);
        }
      });
    });
    req.on("error", () => resolveResult(false));
    req.on("timeout", () => {
      req.destroy();
      resolveResult(false);
    });
  });
}

async function waitForHealth(
  url: string,
  instance: WorktreeInstanceConfig,
  signal: AbortSignal,
) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await health(url, instance)) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`实例未就绪或身份不匹配: ${url}`);
}

// Use actual Node entries/native binaries so arguments never pass through a shell.
function commandLaunch(command: string, args: string[], root: string) {
  const require = createRequire(join(root, "package.json"));
  if (/^pnpm(?:\.cmd|\.exe)?$/i.test(basename(command))) {
    const candidates: string[] = [];
    if (process.env.npm_execpath && /pnpm/i.test(process.env.npm_execpath))
      candidates.push(process.env.npm_execpath);
    if (process.platform === "win32") {
      try {
        const found = execFileSync("where.exe", [command], {
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .split(/\r?\n/);
        for (const file of found)
          candidates.push(
            file,
            join(dirname(file), "node_modules/pnpm/bin/pnpm.cjs"),
            join(dirname(file), "node_modules/corepack/dist/pnpm.js"),
          );
      } catch {}
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      if (/\.(?:cjs|mjs|js)$/i.test(candidate))
        return { executable: process.execPath, args: [candidate, ...args] };
      if (/\.exe$/i.test(candidate)) return { executable: candidate, args };
    }
  }
  if (["tsx", "vite", "vitest", "playwright"].includes(command)) {
    const pkgFile = require.resolve(`${command}/package.json`);
    const pkg = require(pkgFile);
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[command];
    if (typeof bin === "string")
      return {
        executable: process.execPath,
        args: [join(dirname(pkgFile), bin), ...args],
      };
  }
  if ([".js", ".cjs", ".mjs"].includes(extname(command)))
    return {
      executable: process.execPath,
      args: [resolve(root, command), ...args],
    };
  return { executable: executablePath(command), args };
}

async function run(mode: "dev" | "test", args: string[]) {
  const root = getWorktreeRoot();
  const configFile = join(root, "devflow.yaml");
  const config = existsSync(configFile)
    ? loadConfig(configFile)
    : ConfigSchema.parse({});
  const signalController = new AbortController();
  const onInt = () => signalController.abort(new Interrupted(130));
  const onTerm = () => signalController.abort(new Interrupted(143));
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  const excluded: number[] = [];
  try {
    for (
      let attempt = 0;
      attempt < (mode === "dev" ? config.ports.bind_retries : 1);
      attempt++
    ) {
      signalController.signal.throwIfAborted();
      // Every invocation owns fresh resources; never adopt current-dev.json.
      const instance = await reservePorts({
        instanceType: mode,
        worktreeRoot: root,
        reservedPorts: excluded,
      });
      const manager = new ProcessManager();
      const children: ManagedProcess[] = [];
      let outputTail = "";
      const attemptController = new AbortController();
      const cancelAttempt = () =>
        attemptController.abort(signalController.signal.reason);
      signalController.signal.addEventListener("abort", cancelAttempt, {
        once: true,
      });
      const start = (
        name: string,
        executable: string,
        commandArgs: string[],
        extraEnv: Record<string, string>,
      ) => {
        signalController.signal.throwIfAborted();
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const child = manager.start({
          id: `${instance.instance_id}-${name}`,
          executable,
          args: commandArgs,
          cwd: root,
          env: { ...env, ...extraEnv },
          timeout_ms: 0,
        });
        children.push(child);
        const output = (stream: NodeJS.WriteStream, data: Buffer) => {
          stream.write(data);
          outputTail = (outputTail + data.toString()).slice(-16000);
        };
        child.on("stdout", (data) => output(process.stdout, data));
        child.on("stderr", (data) => output(process.stderr, data));
        return child;
      };
      const stopped = (child: ManagedProcess) =>
        child.completion.then((result) => {
          throw new Error(`服务提前退出 (${exitCode(result)})`);
        });
      let retry = false;
      try {
        console.log(
          `[worktree-run] ${mode} 实例 ${instance.instance_id}\n目录: ${root}\n运行目录: ${instance.paths.run_dir}`,
        );
        if (mode === "test") {
          const launch = commandLaunch(args[0]!, args.slice(1), root);
          const child = start("test", launch.executable, launch.args, {
            DEVFLOW_TEST_PORT: String(instance.ports.test),
            DEVFLOW_TEST_RUN_DIR: instance.paths.run_dir,
            DEVFLOW_CONFIG: instance.paths.runtime_config,
            DEVFLOW_REUSE_SERVER: "0",
            DEVFLOW_LOCAL_DEV: "0",
          });
          return exitCode(
            await withSignal(child.completion, signalController.signal),
          );
        }
        const api = start(
          "api",
          process.execPath,
          ["--import", "tsx", "apps/api/src/main.ts"],
          {
            DEVFLOW_CONFIG: instance.paths.runtime_config,
            DEVFLOW_LOCAL_DEV: "1",
            DEVFLOW_DEV_FRONTEND_ORIGIN: instance.origins.frontend,
            DEVFLOW_INSTANCE_ID: instance.instance_id,
          },
        );
        await withSignal(
          Promise.race([api.ready, stopped(api)]),
          signalController.signal,
        );
        await withSignal(
          Promise.race([
            waitForHealth(
              `${instance.origins.backend}/api/health`,
              instance,
              attemptController.signal,
            ),
            stopped(api),
          ]),
          signalController.signal,
        );
        const vite = commandLaunch(
          "vite",
          ["--config", "apps/web/vite.config.ts"],
          root,
        );
        const web = start("web", vite.executable, vite.args, {
          DEVFLOW_WEB_PORT: String(instance.ports.frontend),
          DEVFLOW_API_PORT: String(instance.ports.backend),
        });
        await withSignal(
          Promise.race([web.ready, stopped(api), stopped(web)]),
          signalController.signal,
        );
        await withSignal(
          Promise.race([
            waitForHealth(
              `${instance.origins.frontend}/api/health`,
              instance,
              attemptController.signal,
            ),
            stopped(api),
            stopped(web),
          ]),
          signalController.signal,
        );
        console.log(
          `[worktree-run] 前后端及代理已就绪: ${instance.origins.frontend}`,
        );
        await withSignal(
          Promise.race([stopped(api), stopped(web)]),
          signalController.signal,
        );
      } catch (error) {
        if (
          !signalController.signal.aborted &&
          mode === "dev" &&
          /EADDRINUSE|Port \d+ is already in use/i.test(outputTail) &&
          attempt + 1 < config.ports.bind_retries
        ) {
          excluded.push(...Object.values(instance.ports));
          retry = true;
          console.warn("[worktree-run] 端口绑定冲突，清理本实例后重新分配");
        } else throw error;
      } finally {
        attemptController.abort();
        signalController.signal.removeEventListener("abort", cancelAttempt);
        const results = await Promise.all(
          children.map((child) => manager.stop(child.id)),
        );
        if (
          results.some(
            (result) =>
              !["confirmed_exited", "confirmed_not_started"].includes(
                result.status,
              ),
          )
        )
          throw new Error(
            `无法确认本实例进程树退出，保留登记: ${instance.instance_id}`,
          );
        await releasePorts(instance.instance_id, root, {
          runDir: instance.paths.run_dir,
        });
      }
      if (!retry) break;
    }
    return 1;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
  }
}

async function main() {
  const mode = process.argv[2];
  const separator = process.argv.indexOf("--");
  const args = process.argv.slice(separator >= 0 ? separator + 1 : 3);
  if ((mode !== "dev" && mode !== "test") || (mode === "test" && !args.length))
    throw new Error("用法: worktree-run.ts dev | test -- <命令> [参数...]");
  process.exitCode = await run(mode, args);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      "worktree-run 运行失败:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = error instanceof Interrupted ? error.code : 1;
  });
}
