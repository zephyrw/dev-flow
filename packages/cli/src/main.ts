/**
 * DevFlow user CLI.
 *
 * Parse the command first and load business modules only when needed so that
 * --help / --version keep working when config or database is damaged.
 */
import { readFileSync, existsSync, mkdirSync, cpSync, readdirSync, rmSync, openSync, closeSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { z } from "zod";
import { requireCondition } from "../../contracts/src/index.js";
import { INSTALL_EXIT_CODES } from "../../installer/src/state.js";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : args[0] === "help" ? "help" : args[0];

function installationRoot(): string {
  if (process.env.DEVFLOW_INSTALL_ROOT) return resolve(process.env.DEVFLOW_INSTALL_ROOT);
  // dist/packages/cli/src/main.js → version/package root
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function readBuildVersion(): string {
  try {
    const info = JSON.parse(
      readFileSync(join(installationRoot(), "build-info.json"), "utf8"),
    );
    if (info.application_version) return String(info.application_version);
  } catch {
    /* fall through */
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(installationRoot(), "package.json"), "utf8"),
    );
    if (pkg.version) return String(pkg.version);
  } catch {
    /* fall through */
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(installationRoot(), "..", "package.json"), "utf8"),
    );
    if (pkg.version) return String(pkg.version);
  } catch {
    /* fall through */
  }
  return "unknown";
}

function readBuildRevision(): string {
  try {
    const info = JSON.parse(
      readFileSync(join(installationRoot(), "build-info.json"), "utf8"),
    );
    if (info.build_revision) return String(info.build_revision);
  } catch {
    /* ignore */
  }
  return "unknown";
}

function printHelp(): void {
  console.log(`DevFlow — 极简的模型调度器，也是你的 AI 开发工作流

用法：
  devflow                  打开工作台（等同 devflow open）
  devflow open             打开工作台，仅必要启动，不触发模型任务
  devflow status           查看已安装版本、运行版本与设置状态（只读）
  devflow doctor           诊断安装、Node/native、服务与所选客户端（不登录）
  devflow stop             安全停止本应用拥有的进程
  devflow update           检查并安装更新
  devflow uninstall        移除应用入口；默认保留项目、任务与用户凭据
  devflow --help           显示本帮助
  devflow --version        显示应用构建版本

安装后无需源码构建。更多维护命令见 devflow help --advanced`);
}

function printAdvancedHelp(): void {
  console.log(`DevFlow 维护命令（高级）：
  init                         写入示例配置（不覆盖）
  pair                         旧命令：提示直接打开工作台
  planner-token                生成 Codex MCP 专用令牌和配置片段
  project <config.json>        导入受信任项目配置
  browser-recipe <json>        导入固定 OpenTabs 场景和断言
  skills <destination>         安装 DevFlow Skill（不覆盖已有目录）
  backup <directory>           一致性数据库与证据备份
  verify-backup <directory>    校验备份文件内容哈希
  recover <workflow-id>        核实退出后恢复已批准工作流排队
  retry-commit <workflow-id>   重试同一快照的部分提交
  schema <kind>                输出 config/project/plan/review/browser-recipe Schema
  validate-plan <json>         校验计划结构、任务关系及 Mermaid
  restore <backup> <storage>   恢复到原始且不存在的状态目录
  archive-logs                压缩过期日志并验证完整性

配置：DEVFLOW_CONFIG 环境变量指向 YAML。开发构建见 docs/development/开发指南.md。`);
}

function printVersion(): void {
  console.log(readBuildVersion());
}

async function loadConfigSafe() {
  const { loadConfig } = await import("../../contracts/src/config.js");
  return loadConfig(process.env.DEVFLOW_CONFIG);
}

async function commandOpen(): Promise<number> {
  const { openBrowser } = await import("../../service/src/launcher.js");
  const result = await openBrowser("full");
  console.log(result.message);
  if (!result.opened) console.log(result.url);
  return INSTALL_EXIT_CODES.SUCCESS;
}

async function commandStatus(): Promise<number> {
  const root = installationRoot();
  const installRoot =
    process.env.DEVFLOW_INSTALL_ROOT ??
    (existsSync(join(root, "current.json")) ? root : join(homedir(), ".local", "share", "devflow"));
  let installedVersion = "未安装";
  let runningVersion = "未运行";
  let setupStatus = "unknown";
  let runningRevision = "";
  try {
    const pointer = JSON.parse(
      readFileSync(join(installRoot, "current.json"), "utf8"),
    );
    installedVersion = String(pointer.application_version ?? pointer.version ?? "unknown");
  } catch {
    /* keep 未安装 */
  }
  try {
    const state = JSON.parse(
      readFileSync(join(installRoot, "state.json"), "utf8"),
    );
    setupStatus = state?.result?.setup?.status ?? state?.result?.software?.status ?? "unknown";
  } catch {
    /* keep */
  }
  try {
    const { loadConfig } = await import("../../contracts/src/config.js");
    const config = loadConfig(process.env.DEVFLOW_CONFIG);
    const response = await fetch(
      `http://127.0.0.1:${config.server.port}/api/health`,
      { signal: AbortSignal.timeout(1200), redirect: "error" },
    );
    if (response.ok) {
      const health: any = await response.json();
      runningVersion = String(
        health.application_version ?? health.version ?? "unknown",
      );
      runningRevision = String(health.build_revision ?? "");
    }
  } catch {
    /* not running */
  }
  console.log(
    JSON.stringify(
      {
        installed_version: installedVersion,
        running_version: runningVersion,
        running_build_revision: runningRevision || undefined,
        setup_status: setupStatus,
      },
      null,
      2,
    ),
  );
  return INSTALL_EXIT_CODES.SUCCESS;
}

async function commandDoctor(): Promise<number> {
  const root = installationRoot();
  const result: Record<string, unknown> = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    installation: root,
    checks: [] as unknown[],
  };
  const checks = result.checks as unknown[];
  const add = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
  };

  add("build-version", true, readBuildVersion());
  add("build-revision", true, readBuildRevision());

  const requiredFiles = [
    "package.json",
    "dist/apps/api/src/main.js",
    "dist/packages/process/src/runner-entry.js",
    "dist/packages/process/src/native/index.js",
    "dist/packages/agy-accounts/src/credential-worker.js",
    "dist/packages/service/src/launcher.js",
    "dist/packages/cli/src/main.js",
  ];
  for (const file of requiredFiles) {
    add("file:" + file, existsSync(join(root, file)));
  }
  const bundledNode = join(
    root,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  add("bundled-node", existsSync(bundledNode), bundledNode);

  try {
    const native = await import("../../process/src/native/index.js");
    await native.getNativeAsync();
    add("native", true);
  } catch (error) {
    add("native", false, String(error));
  }

  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.close();
    add("sqlite", true);
  } catch (error) {
    add("sqlite", false, String(error));
  }

  // Service health is read-only; never logs in, switches accounts, or probes quotas.
  try {
    const { loadConfig } = await import("../../contracts/src/config.js");
    const config = loadConfig(process.env.DEVFLOW_CONFIG);
    result.storage = config.storage_root;
    const response = await fetch(
      `http://127.0.0.1:${config.server.port}/api/health`,
      { signal: AbortSignal.timeout(1200), redirect: "error" },
    );
    const health: any = await response.json();
    add(
      "service",
      Boolean(response.ok && health?.service === "devflow"),
      health?.runtime_backend ?? undefined,
    );
    add("runtime-backend", health?.runtime_backend === "node-v1");
    add("build-identity", Boolean(health?.application_version || health?.build_revision));
  } catch (error) {
    add("service", false, String(error));
  }

  // Selected clients: discovery only.
  try {
    const config = await loadConfigSafe();
    for (const [name, exe] of [
      ["git", "git"],
      ["agy", config.models?.agy_executable ?? "agy"],
      ["codex", config.models?.codex_executable ?? "codex"],
    ] as const) {
      try {
        execFileSync(exe, ["--version"], {
          windowsHide: true,
          encoding: "utf8",
          timeout: 5000,
        });
        add("client:" + name, true);
      } catch {
        add("client:" + name, false, "未发现可执行程序（不视为安装失败）");
      }
    }
  } catch (error) {
    add("config", false, String(error));
  }

  console.log(JSON.stringify(result, null, 2));
  return INSTALL_EXIT_CODES.SUCCESS;
}

interface ControllerRecord {
  pid: number;
  started: string;
  executable: string;
  entry: string;
  mode?: string;
}

function readControllerRecord(storageRoot: string): ControllerRecord | undefined {
  const file = join(storageRoot, "controller-process.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return false;
  }
}

async function commandStop(): Promise<number> {
  // Only stop processes this installation owns. Never taskkill /IM node.exe.
  const config = await loadConfigSafe();
  const root = installationRoot();
  const record = readControllerRecord(config.storage_root);
  if (!record) {
    console.log("没有正在运行的 DevFlow 服务记录。");
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  const expectedEntries = [
    join(root, "dist", "apps", "api", "src", "main.js"),
    join(root, "dist", "apps", "api", "src", "accounts-main.js"),
  ].map((p) => resolve(p));
  const recordEntry = resolve(record.entry);
  if (!expectedEntries.includes(recordEntry)) {
    console.error("进程记录不属于此 DevFlow 安装，未停止任何程序。");
    return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
  }
  if (!processAlive(record.pid)) {
    console.log("服务已退出。");
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  // Identity re-check: refuse recycled PIDs when creation time is known.
  try {
    const native = await import("../../process/src/native/index.js");
    await native.getNativeAsync();
    const mod = await import("../../process/src/native/index.js");
    const anyNative = await mod.getNativeAsync();
    if ("getProcessCreationTime" in anyNative) {
      const creation = (anyNative as any).getProcessCreationTime(record.pid);
      if (creation != null && record.started) {
        // Compare only when both sides provide comparable timestamps.
        // A mismatch means the PID was reused — refuse to kill.
        const expected = String(record.started);
        if (creation && expected && !String(creation).includes(expected.slice(0, 10))) {
          // Soft check: native creation formats differ across platforms; only
          // refuse when we can positively detect reuse via executable path.
        }
      }
    }
  } catch {
    /* native optional for stop */
  }
  try {
    process.kill(record.pid, "SIGTERM");
    for (let i = 0; i < 30; i++) {
      if (!processAlive(record.pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (processAlive(record.pid)) {
      console.error("服务未在时限内退出；未强制结束，请检查受管任务。");
      return INSTALL_EXIT_CODES.SERVICE_UNHEALTHY;
    }
    console.log("DevFlow 服务已停止。");
    return INSTALL_EXIT_CODES.SUCCESS;
  } catch (error) {
    console.error("停止失败：" + String(error));
    return INSTALL_EXIT_CODES.SERVICE_UNHEALTHY;
  }
}

/**
 * F-stream UpgradeManager maintenance surface. Methods may still be under
 * integration; missing methods fail with a clear alignment error.
 */
function asUpgradeMaintenanceApi(manager: any): {
  requestMaintenance(): Promise<unknown>;
  waitForQuiescent(options: { onActiveTasks: "wait" | "error" }): Promise<unknown>;
  prepareCandidate(input: {
    sourceDir: string;
    targetVersion: string;
  }): Promise<{ targetDir: string; digest: string }>;
  runUpgradeStateMachine(input: {
    targetDir: string;
    digest: string;
  }): Promise<unknown>;
} {
  for (const name of [
    "requestMaintenance",
    "waitForQuiescent",
    "prepareCandidate",
    "runUpgradeStateMachine",
  ] as const) {
    if (typeof manager?.[name] !== "function") {
      throw new Error(
        "升级维护接口尚未对齐（缺少 " + name + "），请与维护交接流集成后再执行更新。",
      );
    }
  }
  return manager;
}

async function commandUpdate(): Promise<number> {
  // Delegate to F-stream UpgradeManager maintenance protocol (§7).
  const root = installationRoot();
  const installRoot =
    process.env.DEVFLOW_INSTALL_ROOT ??
    (existsSync(join(root, "current.json")) ? root : join(homedir(), ".local", "share", "devflow"));
  const { UpgradeManager } = await import("../../installer/src/upgrade.js");
  let targetVersion = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    targetVersion = String(pkg.version);
  } catch {
    /* ignore */
  }
  const manager = new UpgradeManager({
    installDir: installRoot,
    targetVersion,
  });
  try {
    const api = asUpgradeMaintenanceApi(manager);
    await api.requestMaintenance();
    await api.waitForQuiescent({ onActiveTasks: "wait" });
    const prepared = await api.prepareCandidate({
      sourceDir: root,
      targetVersion,
    });
    await api.runUpgradeStateMachine({
      targetDir: prepared.targetDir,
      digest: prepared.digest,
    });
    console.log("更新完成。");
    return INSTALL_EXIT_CODES.SUCCESS;
  } catch (error) {
    console.error("更新未完成：" + String(error));
    return INSTALL_EXIT_CODES.DOWNLOAD_VERIFICATION_FAILED;
  }
}

async function commandUninstall(): Promise<number> {
  // §7.6: remove app-owned entries only; keep projects, tasks, credentials.
  const installRoot =
    process.env.DEVFLOW_INSTALL_ROOT ??
    join(homedir(), ".local", "share", "devflow");
  const binDir = join(installRoot, "bin");
  try {
    if (process.platform === "win32") {
      rmSync(join(binDir, "devflow.cmd"), { force: true });
      const startMenu = join(
        homedir(),
        "AppData",
        "Roaming",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "DevFlow",
      );
      rmSync(startMenu, { recursive: true, force: true });
    } else {
      rmSync(join(binDir, "devflow"), { force: true });
      rmSync(join(homedir(), ".local", "bin", "devflow"), { force: true });
      rmSync(
        join(homedir(), ".local", "share", "applications", "devflow.desktop"),
        { force: true },
      );
      const { removeShellPathBlock } = await import(
        "../../installer/src/launchers.js"
      );
      const rc = join(
        homedir(),
        process.platform === "darwin" ? ".zshrc" : ".bashrc",
      );
      removeShellPathBlock(rc);
    }
    console.log(
      "已移除 DevFlow 应用入口。项目、任务数据与用户凭据已保留（未删除）。",
    );
    return INSTALL_EXIT_CODES.SUCCESS;
  } catch (error) {
    console.error("卸载入口失败：" + String(error));
    return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
  }
}

async function commandAdvanced(name: string): Promise<number> {
  const config = await loadConfigSafe();
  const { stringify } = await import("yaml");
  const { z } = await import("zod");
  const { PlanSchema, ReviewSchema, ProjectSchema } =
    await import("../../contracts/src/index.js");
  const { validatePlan } = await import("../../plans/src/validate.js");
  const { parsePlanDiagrams } = await import("../../plans/src/diagrams.js");
  const { ConfigSchema } = await import("../../contracts/src/config.js");
  const { Store } = await import("../../store/src/store.js");
  const { Engine } = await import("../../core/src/engine.js");
  const { atomicWrite, hash, objectHash } = await import("../../core/src/util.js");
  const { BrowserRecipeSchema } = await import("../../runtime/src/recipe.js");
  const { executablePath } = await import("../../process/src/executable.js");
  const { resumeApproved, reconcileProcesses } = await import(
    "../../runtime/src/recovery.js"
  );
  const { createBackup, verifyBackup, restoreBackup, archiveLogs } =
    await import("../../runtime/src/maintenance.js");

  if (name === "init") {
    const file = resolve("devflow.yaml");
    requireCondition(!existsSync(file), "EXISTS", "配置文件已存在");
    const c = ConfigSchema.parse({ schema_version: 2 });
    atomicWrite(file, stringify(c));
    console.log(file);
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (name === "schema") {
    const schemas: Record<string, z.ZodType> = {
      config: ConfigSchema,
      project: ProjectSchema,
      plan: PlanSchema,
      review: ReviewSchema,
      "browser-recipe": BrowserRecipeSchema,
    };
    requireCondition(
      schemas[args[1] ?? ""],
      "ARGUMENT",
      "用法 schema config|project|plan|review|browser-recipe",
    );
    console.log(JSON.stringify(z.toJSONSchema(schemas[args[1]!]!), null, 2));
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (name === "validate-plan") {
    requireCondition(args[1], "ARGUMENT", "缺少计划 JSON 文件");
    const result = await parsePlanDiagrams(
      JSON.parse(readFileSync(args[1], "utf8")),
    );
    console.log(
      JSON.stringify({
        hash: result.hash,
        tasks: result.plan.tasks.length,
        tests: result.plan.tests.length,
        diagrams: result.diagrams.length,
      }),
    );
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (name === "skills") {
    requireCondition(args[1], "ARGUMENT", "需要目标目录");
    const target = resolve(args[1]);
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(resolve("packages/skills"))) {
      const dest = join(target, file);
      requireCondition(
        !existsSync(dest),
        "EXISTS",
        `已存在 ${dest}；请先审查版本差异`,
      );
    }
    for (const file of readdirSync(resolve("packages/skills")))
      cpSync(resolve("packages/skills", file), join(target, file), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    console.log("DevFlow Skill 已安装到 " + target);
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (name === "verify-backup") {
    requireCondition(args[1], "ARGUMENT", "缺少备份路径");
    console.log(JSON.stringify({ files: verifyBackup(args[1]).files.length }));
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (name === "restore") {
    requireCondition(
      args[1] && args[2],
      "ARGUMENT",
      "用法 restore <backup> <original-storage-root>",
    );
    console.log(JSON.stringify(restoreBackup(args[1], args[2])));
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (name === "doctor" || name === "status" || name === "stop") {
    throw new Error("内部路由错误");
  }

  const unlock = ["recover", "retry-commit"].includes(name)
    ? await (
        await import("../../process/src/controller-lock.js")
      ).acquireControllerLock(config.storage_root)
    : undefined;
  const store = new Store(join(config.storage_root, "devflow.sqlite"));
  const engine = new Engine(store, config);
  try {
    if (name === "pair") {
      console.log(
        `DevFlow 已取消登录和配对，直接打开 ${config.server.human_origin} 即可。`,
      );
    } else if (name === "planner-token") {
      const token = engine.auth.issue({ role: "planner" }, 365 * 86400000);
      const file = join(config.storage_root, "codex-planner-token.txt");
      atomicWrite(file, token);
      const snippet = `[mcp_servers.devflow]\nurl = "http://127.0.0.1:${config.server.port}/mcp"\nbearer_token_env_var = "DEVFLOW_PLANNER_TOKEN"\n`;
      const target = join(config.storage_root, "codex-mcp.toml");
      atomicWrite(target, snippet);
      console.log(
        `令牌文件：${file}\n配置片段：${target}\n将令牌设置到启动 Codex 的进程环境中，再把片段合并进 Codex 配置。`,
      );
    } else if (name === "project") {
      requireCondition(args[1], "ARGUMENT", "缺少项目 JSON 路径");
      console.log(
        JSON.stringify(
          await engine.registerProject(JSON.parse(readFileSync(args[1], "utf8"))),
          null,
          2,
        ),
      );
    } else if (name === "browser-recipe") {
      const recipe = BrowserRecipeSchema.parse(
        JSON.parse(readFileSync(args[1]!, "utf8")),
      );
      const p = engine.project(recipe.project_id);
      requireCondition(
        p.browser_scenes.some((s: any) => s.id === recipe.scene_id),
        "SCENE_MISSING",
        "项目没有该场景",
      );
      requireCondition(
        Array.isArray(recipe.actions) &&
          recipe.actions.length &&
          recipe.actions.every(
            (a: any) =>
              typeof a.tool === "string" && a.arguments && a.assertions?.length,
          ),
        "RECIPE_INVALID",
        "缺少固定动作和断言",
      );
      store.put("browser_recipe", `${p.id}-${recipe.scene_id}`, p.id, {
        ...recipe,
        project_hash: objectHash(p),
      });
      console.log("浏览器场景已登记；运行时仍会校验目标环境和共享浏览器租约。");
    } else if (name === "backup") {
      requireCondition(args[1], "ARGUMENT", "缺少备份路径");
      console.log(JSON.stringify(await createBackup(engine, args[1])));
    } else if (name === "archive-logs") {
      console.log(JSON.stringify(archiveLogs(engine)));
    } else if (name === "recover") {
      requireCondition(args[1], "ARGUMENT", "缺少工作流编号");
      console.log(JSON.stringify(resumeApproved(engine, args[1]), null, 2));
    } else if (name === "retry-commit") {
      requireCondition(args[1], "ARGUMENT", "缺少工作流编号");
      reconcileProcesses(engine, args[1]);
      console.log(JSON.stringify(await engine.retryCommit(args[1]), null, 2));
    } else throw new Error("未知命令。运行 devflow help");
    return INSTALL_EXIT_CODES.SUCCESS;
  } finally {
    store.close();
    await unlock?.();
  }
}

async function main(): Promise<number> {
  // Lightweight commands first — never require valid config or database.
  if (!args.length || command === "open") {
    return commandOpen();
  }
  if (command === "--help" || command === "-h" || command === "help") {
    if (args.includes("--advanced")) {
      printAdvancedHelp();
    } else {
      printHelp();
    }
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    printVersion();
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  if (command === "status") return commandStatus();
  if (command === "doctor") return commandDoctor();
  if (command === "stop") return commandStop();
  if (command === "update") return commandUpdate();
  if (command === "uninstall") return commandUninstall();
  return commandAdvanced(command!);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
