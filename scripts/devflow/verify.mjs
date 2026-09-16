import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

const command = process.argv[2];
const nodeCmd = process.execPath;
const require = createRequire(import.meta.url);
const packageFile = (name, path) => resolve(dirname(require.resolve(`${name}/package.json`)), path);

function run(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: false,
  });
  if (res.error) {
    console.error(res.error);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function ensureDir(filePath) {
  const d = dirname(filePath);
  if (!existsSync(d)) {
    mkdirSync(d, { recursive: true });
  }
}

switch (command) {
  case "bootstrap": {
    run(nodeCmd, [resolve(dirname(nodeCmd), "node_modules/corepack/dist/pnpm.js"), "install", "--frozen-lockfile"]);
    break;
  }
  case "build": {
    run(nodeCmd, [packageFile("typescript", "bin/tsc"), "-p", "tsconfig.build.json", "--noEmitOnError"]);
    const webDist = resolve(root, "dist/web/index.html");
    if (!existsSync(webDist) || process.env.DEVFLOW_FORCE_BUILD === "1") {
      run(nodeCmd, [packageFile("vite", "bin/vite.js"), "build", "--config", "apps/web/vite.config.ts"]);
    }
    break;
  }
  case "unit": {
    const reportPath =
      process.env.DEVFLOW_REPORT_PATH || resolve(root, ".reports/unit.json");
    ensureDir(reportPath);
    run(nodeCmd, [
      packageFile("vitest", "vitest.mjs"),
      "run",
      "tests/unit",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ]);
    break;
  }
  case "integration": {
    const reportPath =
      process.env.DEVFLOW_REPORT_PATH ||
      resolve(root, ".reports/integration.json");
    ensureDir(reportPath);
    const candidates = [
      "tests/integration/run-deadline.test.ts",
      "tests/integration/hook.test.ts",
      "tests/integration/run-failure.test.ts",
    ].filter((f) => existsSync(resolve(root, f)));
    if (!candidates.length) throw new Error("没有注册的集成测试文件");
    run(nodeCmd, [
      packageFile("vitest", "vitest.mjs"),
      "run",
      ...candidates,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ]);
    break;
  }
  case "e2e": {
    const reportPath =
      process.env.DEVFLOW_REPORT_PATH || resolve(root, ".reports/e2e.json");
    ensureDir(reportPath);
    run(
      nodeCmd,
      [
        packageFile("@playwright/test", "cli.js"),
        "test",
        "--config=scripts/devflow/stage-playwright.config.ts",
      ],
      {
        DEVFLOW_REPORT_PATH: reportPath,
      },
    );
    break;
  }
  case "certification": {
    const reportPath =
      process.env.DEVFLOW_REPORT_PATH ||
      resolve(root, ".reports/certification.xml");
    ensureDir(reportPath);
    run(nodeCmd, [
      "--test",
      "--test-reporter=junit",
      `--test-reporter-destination=${reportPath}`,
      "scripts/devflow/stage-certification.test.mjs",
    ]);
    break;
  }
  case "preview": {
    await import("./stage-preview.mjs");
    break;
  }
  default: {
    console.error(`未知子命令: ${command}`);
    process.exit(1);
  }
}
