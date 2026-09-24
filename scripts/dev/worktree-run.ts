import { execSync, spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import {
  reservePorts,
  releasePorts,
  readInstanceConfig,
  type WorktreeInstanceConfig,
} from "./worktree-env.js";

async function isUrlHealthy(url: string): Promise<boolean> {
  return new Promise((resolveResult) => {
    const req = get(url, { timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolveResult(false);
      }
      let raw = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          const body = JSON.parse(raw);
          if (body?.ok === true && body?.service === "devflow") {
            return resolveResult(true);
          }
        } catch {}
        resolveResult(false);
      });
    });
    req.on("error", () => resolveResult(false));
    req.on("timeout", () => {
      req.destroy();
      resolveResult(false);
    });
  });
}

async function waitForApiHealth(
  port: number,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() - start < timeoutMs) {
    const ok = await isUrlHealthy(url);
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function killProcessTree(proc: ChildProcess): Promise<void> {
  if (!proc || proc.killed || !proc.pid) return;

  const pid = proc.pid;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
  }

  // 等待进程真正关闭
  if (!proc.killed) {
    await new Promise<void>((done) => {
      const timer = setTimeout(() => done(), 3000);
      proc.once("close", () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

async function runDev() {
  const conflictedPorts: number[] = [];
  let instance: WorktreeInstanceConfig | null = null;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    if (!instance) {
      const existing = readInstanceConfig();
      if (existing && attempt === 1) {
        instance = existing;
      } else {
        console.log(`[worktree-run] 正在分配独立开发端口与配置 (尝试 ${attempt}/${maxAttempts})...`);
        instance = await reservePorts({
          instanceType: "dev",
          reservedPorts: conflictedPorts,
        });
      }
    }

    console.log("==================================================");
    console.log(`[DevFlow Worktree 隔离开发环境]`);
    console.log(`实例 ID:     ${instance.instance_id}`);
    console.log(`工作目录:    ${instance.worktree_path}`);
    console.log(`前端端口:    ${instance.ports.frontend} (URL: ${instance.origins.frontend})`);
    console.log(`后端端口:    ${instance.ports.backend}  (URL: ${instance.origins.backend})`);
    console.log(`运行配置:    ${instance.paths.runtime_config}`);
    console.log("==================================================");

    const processes: ChildProcess[] = [];
    let cleanupPromise: Promise<void> | null = null;
    let initialExitCode: number = 0;
    let isBindingConflict = false;

    const cleanup = async (exitCode: number = 0) => {
      if (cleanupPromise) return cleanupPromise;
      if (initialExitCode === 0 && exitCode !== 0) {
        initialExitCode = exitCode;
      }

      cleanupPromise = (async () => {
        console.log("\n正在停止本 worktree 的服务进程树...");
        for (const proc of processes) {
          await killProcessTree(proc);
        }
        if (instance && !isBindingConflict) {
          try {
            await releasePorts(instance.instance_id);
            console.log(`已成功释放实例 ${instance.instance_id} 的端口登记。`);
          } catch (err) {
            console.warn("释放端口登记失败:", err);
          }
        }
        process.exit(initialExitCode);
      })();

      return cleanupPromise;
    };

    const sigintHandler = () => {
      console.log("\n收到中断信号，开始优雅停止...");
      void cleanup(130);
    };
    const sigtermHandler = () => {
      console.log("\n收到终止信号，开始优雅停止...");
      void cleanup(143);
    };

    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);

    // 1. 启动后端 API 服务
    const apiEnv = {
      ...process.env,
      DEVFLOW_CONFIG: instance.paths.runtime_config,
      DEVFLOW_LOCAL_DEV: "1",
      DEVFLOW_DEV_FRONTEND_ORIGIN: instance.origins.frontend,
      DEVFLOW_INSTANCE_ID: instance.instance_id,
    };

    console.log("正在启动后端 API 服务...");
    let apiStderrOutput = "";
    const apiProc = spawn("pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
      cwd: instance.worktree_path,
      stdio: ["inherit", "inherit", "pipe"],
      env: apiEnv,
      shell: process.platform === "win32",
    });
    processes.push(apiProc);

    apiProc.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      process.stderr.write(text);
      apiStderrOutput += text;
      if (text.includes("EADDRINUSE")) {
        isBindingConflict = true;
      }
    });

    let apiExitedEarly = false;
    let earlyExitCode: number | null = null;
    const earlyExitListener = (code: number | null) => {
      apiExitedEarly = true;
      earlyExitCode = code;
    };
    apiProc.once("exit", earlyExitListener);

    // 等待 API 健康检查通过
    console.log("等待后端 API 服务健康就绪...");
    const isHealthy = await waitForApiHealth(instance.ports.backend, 15000);

    if (!isHealthy) {
      apiProc.removeListener("exit", earlyExitListener);
      // 检查是否端口冲突
      if (isBindingConflict || apiStderrOutput.includes("EADDRINUSE")) {
        console.warn(`[worktree-run] 后端端口 ${instance.ports.backend} 遭遇绑定竞态 (EADDRINUSE)，正在重新分配并重试...`);
        conflictedPorts.push(instance.ports.backend);
        await killProcessTree(apiProc);
        try {
          await releasePorts(instance.instance_id);
        } catch {}
        instance = null;
        process.removeListener("SIGINT", sigintHandler);
        process.removeListener("SIGTERM", sigtermHandler);
        continue;
      }

      console.error(`后端服务在规定时间内未通过健康检查。早期退出状态: ${apiExitedEarly}, 代码: ${earlyExitCode}`);
      await cleanup(earlyExitCode ?? 1);
      return;
    }

    // 健康检查通过，移除早期退出监听
    apiProc.removeListener("exit", earlyExitListener);
    apiProc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`后端服务异常退出，代码: ${code}`);
        void cleanup(code);
      }
    });

    console.log(`后端 API 服务已健康就绪 (HTTP 200 /api/health)`);

    // 2. 启动前端 Vite 服务
    const webEnv = {
      ...process.env,
      DEVFLOW_WEB_PORT: String(instance.ports.frontend),
      DEVFLOW_API_PORT: String(instance.ports.backend),
    };

    console.log("正在启动前端 Vite 服务...");
    const webProc = spawn("pnpm", ["exec", "vite", "apps/web"], {
      cwd: instance.worktree_path,
      stdio: "inherit",
      env: webEnv,
      shell: process.platform === "win32",
    });
    processes.push(webProc);

    webProc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`前端 Vite 服务退出，代码: ${code}`);
        void cleanup(code);
      }
    });

    console.log(`\n==================================================`);
    console.log(`工作树隔离开发环境已成功启动！`);
    console.log(`访问控制台前端: ${instance.origins.frontend}`);
    console.log(`后端服务接口:   ${instance.origins.backend}`);
    console.log(`按 Ctrl+C 可停止环境并自动释放端口登记。`);
    console.log(`==================================================\n`);

    // 成功启动，不再重试
    return;
  }

  console.error(`[worktree-run] 已达最大启动重试次数 (${maxAttempts})，启动失败。`);
  process.exit(1);
}

async function runTest(args: string[]) {
  if (args.length === 0) {
    console.error("用法: pnpm exec tsx scripts/dev/worktree-run.ts test -- <test_command> [args...]");
    process.exit(1);
  }

  // 严禁复用 dev 实例，每次测试分配独立测试实例 (F10)
  console.log("[Worktree 隔离测试] 正在为测试分配独立的运行目录与端口...");
  const testInstance = await reservePorts({
    instanceType: "test",
    targetId: "test",
  });

  const testEnv = {
    ...process.env,
    DEVFLOW_TEST_PORT: String(testInstance.ports.test),
    DEVFLOW_TEST_RUN_DIR: testInstance.paths.run_dir,
    DEVFLOW_CONFIG: testInstance.paths.runtime_config,
  };

  const [cmd, ...cmdArgs] = args;
  console.log(`[Worktree 隔离测试] 执行命令: ${cmd} ${cmdArgs.join(" ")}`);
  console.log(`[Worktree 隔离测试] 测试实例 ID: ${testInstance.instance_id}`);
  console.log(`[Worktree 隔离测试] 测试端口: ${testInstance.ports.test}`);
  console.log(`[Worktree 隔离测试] 运行目录: ${testInstance.paths.run_dir}`);

  let childProc: ChildProcess | null = null;
  let finished = false;

  const cleanupTest = async () => {
    if (finished) return;
    finished = true;
    if (childProc) {
      await killProcessTree(childProc);
    }
    try {
      await releasePorts(testInstance.instance_id);
      console.log(`[Worktree 隔离测试] 已释放测试实例 ${testInstance.instance_id} 的端口登记与资源。`);
    } catch (err) {
      console.warn("清理测试实例失败:", err);
    }
  };

  process.once("SIGINT", async () => {
    console.log("\n[Worktree 隔离测试] 收到中断信号...");
    await cleanupTest();
    process.exit(130);
  });
  process.once("SIGTERM", async () => {
    console.log("\n[Worktree 隔离测试] 收到终止信号...");
    await cleanupTest();
    process.exit(143);
  });

  try {
    childProc = spawn(cmd, cmdArgs, {
      cwd: testInstance.worktree_path,
      stdio: "inherit",
      env: testEnv,
      shell: process.platform === "win32",
    });

    childProc.on("exit", async (code) => {
      await cleanupTest();
      process.exit(code ?? 0);
    });
  } catch (err) {
    console.error("启动测试子进程失败:", err);
    await cleanupTest();
    process.exit(1);
  }
}

async function main() {
  const mode = process.argv[2];
  if (mode === "dev") {
    await runDev();
  } else if (mode === "test") {
    const dashIndex = process.argv.indexOf("--");
    const testArgs = dashIndex !== -1 ? process.argv.slice(dashIndex + 1) : process.argv.slice(3);
    await runTest(testArgs);
  } else {
    console.log("用法:");
    console.log("  pnpm exec tsx scripts/dev/worktree-run.ts dev");
    console.log("  pnpm exec tsx scripts/dev/worktree-run.ts test -- <test_command...>");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("worktree-run 运行失败:", err);
  process.exit(1);
});
