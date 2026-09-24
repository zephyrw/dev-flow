import { spawn, type ChildProcess } from "node:child_process";
import { reservePorts, releasePorts, readInstanceConfig } from "./worktree-env.js";

async function runDev() {
  let instance = readInstanceConfig();
  if (!instance) {
    console.log("未检测到本地实例配置，正在自动分配独立端口与生成配置...");
    instance = await reservePorts();
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

  const cleanup = async () => {
    console.log("\n正在停止本 worktree 的服务进程...");
    for (const proc of processes) {
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // 忽略已终止
        }
      }
    }
    // 释放端口登记
    try {
      await releasePorts(instance.instance_id);
      console.log("已释放端口登记与清理实例临时记录。");
    } catch {
      // 忽略清理失败
    }
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 1. 启动后端 API
  const apiEnv = {
    ...process.env,
    DEVFLOW_CONFIG: instance.paths.runtime_config,
    DEVFLOW_LOCAL_DEV: "1",
    DEVFLOW_DEV_FRONTEND_ORIGIN: instance.origins.frontend,
  };

  console.log("正在启动后端 API 服务...");
  const apiProc = spawn("pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
    stdio: "inherit",
    env: apiEnv,
    shell: process.platform === "win32",
  });
  processes.push(apiProc);

  // 2. 启动前端 Vite
  const webEnv = {
    ...process.env,
    DEVFLOW_WEB_PORT: String(instance.ports.frontend),
    DEVFLOW_API_PORT: String(instance.ports.backend),
  };

  console.log("正在启动前端 Vite 服务...");
  const webProc = spawn("pnpm", ["exec", "vite", "apps/web"], {
    stdio: "inherit",
    env: webEnv,
    shell: process.platform === "win32",
  });
  processes.push(webProc);

  apiProc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`后端服务退出，代码: ${code}`);
      void cleanup();
    }
  });

  webProc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`前端服务退出，代码: ${code}`);
      void cleanup();
    }
  });
}

async function runTest(args: string[]) {
  if (args.length === 0) {
    console.error("用法: pnpm exec tsx scripts/dev/worktree-run.ts test -- <test_command> [args...]");
    process.exit(1);
  }

  let instance = readInstanceConfig();
  if (!instance) {
    instance = await reservePorts();
  }

  const testEnv = {
    ...process.env,
    DEVFLOW_TEST_PORT: String(instance.ports.test),
    DEVFLOW_TEST_RUN_DIR: instance.paths.run_dir,
    DEVFLOW_CONFIG: instance.paths.runtime_config,
  };

  const [cmd, ...cmdArgs] = args;
  console.log(`[Worktree 隔离测试] 执行命令: ${cmd} ${cmdArgs.join(" ")}`);
  console.log(`[Worktree 隔离测试] 测试端口: ${instance.ports.test}, 运行目录: ${instance.paths.run_dir}`);

  const child = spawn(cmd, cmdArgs, {
    stdio: "inherit",
    env: testEnv,
    shell: process.platform === "win32",
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "dev") {
    await runDev();
  } else if (mode === "test") {
    // 找到 -- 后面的参数
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
