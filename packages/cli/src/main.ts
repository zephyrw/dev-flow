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
import {
  resolveInstallationContext,
  type InstallationContext,
} from "../../installer/src/context.js";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : args[0] === "help" ? "help" : args[0];

let cachedContext: InstallationContext | null = null;
function getInstallationContext(): InstallationContext {
  if (!cachedContext) {
    cachedContext = resolveInstallationContext();
  }
  return cachedContext;
}

function readBuildVersion(): string {
  const ctx = getInstallationContext();
  try {
    const info = JSON.parse(
      readFileSync(join(ctx.versionRoot, "build-info.json"), "utf8"),
    );
    if (info.application_version) return String(info.application_version);
  } catch {
    /* fall through */
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(ctx.versionRoot, "package.json"), "utf8"),
    );
    if (pkg.version) return String(pkg.version);
  } catch {
    /* fall through */
  }
  try {
    const pointer = JSON.parse(
      readFileSync(join(ctx.installRoot, "current.json"), "utf8"),
    );
    if (pointer.application_version || pointer.version) {
      return String(pointer.application_version ?? pointer.version);
    }
  } catch {
    /* fall through */
  }
  return "unknown";
}

function readBuildRevision(): string {
  const ctx = getInstallationContext();
  try {
    const info = JSON.parse(
      readFileSync(join(ctx.versionRoot, "build-info.json"), "utf8"),
    );
    if (info.build_revision) return String(info.build_revision);
  } catch {
    /* ignore */
  }
  try {
    const pointer = JSON.parse(
      readFileSync(join(ctx.installRoot, "current.json"), "utf8"),
    );
    if (pointer.build_revision) return String(pointer.build_revision);
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
  const ctx = getInstallationContext();
  const { loadConfig } = await import("../../contracts/src/config.js");
  return loadConfig(ctx.configPath);
}

async function commandOpen(): Promise<number> {
  const { openBrowser } = await import("../../service/src/launcher.js");
  const result = await openBrowser("full");
  console.log(result.message);
  if (!result.opened) console.log(result.url);
  return INSTALL_EXIT_CODES.SUCCESS;
}

async function commandStatus(): Promise<number> {
  const ctx = getInstallationContext();
  let installedVersion = "未安装";
  let runningVersion = "未运行";
  let setupStatus = "unknown";
  let runningRevision = "";
  try {
    const pointer = JSON.parse(
      readFileSync(join(ctx.installRoot, "current.json"), "utf8"),
    );
    installedVersion = String(pointer.application_version ?? pointer.version ?? "unknown");
  } catch {
    /* keep 未安装 */
  }
  try {
    const state = JSON.parse(
      readFileSync(join(ctx.installRoot, "state.json"), "utf8"),
    );
    setupStatus = state?.result?.setup?.status ?? state?.result?.software?.status ?? "unknown";
  } catch {
    /* keep */
  }
  try {
    const config = await loadConfigSafe();
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
  const ctx = getInstallationContext();
  const result: Record<string, unknown> = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    install_root: ctx.installRoot,
    version_root: ctx.versionRoot,
    config_path: ctx.configPath,
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
    add("file:" + file, existsSync(join(ctx.versionRoot, file)));
  }
  const bundledNode = join(
    ctx.versionRoot,
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const bootstrapNode = join(
    ctx.installRoot,
    "bootstrap",
    "runtime",
    process.platform === "win32" ? "node.exe" : "node",
  );
  const hasNode = existsSync(bundledNode) || existsSync(bootstrapNode);
  add(
    "bundled-node",
    hasNode,
    existsSync(bundledNode) ? bundledNode : existsSync(bootstrapNode) ? bootstrapNode : undefined,
  );

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
    const config = await loadConfigSafe();
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
  const ctx = getInstallationContext();
  const config = await loadConfigSafe();
  const storageRoot = config?.storage_root
    ? resolve(dirname(ctx.configPath), config.storage_root)
    : ctx.storageRoot;
  const record = readControllerRecord(storageRoot);
  if (!record) {
    console.log("没有正在运行的 DevFlow 服务记录。");
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  const expectedEntries = [
    join(ctx.versionRoot, "dist", "apps", "api", "src", "main.js"),
    join(ctx.versionRoot, "dist", "apps", "api", "src", "accounts-main.js"),
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
    const anyNative = await native.getNativeAsync();
    if ("getProcessCreationTime" in anyNative) {
      const creation = (anyNative as any).getProcessCreationTime(record.pid);
      if (creation != null && record.started) {
        const expected = String(record.started);
        if (creation && expected && !String(creation).includes(expected.slice(0, 10))) {
          console.error("进程 PID 属于已复用的外部进程，拒绝停止。");
          return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
        }
      }
    }
  } catch {
    /* native optional for stop */
  }

  // Graceful stop via local protocol first
  let stoppedGracefully = false;
  try {
    if (config?.server?.port) {
      const shutdownResp = await fetch(
        `http://127.0.0.1:${config.server.port}/api/maintenance/quiesce`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: config.server.human_origin ?? `http://127.0.0.1:${config.server.port}`,
          },
          body: JSON.stringify({ on_active_tasks: "wait" }),
          signal: AbortSignal.timeout(3000),
        },
      ).catch(() => undefined);
      if (shutdownResp?.ok) {
        for (let i = 0; i < 40; i++) {
          if (!processAlive(record.pid)) {
            stoppedGracefully = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  } catch {
    /* fallback to signal */
  }

  if (stoppedGracefully || !processAlive(record.pid)) {
    console.log("DevFlow 服务已停止。");
    return INSTALL_EXIT_CODES.SUCCESS;
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

async function commandUpdate(): Promise<number> {
  const ctx = getInstallationContext();
  const { UpgradeManager } = await import("../../installer/src/upgrade.js");
  const config = await loadConfigSafe();
  const storageRoot = config?.storage_root
    ? resolve(dirname(ctx.configPath), config.storage_root)
    : ctx.storageRoot;
  const serviceOrigin = config?.server?.human_origin ?? `http://127.0.0.1:${config?.server?.port ?? 4810}`;

  let sourceDir = "";
  let targetVersion = "";
  for (let i = 1; i < args.length; i++) {
    const val = args[i + 1];
    if (args[i] === "--source" && typeof val === "string") {
      sourceDir = resolve(val);
      i++;
    } else if (args[i] === "--version" && typeof val === "string") {
      targetVersion = val;
      i++;
    }
  }

  const currentVersion = readBuildVersion();

  if (!sourceDir) {
    if (targetVersion && targetVersion === currentVersion) {
      console.log(`当前已是目标版本 (${currentVersion})，无需更新。`);
      return INSTALL_EXIT_CODES.SUCCESS;
    }
    if (!targetVersion) {
      console.log(`当前已是最新版本 (${currentVersion})，未发现待安装的更新包。`);
      return INSTALL_EXIT_CODES.SUCCESS;
    }
    throw new Error(`请使用 --source 指定更新包路径或通过正式安装脚本执行更新。`);
  }

  if (!targetVersion) {
    try {
      const pkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
      targetVersion = String(pkg.version);
    } catch {
      throw new Error(`候选目录缺少有效的 package.json: ${sourceDir}`);
    }
  }

  const manager = new UpgradeManager({
    installDir: ctx.installRoot,
    installRoot: ctx.installRoot,
    storageRoot,
    serviceOrigin,
    targetVersion,
  });

  try {
    const result = await manager.runUpgradeStateMachine({
      sourceDir,
      targetVersion,
      installRoot: ctx.installRoot,
      storageRoot,
      configPath: ctx.configPath,
      nodePath: ctx.nodePath,
      serviceOrigin,
      onActiveTasks: "wait",
    });

    switch (result.status) {
      case "verified":
        console.log(`更新完成。已成功激活版本 ${result.target_version}。`);
        return INSTALL_EXIT_CODES.SUCCESS;
      case "no_update":
        console.log(`当前已是最新版本 (${currentVersion})，无需更新。`);
        return INSTALL_EXIT_CODES.SUCCESS;
      case "blocked":
        console.error(`更新被阻止：${result.error?.message ?? "存在运行中的活跃任务"}`);
        return INSTALL_EXIT_CODES.NEEDS_USER_ACTION;
      case "safe_abort":
        console.error(`更新未完成并已安全撤销修改：${result.error?.message ?? "未知错误"}`);
        return INSTALL_EXIT_CODES.DOWNLOAD_VERIFICATION_FAILED;
      case "recovery_required":
        console.error(`更新中断并保留现场，需进行恢复：${result.error?.message}`);
        console.error("恢复动作建议：" + (result.recovery_actions.join(", ") || "请运行 devflow doctor"));
        return INSTALL_EXIT_CODES.SERVICE_UNHEALTHY;
      default:
        console.error("更新返回未知状态。");
        return INSTALL_EXIT_CODES.SERVICE_UNHEALTHY;
    }
  } catch (error) {
    console.error("更新执行异常：" + String(error));
    return INSTALL_EXIT_CODES.DOWNLOAD_VERIFICATION_FAILED;
  }
}

async function commandUninstall(): Promise<number> {
  const ctx = getInstallationContext();
  const installRoot = ctx.installRoot;
  const binDir = join(installRoot, "bin");

  try {
    // 1. 先安全请求停机
    await commandStop().catch(() => undefined);

    // 2. 读取安装收据，仅移除收据记录的属于本实例的入口
    let installedEntries: Array<{ path: string; kind?: string }> = [];
    const currentPointerFile = join(installRoot, "current.json");
    if (existsSync(currentPointerFile)) {
      try {
        const pointer = JSON.parse(readFileSync(currentPointerFile, "utf8"));
        const versionRoot = pointer.root;
        const receiptPath = join(versionRoot, "install-source.json");
        if (existsSync(receiptPath)) {
          const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
          if (Array.isArray(receipt.installed_entries)) {
            installedEntries = receipt.installed_entries;
          }
        }
      } catch {
        /* fallback */
      }
    }

    // 3. 移除属于本实例的入口
    if (installedEntries.length > 0) {
      for (const entry of installedEntries) {
        if (existsSync(entry.path)) {
          try {
            rmSync(entry.path, { force: true, recursive: true });
          } catch {}
        }
      }
    } else {
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
        const localLink = join(homedir(), ".local", "bin", "devflow");
        if (existsSync(localLink)) {
          try {
            const { realpathSync } = await import("node:fs");
            const real = realpathSync(localLink);
            if (real.startsWith(binDir)) {
              rmSync(localLink, { force: true });
            }
          } catch {}
        }
        rmSync(
          join(homedir(), ".local", "share", "applications", "devflow.desktop"),
          { force: true },
        );
      }
    }

    // 4. 清理 PATH 环境变量块（Unix）
    if (process.platform !== "win32") {
      try {
        const { removeShellPathBlock } = await import(
          "../../installer/src/launchers.js"
        );
        const rc = join(
          homedir(),
          process.platform === "darwin" ? ".zshrc" : ".bashrc",
        );
        removeShellPathBlock(rc);
      } catch {}
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
