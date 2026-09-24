import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireCondition } from "../../contracts/src/index.js";

export const EXECUTION_TESTING_RESOURCE_PATHS = [
  "devflow-test/SKILL.md",
  "devflow-test/references/real-browser-verification.md",
  "devflow-test/references/local-auth-strategy.md",
  "devflow-test/references/browser-verification-record.md",
  "devflow-execute/SKILL.md",
  "devflow-execute/references/user-interaction.md",
  "devflow-execute/references/worktree-local-environment.md",
  "devflow/references/role-and-schedule.md",
] as const;

export const REAL_BROWSER_VERIFICATION_PROMPT =
  "自动测试仍按单元、集成、E2E 三层组织；存在前端影响时，执行模型还必须额外使用 OpenTabs 完成一轮仿人工真实浏览器核验。这是执行职责，不是工作流新增阶段或平台验收门槛。" +
  "普通本地场景免密优先；确需人工介入时发出 user_interaction 并暂停等待；新 worktree 端口独立且临时配置绝不提交。详细浏览器核验规则请查阅 devflow-test 与 devflow-execute Skill。";

/**
 * 解析并定位 devflow-test / devflow-execute 所在根目录。
 * 兼容源码开发、构建后产物以及安装目录。
 */
export function resolveExecutionSkillsRoot(overrideDir?: string): string {
  if (overrideDir && existsSync(resolve(overrideDir, "devflow-test/SKILL.md"))) {
    return overrideDir;
  }
  if (
    process.env.DEVFLOW_SKILLS_DIR &&
    existsSync(resolve(process.env.DEVFLOW_SKILLS_DIR, "devflow-test/SKILL.md"))
  ) {
    return process.env.DEVFLOW_SKILLS_DIR;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const dir = dirname(currentFile);

  const candidates = [
    resolve(dir, "../../skills"),
    resolve(dir, "../skills"),
    resolve(dir, "../../../packages/skills"),
    resolve(dir, "../../../../packages/skills"),
    resolve(process.cwd(), "packages/skills"),
  ];

  const root = candidates.find((candidate) =>
    existsSync(resolve(candidate, "devflow-test/SKILL.md")),
  );

  requireCondition(
    root,
    "SKILL_MISSING",
    "缺少 devflow-test 或 devflow-execute Skill 资源",
  );

  return root!;
}

/**
 * 获取执行期真实浏览器核验与通用人机交互的 Skill Markdown 内容字典。
 */
export function getExecutionSkillResources(overrideDir?: string): Record<string, string> {
  const root = resolveExecutionSkillsRoot(overrideDir);
  return Object.fromEntries(
    EXECUTION_TESTING_RESOURCE_PATHS.map((relPath) => [
      relPath,
      readFileSync(resolve(root, relPath), "utf8"),
    ]),
  );
}

/**
 * 获取执行期所需 Skill 资源的绝对物理路径字典。
 */
export function getExecutionSkillFilePaths(overrideDir?: string): Record<string, string> {
  const root = resolveExecutionSkillsRoot(overrideDir);
  return Object.fromEntries(
    EXECUTION_TESTING_RESOURCE_PATHS.map((relPath) => [
      relPath,
      resolve(root, relPath),
    ]),
  );
}

/**
 * 依据用途 (purpose) 与角色 (role) 判定是否应注入执行与测试 Skill 材料。
 * 严格对齐覆盖矩阵：
 * - implement / execute / executor_test / functional_fix / repair: true
 * - planner_takeover: false (规划角色不跑测试，交执行角色)
 * - quality_review / review: false (复核角色不审计或重跑浏览器核验)
 * - planner_commit: false (提交阶段不新增测试)
 */
export function shouldIncludeExecutionTestingSkill(
  purpose?: string,
  role?: string,
): boolean {
  if (role === "planner" || role === "reviewer") {
    return false;
  }

  const normalizedPurpose = (purpose ?? "").trim().toLowerCase();
  if (!normalizedPurpose) {
    return role === "executor" || role === undefined;
  }

  switch (normalizedPurpose) {
    case "implement":
    case "execute":
    case "executor_test":
    case "functional_fix":
    case "repair":
    case "functional_repair":
    case "test":
      return true;

    case "planner_takeover":
    case "planner_commit":
    case "planning":
    case "quality_review":
    case "review":
      return false;

    default:
      return role === "executor";
  }
}
