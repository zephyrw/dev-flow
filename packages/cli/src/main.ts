import {
  readFileSync,
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { z } from "zod";
import { PlanSchema, ReviewSchema } from "../../contracts/src/index.js";
import { validatePlan } from "../../plans/src/validate.js";
import { parsePlanDiagrams } from "../../plans/src/diagrams.js";
import { ConfigSchema, loadConfig } from "../../contracts/src/config.js";
import { Store } from "../../store/src/store.js";
import { Engine } from "../../core/src/engine.js";
import { LocalRuntime } from "../../runtime/src/runtime.js";
import { atomicWrite, hash, objectHash, now } from "../../core/src/util.js";
import { ProjectSchema, requireCondition } from "../../contracts/src/index.js";
import { BrowserRecipeSchema } from "../../runtime/src/recipe.js";
import { executablePath } from "../../process/src/executable.js";
import {
  resumeApproved,
  reconcileProcesses,
} from "../../runtime/src/recovery.js";
import {
  createBackup,
  verifyBackup,
  restoreBackup,
  archiveLogs,
} from "../../runtime/src/maintenance.js";
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const config = loadConfig(process.env.DEVFLOW_CONFIG);
async function main() {
  if (command === "help") {
    console.log(
      `DevFlow 本地工作流\n\n  init                         写入示例配置（不覆盖）\n  doctor                       检查运行环境，不调用模型\n  pair                         旧命令：提示直接打开工作台\n  planner-token                生成 Codex MCP 专用令牌和配置片段\n  project <config.json>        导入受信任项目配置\n  browser-recipe <json>        导入固定 OpenTabs 场景和断言\n  skills <destination>         安装 DevFlow Skill（不覆盖已有目录）\n  backup <directory>           一致性数据库与证据备份\n  verify-backup <directory>    校验备份文件内容哈希\n  recover <workflow-id>        核实退出后恢复已批准工作流排队\n  retry-commit <workflow-id>   重试同一快照的部分提交\n\n服务：pnpm run build && pnpm start\n配置：DEVFLOW_CONFIG 环境变量指向 YAML。开发时不启动任何模型。`,
    );
    console.log(
      "\n  schema <kind>                输出 config/project/plan/review/browser-recipe Schema\n  validate-plan <json>         校验计划结构、任务关系及 Mermaid\n  restore <backup> <storage>   恢复到原始且不存在的状态目录\n  archive-logs                压缩过期日志并验证完整性",
    );
    return;
  }
  if (command === "init") {
    const file = resolve("devflow.yaml");
    requireCondition(!existsSync(file), "EXISTS", "配置文件已存在");
    const c = ConfigSchema.parse({ schema_version: 2 });
    atomicWrite(file, stringify(c));
    console.log(file);
    return;
  }
  if (command === "schema") {
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
    return;
  }
  if (command === "validate-plan") {
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
    return;
  }
  if (command === "doctor") {
    const result: any = {
      node: process.version,
      platform: process.platform,
      storage: config.storage_root,
      checks: [],
    };
    for (const [name, exe, argv] of [
      ["git", "git", ["--version"]],
      ["agy", config.models.agy_executable, ["--version"]],
      ["codex", config.models.codex_executable, ["--version"]],
    ] as const) {
      try {
        result.checks.push({
          name,
          ok: true,
          output: execFileSync(executablePath(exe), [...argv], {
            windowsHide: true,
            encoding: "utf8",
            timeout: 10000,
          }).trim(),
        });
      } catch (e) {
        result.checks.push({ name, ok: false, message: String(e) });
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "skills") {
    requireCondition(args[1], "ARGUMENT", "需要目标目录");
    const target = resolve(args[1]);
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(resolve("packages/skills"))) {
      const dest = join(target, name);
      requireCondition(
        !existsSync(dest),
        "EXISTS",
        `已存在 ${dest}；请先审查版本差异`,
      );
    }
    for (const name of readdirSync(resolve("packages/skills")))
      cpSync(resolve("packages/skills", name), join(target, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    console.log("DevFlow Skill 已安装到 " + target);
    return;
  }
  if (command === "verify-backup") {
    requireCondition(args[1], "ARGUMENT", "缺少备份路径");
    console.log(JSON.stringify({ files: verifyBackup(args[1]).files.length }));
    return;
  }
  if (command === "restore") {
    requireCondition(
      args[1] && args[2],
      "ARGUMENT",
      "用法 restore <backup> <original-storage-root>",
    );
    console.log(JSON.stringify(restoreBackup(args[1], args[2])));
    return;
  }
  const unlock = ["recover", "retry-commit"].includes(command)
    ? await (
        await import("../../process/src/controller-lock.js")
      ).acquireControllerLock(config.storage_root)
    : undefined;
  const store = new Store(join(config.storage_root, "devflow.sqlite"));
  const engine = new Engine(store, config);
  try {
    if (command === "pair") {
      console.log(
        `DevFlow 已取消登录和配对，直接打开 ${config.server.human_origin} 即可。`,
      );
    } else if (command === "planner-token") {
      const token = engine.auth.issue({ role: "planner" }, 365 * 86400000);
      const file = join(config.storage_root, "codex-planner-token.txt");
      atomicWrite(file, token);
      const snippet = `[mcp_servers.devflow]\nurl = "http://127.0.0.1:${config.server.port}/mcp"\nbearer_token_env_var = "DEVFLOW_PLANNER_TOKEN"\n`;
      const target = join(config.storage_root, "codex-mcp.toml");
      atomicWrite(target, snippet);
      console.log(
        `令牌文件：${file}\n配置片段：${target}\n将令牌设置到启动 Codex 的进程环境中，再把片段合并进 Codex 配置。`,
      );
    } else if (command === "project") {
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
    } else if (command === "browser-recipe") {
      const recipe = BrowserRecipeSchema.parse(
        JSON.parse(readFileSync(args[1]!, "utf8")),
      );
      const p = engine.project(recipe.project_id);
      requireCondition(
        p.browser_scenes.some((s) => s.id === recipe.scene_id),
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
    } else if (command === "backup") {
      requireCondition(args[1], "ARGUMENT", "缺少备份路径");
      console.log(JSON.stringify(await createBackup(engine, args[1])));
    } else if (command === "archive-logs") {
      console.log(JSON.stringify(archiveLogs(engine)));
    } else if (command === "recover") {
      requireCondition(args[1], "ARGUMENT", "缺少工作流编号");
      console.log(JSON.stringify(resumeApproved(engine, args[1]), null, 2));
    } else if (command === "retry-commit") {
      requireCondition(args[1], "ARGUMENT", "缺少工作流编号");
      reconcileProcesses(engine, args[1]);
      console.log(JSON.stringify(await engine.retryCommit(args[1]), null, 2));
    } else throw new Error("未知命令。运行 pnpm run cli help");
  } finally {
    store.close();
    await unlock?.();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
