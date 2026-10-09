/**
 * DevFlow user CLI.
 *
 * Parse the command first and load business modules only when needed so that
 * --help / --version keep working when config or database is damaged.
 */
import {
  readFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  rmSync,
  openSync,
  closeSync,
  writeFileSync,
  statSync,
} from "node:fs";
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
const command =
  args[0] && !args[0].startsWith("-")
    ? args[0]
    : args[0] === "help"
      ? "help"
      : args[0];

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
  devflow accounts         打开 AGY 账号管理，仅必要启动
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

async function commandOpen(mode: "full" | "accounts" = "full"): Promise<number> {
  const { openBrowser } = await import("../../service/src/launcher.js");
  const result = await openBrowser(mode);
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
    installedVersion = String(
      pointer.application_version ?? pointer.version ?? "unknown",
    );
  } catch {
    /* keep 未安装 */
  }
  try {
    const state = JSON.parse(
      readFileSync(join(ctx.installRoot, "state.json"), "utf8"),
    );
    setupStatus =
      state?.result?.setup?.status ??
      state?.result?.software?.status ??
      "unknown";
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
    existsSync(bundledNode)
      ? bundledNode
      : existsSync(bootstrapNode)
        ? bootstrapNode
        : undefined,
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
    add(
      "build-identity",
      Boolean(health?.application_version || health?.build_revision),
    );
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

function readControllerRecord(
  storageRoot: string,
): ControllerRecord | undefined {
  const file = join(storageRoot, "controller-process.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1)
    throw new Error("INVALID_CONTROLLER_PID");
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function commandStop(): Promise<number> {
  const ctx = getInstallationContext();
  const config = await loadConfigSafe();
  const record = readControllerRecord(config.storage_root);
  if (!record) {
    console.log("没有正在运行的 DevFlow 服务记录。");
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  const canonical = (p: string) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  const expectedEntries = ["main.js", "accounts-main.js"].map((p) =>
    canonical(join(ctx.versionRoot, "dist/apps/api/src", p)),
  );
  if (
    typeof record.entry !== "string" ||
    !expectedEntries.includes(canonical(record.entry))
  )
    throw new Error("进程记录不属于此 DevFlow 安装，未停止任何程序。");
  if (!processAlive(record.pid)) {
    console.log("服务已退出。");
    return INSTALL_EXIT_CODES.SUCCESS;
  }
  const native = await (
    await import("../../process/src/native/index.js")
  ).getNativeAsync();
  const creation = native.getProcessCreationTime(record.pid);
  if (creation == null || String(creation) !== record.started)
    throw new Error(
      "无法确认控制器进程身份，拒绝停止；请从原服务窗口安全退出。",
    );
  const { hash } = await import("../../core/src/util.js");
  const health = await fetch(
    `http://127.0.0.1:${config.server.port}/api/health`,
    {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    },
  );
  const identity = (await health.json()) as Record<string, unknown>;
  if (
    !health.ok ||
    identity.service !== "devflow" ||
    identity.instance !== hash(resolve(config.storage_root).toLowerCase()) ||
    typeof identity.runtime_root !== "string" ||
    canonical(identity.runtime_root) !== canonical(ctx.versionRoot)
  )
    throw new Error("服务身份不匹配，未发送停机请求。");
  const { readMaintenanceMarker, clearMaintenanceMarker } = await import(
    "../../installer/src/transaction.js"
  );
  if (readMaintenanceMarker(config.storage_root))
    throw new Error("存在维护事务，请先完成或恢复该事务。");
  const transactionId = "stop-" + crypto.randomUUID();
  let safeToClear = false;
  try {
    const response = await fetch(
      `http://127.0.0.1:${config.server.port}/api/maintenance/quiesce`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(75000),
        headers: {
          "content-type": "application/json",
          origin: config.server.human_origin,
        },
        body: JSON.stringify({
          on_active_tasks: "wait",
          shutdown: true,
          transaction_id: transactionId,
        }),
      },
    );
    if (!response.ok || !(await response.json() as { can_quiesce?: boolean }).can_quiesce) {
      safeToClear = true;
      throw new Error("服务仍有活动任务或不支持安全停机，未强制结束。");
    }
    for (let i = 0; i < 150; i++) {
      const current = native.getProcessCreationTime(record.pid);
      if (
        current == null ||
        String(current) !== record.started ||
        !processAlive(record.pid)
      ) {
        safeToClear = true;
        console.log("DevFlow 服务已停止。");
        return INSTALL_EXIT_CODES.SUCCESS;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("服务未在时限内退出，未强制结束，请检查受管任务。");
  } finally {
    if (readMaintenanceMarker(config.storage_root)?.transaction_id === transactionId) {
      if (safeToClear) clearMaintenanceMarker(config.storage_root);
      else {
        const { updateMaintenanceMarker } = await import("../../installer/src/transaction.js");
        updateMaintenanceMarker(config.storage_root, { phase: "recovery_required" });
      }
    }
  }
}

async function commandUpdate(): Promise<number> {
  const ctx = getInstallationContext();
  const { UpgradeManager } = await import("../../installer/src/upgrade.js");
  const config = await loadConfigSafe();
  const storageRoot = config?.storage_root
    ? resolve(dirname(ctx.configPath), config.storage_root)
    : ctx.storageRoot;
  const serviceOrigin =
    config?.server?.human_origin ??
    `http://127.0.0.1:${config?.server?.port ?? 4810}`;

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
      console.log(
        `当前版本 ${currentVersion}。尚未检查远程更新；请使用正式安装脚本，或通过 --source 指定更新包。`,
      );
      return INSTALL_EXIT_CODES.SUCCESS;
    }
    throw new Error(
      `请使用 --source 指定更新包路径或通过正式安装脚本执行更新。`,
    );
  }

  if (!targetVersion) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(sourceDir, "package.json"), "utf8"),
      );
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
        console.error(
          `更新被阻止：${result.error?.message ?? "存在运行中的活跃任务"}`,
        );
        return INSTALL_EXIT_CODES.NEEDS_USER_ACTION;
      case "safe_abort":
        console.error(
          `更新未完成并已安全撤销修改：${result.error?.message ?? "未知错误"}`,
        );
        return INSTALL_EXIT_CODES.DOWNLOAD_VERIFICATION_FAILED;
      case "recovery_required":
        console.error(
          `更新中断并保留现场，需进行恢复：${result.error?.message}`,
        );
        console.error(
          "恢复动作建议：" +
            (result.recovery_actions.join(", ") || "请运行 devflow doctor"),
        );
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
  const { readFileSync, lstatSync, readlinkSync } = await import("node:fs");
  const { rmdirSync } = await import("node:fs");
  const { hash } = await import("../../core/src/util.js");
  const {
    removeShellPathBlock,
    readWindowsUserPathFromRegistry,
    writeWindowsUserPathToRegistry,
  } = await import("../../installer/src/launchers.js");
  const receiptFile = join(ctx.installRoot, "entry-receipt.json");
  if (!existsSync(receiptFile)) {
    console.error(
      "缺少可验证的入口收据，已保留现有文件；请先用新安装器修复安装。",
    );
    return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
  }
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
  const canonical = (p: string) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  if (
    typeof receipt.install_root !== "string" ||
    canonical(receipt.install_root) !== canonical(ctx.installRoot) ||
    !Array.isArray(receipt.installed_entries)
  )
    throw new Error("入口收据无效");
  const code = await commandStop();
  if (code !== INSTALL_EXIT_CODES.SUCCESS) return code;
  const binDir = join(ctx.installRoot, "bin");
  const allowed = new Set(
    [
      join(binDir, process.platform === "win32" ? "devflow.cmd" : "devflow"),
      join(ctx.installRoot, "open-accounts.ps1"),
      join(ctx.installRoot, "打开 AGY 账号管理.vbs"),
      ...(process.platform === "win32"
        ? [
            join(
              homedir(),
              "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/DevFlow/DevFlow.cmd",
            ),
          ]
        : [
            join(homedir(), ".local/bin/devflow"),
            join(homedir(), ".local/share/applications/devflow.desktop"),
          ]),
      ...(process.platform === "darwin" ? [
        join(homedir(), "Applications/DevFlow.app/Contents/Info.plist"),
        join(homedir(), "Applications/DevFlow.app/Contents/MacOS/DevFlow"),
        join(ctx.installRoot, "打开 AGY 账号管理.app/Contents/Info.plist"),
        join(ctx.installRoot, "打开 AGY 账号管理.app/Contents/MacOS/DevFlowAccounts"),
      ] : []),
    ].map(canonical),
  );
  const preserved: string[] = [];
  const remove: string[] = [];
  for (const entry of receipt.installed_entries) {
    if (typeof entry.path !== "string" || !allowed.has(canonical(entry.path)))
      throw new Error("入口收据包含未授权的删除路径");
    try {
      const stat = lstatSync(entry.path);
      const owned =
        entry.kind === "symlink"
          ? stat.isSymbolicLink() && readlinkSync(entry.path) === entry.target
          : stat.isFile() &&
            !stat.isSymbolicLink() &&
            entry.hash === hash(readFileSync(entry.path));
      if (owned) remove.push(entry.path);
      else preserved.push(entry.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const file of remove) rmSync(file, { force: true });
  if (process.platform === "darwin") {
    for (const bundle of [join(homedir(), "Applications/DevFlow.app"), join(ctx.installRoot, "打开 AGY 账号管理.app")]) {
      if (!remove.some(file => file.startsWith(bundle + "/"))) continue;
      for (const dir of [join(bundle, "Contents/MacOS"), join(bundle, "Contents"), bundle]) {
        try { if (!lstatSync(dir).isSymbolicLink()) rmdirSync(dir); } catch (error) {
          if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      }
    }
  }
  if (receipt.path_added === binDir && !preserved.length) {
    if (process.platform === "win32") {
      const current = readWindowsUserPathFromRegistry();
      if (current === undefined)
        throw new Error("无法读取用户 PATH，未清理 PATH");
      const next = current
        .split(";")
        .filter((p) => !p.trim() || canonical(p.trim()) !== canonical(binDir))
        .join(";");
      if (next !== current) writeWindowsUserPathToRegistry(next);
    } else {
      const rc = join(
        homedir(),
        process.platform === "darwin" ? ".zshrc" : ".bashrc",
      );
      removeShellPathBlock(rc, binDir);
    }
  }
  if (preserved.length) {
    console.error("已保留用户修改过的入口：" + preserved.join("、"));
    return INSTALL_EXIT_CODES.CONFIGURATION_CONFLICT;
  }
  console.log("已移除 DevFlow 应用入口。项目、任务数据与用户凭据已保留。");
  return INSTALL_EXIT_CODES.SUCCESS;
}

async function commandAdvanced(name: string): Promise<number> {
  const config = await loadConfigSafe();
  const { stringify } = await import("yaml");
  const { z } = await import("zod");
  const { PlanSchema, ReviewSchema, ProjectSchema } = await import(
    "../../contracts/src/index.js"
  );
  const { validatePlan } = await import("../../plans/src/validate.js");
  const { parsePlanDiagrams } = await import("../../plans/src/diagrams.js");
  const { ConfigSchema } = await import("../../contracts/src/config.js");
  const { Store } = await import("../../store/src/store.js");
  const { Engine } = await import("../../core/src/engine.js");
  const { atomicWrite, hash, objectHash } = await import(
    "../../core/src/util.js"
  );
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
    for (const file of readdirSync(
      join(getInstallationContext().versionRoot, "packages/skills"),
    )) {
      const dest = join(target, file);
      requireCondition(
        !existsSync(dest),
        "EXISTS",
        `已存在 ${dest}；请先审查版本差异`,
      );
    }
    for (const file of readdirSync(
      join(getInstallationContext().versionRoot, "packages/skills"),
    ))
      cpSync(
        join(getInstallationContext().versionRoot, "packages/skills", file),
        join(target, file),
        {
          recursive: true,
          errorOnExist: true,
          force: false,
        },
      );
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
          await engine.registerProject(
            JSON.parse(readFileSync(args[1], "utf8")),
          ),
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
  if (command === "accounts") return commandOpen("accounts");
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
