import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Engine } from "../../core/src/engine.js";
import { git, repositoryInfo } from "../../git/src/git.js";
import { objectHash } from "../../core/src/util.js";
import { Id, ProjectSchema, requireCondition, type Project } from "../../contracts/src/index.js";
import { BrowserRecipeSchema } from "../../runtime/src/recipe.js";

export const IntakeSchema = z.object({
  working_directory: z.string().min(1),
  request: z.string().min(1),
  title: z.string().min(1).max(160),
  conversation_id: z.string().min(1).max(256).optional(),
  workflow_id: Id.optional(),
  project_id: Id.optional(),
  intent: z.enum(["auto", "new", "continue"]).default("auto"),
  complexity: z.enum(["simple", "complex"]),
  workspace_mode: z.enum(["existing_workspace", "new_worktree"]),
  idempotency_key: Id,
}).strict();
const same = (a: string, b: string) => process.platform === "win32"
  ? a.toLowerCase() === b.toLowerCase() : a === b;

async function locate(directory: string) {
  const cwd = realpathSync(resolve(directory));
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return repositoryInfo(root);
}

export async function intake(engine: Engine, a: z.infer<typeof IntakeSchema>) {
  let current: Awaited<ReturnType<typeof locate>>;
  try { current = await locate(a.working_directory); }
  catch { return { next_action: "prepare_repository", instruction:
    "调查当前目录的 Git 状态：需要有分支及至少一个提交。向用户解释具体缺项，并在用户授权范围内补齐；不要要求用户记命令，也不要自动提交已有业务改动。" }; }
  const matches: { project: Project; repo_id: string }[] = [];
  for (const project of engine.store.list<Project>("project")) {
    for (const repo of project.repositories) {
      try {
        const info = await repositoryInfo(repo.path);
        if (same(info.common_dir, current.common_dir)) matches.push({ project, repo_id: repo.id });
      } catch { /* An unrelated offline repository must not block this project. */ }
    }
  }
  const candidates = matches.filter(m => !a.project_id || m.project.id === a.project_id);
  if (!candidates.length) return {
    next_action: "onboard", repository: current,
    suggested_project_id: "project-" + objectHash(current.common_dir.toLowerCase()).slice(0, 16),
    instruction: "自动读取项目代码、启动脚本和测试配置，执行内部接入规范。将项目配置及固定浏览器场景交给 devflow_register_project，再以相同请求调用 devflow_start。需要的端口等最小适配并入本次计划，登记不启动命令。用户只确认业务问题和完整计划，不填写 JSON。",
  };
  if (candidates.length > 1) return { next_action: "select_project",
    projects: candidates.map(m => ({ id: m.project.id, name: m.project.name })),
    instruction: "当前仓库属于多个登记项目，按名称向用户澄清，不按最近一次项目猜测。" };
  const { project, repo_id } = candidates[0]!;
  const bindingKey = a.conversation_id
    ? objectHash({ conversation: a.conversation_id, root: current.path.toLowerCase(), project: project.id }) : undefined;
  const bound = bindingKey ? engine.store.get<{ workflow_id: string }>("entry_binding", bindingKey) : undefined;
  let workflow = a.workflow_id ? engine.get(a.workflow_id) : undefined;
  if (!workflow && a.intent !== "new" && bound) workflow = engine.get(bound.workflow_id);
  if (!workflow && a.intent === "continue") {
    const active = engine.list().filter(w => w.project_id === project.id && w.state !== "COMMITTED");
    return { next_action: "select_workflow", workflows: active.map(w => ({ id: w.id, title: w.title, state: w.state })),
      instruction: "请用户按任务名称选择要继续的任务；没有候选时说明当前没有未完成任务。不要自行选择最近一次。" };
  }
  requireCondition(!workflow || workflow.project_id === project.id, "PROJECT_MISMATCH", "该任务不属于当前项目");
  if (!workflow) {
    // Read all repositories before creating anything, then use SQLite deduplication.
    const roots = Object.fromEntries(project.repositories.map(r => [r.id, r.id === repo_id ? current.path : r.path]));
    const baselines = Object.fromEntries(await Promise.all(project.repositories.map(async r =>
      [r.id, (await repositoryInfo(roots[r.id]!)).head] as const)));
    workflow = engine.create({ project_id: project.id, title: a.title, request: a.request,
      complexity: a.complexity, workspace_mode: a.workspace_mode },
      "entry-" + objectHash({ project: project.id, root: current.path, conversation: a.conversation_id, key: a.idempotency_key }));
    if (!engine.store.get("entry_context", workflow.id)) engine.store.put("entry_context", workflow.id, workflow.id, {
      roots, baselines, conversation_id: a.conversation_id, working_directory: current.path,
    });
  }
  if (bindingKey) engine.store.put("entry_binding", bindingKey, project.id, { workflow_id: workflow.id });
  workflow = engine.get(workflow.id);
  const planning = ["RESEARCHING", "REPAIR_RESEARCH_REQUIRED"].includes(workflow.state);
  return {
    next_action: planning ? "plan" : "open_workflow", workflow,
    dashboard_url: `${engine.config.server.human_origin}/?workflow=${workflow.id}`,
    project, project_config_hash: objectHash(project),
    context: engine.store.get("entry_context", workflow.id),
    instruction: planning
      ? "执行内部图解规划规范，首次适配并入同一个计划。提交后提供审批链接并结束回合。"
      : "说明当前阶段并给出控制台链接。执行中不等待、不轮询；停止/恢复/验收由用户在控制台操作。已提交任务如有新需求，使用 intent=new 和新的幂等键。",
  };
}

export const RegisterProjectSchema = z.object({
  working_directory: z.string().min(1),
  project: ProjectSchema,
  browser_recipes: z.array(BrowserRecipeSchema).default([]),
}).strict();
export async function registerIntakeProject(engine: Engine, a: z.infer<typeof RegisterProjectSchema>) {
  const current = await locate(a.working_directory);
  const repositories = await Promise.all(a.project.repositories.map(r => repositoryInfo(r.path)));
  requireCondition(repositories.some(r => same(r.common_dir, current.common_dir)),
    "PROJECT_MISMATCH", "接入配置不包含当前仓库");
  requireCondition(new Set(a.browser_recipes.map(r => r.scene_id)).size === a.browser_recipes.length,
    "DUPLICATE_SCENE", "浏览器场景重复");
  for (const recipe of a.browser_recipes) {
    const scene = a.project.browser_scenes.find(s => s.id === recipe.scene_id);
    requireCondition(recipe.project_id === a.project.id && scene &&
      recipe.actions.every(action => scene.allowed_tools.includes(action.tool)),
      "SCENE_MISMATCH", "固定浏览器动作与登记场景不一致");
  }
  requireCondition(a.project.browser_scenes.every(s => a.browser_recipes.some(r => r.scene_id === s.id)),
    "SCENE_RECIPE_REQUIRED", "每个浏览器验收场景都需要固定动作与断言");
  const project = { ...a.project, browser_recipe_hashes:
    Object.fromEntries(a.browser_recipes.map(r => [r.scene_id, objectHash(r)])) };
  const result = await engine.registerProject(project);
  engine.store.transaction(() => {
    for (const recipe of a.browser_recipes) engine.store.put("browser_recipe", `${project.id}-${recipe.scene_id}`, project.id,
      { ...recipe, project_hash: result.config_hash });
  });
  return { ...result, next_action: "start", instruction: "接入信息已保存，尚未执行命令。继续原需求的 devflow_start 和计划；将实际启动方式、数据环境和适配范围写入审批正文。" };
}
