import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { batchExecutionInstructions } from "../../packages/core/src/execution-guidance.js";
import {
  resolveExecutionSkillsRoot,
  getExecutionSkillResources,
  getExecutionSkillFilePaths,
  shouldIncludeExecutionTestingSkill,
  EXECUTION_TESTING_RESOURCE_PATHS,
  REAL_BROWSER_VERIFICATION_PROMPT,
} from "../../packages/core/src/execution-skill-materials.js";

describe("U06 — 执行期 Skill 材料装配与用途覆盖矩阵", () => {
  it("定位并解析 Skill 根目录，验证所有必备资源存在", () => {
    const root = resolveExecutionSkillsRoot();
    expect(root).toBeTruthy();
    expect(existsSync(root)).toBe(true);

    const paths = getExecutionSkillFilePaths();
    for (const relPath of EXECUTION_TESTING_RESOURCE_PATHS) {
      const p = paths[relPath];
      expect(p).toBeTruthy();
      expect(existsSync(p!)).toBe(true);
    }
  });

  it("读取完整的 Skill 资源内容，验证包含核心规则正文", () => {
    const resources = getExecutionSkillResources();

    // 验证包含 devflow-test 与 devflow-execute
    expect(resources["devflow-test/SKILL.md"]).toContain("devflow-test");
    expect(resources["devflow-test/references/real-browser-verification.md"]).toContain(
      "OpenTabs",
    );
    expect(resources["devflow-test/references/local-auth-strategy.md"]).toContain(
      "免密",
    );
    expect(resources["devflow-test/references/browser-verification-record.md"]).toContain(
      "真实浏览器核验记录",
    );
    expect(resources["devflow-execute/references/user-interaction.md"]).toContain(
      "人机交互",
    );
    expect(
      resources["devflow-execute/references/worktree-local-environment.md"],
    ).toContain("端口");
  });

  it("覆盖矩阵验证：执行与修复用途必须注入测试 Skill", () => {
    // 首次执行、执行恢复、测试专修、功能修复
    expect(shouldIncludeExecutionTestingSkill("implement")).toBe(true);
    expect(shouldIncludeExecutionTestingSkill("execute")).toBe(true);
    expect(shouldIncludeExecutionTestingSkill("executor_test")).toBe(true);
    expect(shouldIncludeExecutionTestingSkill("functional_fix")).toBe(true);
    expect(shouldIncludeExecutionTestingSkill("repair")).toBe(true);
    expect(shouldIncludeExecutionTestingSkill("functional_repair")).toBe(true);
    expect(shouldIncludeExecutionTestingSkill("test")).toBe(true);

    // 当指定 executor 角色时
    expect(shouldIncludeExecutionTestingSkill(undefined, "executor")).toBe(true);
  });

  it("覆盖矩阵验证：规划、复核与提交阶段绝不追加测试职责", () => {
    // 规划接管：不让规划角色跑测试，保留回归提示交执行角色
    expect(shouldIncludeExecutionTestingSkill("planner_takeover")).toBe(false);
    expect(shouldIncludeExecutionTestingSkill("planning")).toBe(false);
    expect(shouldIncludeExecutionTestingSkill(undefined, "planner")).toBe(false);

    // 质量审查：只保留审查边界，不要求审计或重跑浏览器验证
    expect(shouldIncludeExecutionTestingSkill("quality_review")).toBe(false);
    expect(shouldIncludeExecutionTestingSkill("review")).toBe(false);
    expect(shouldIncludeExecutionTestingSkill(undefined, "reviewer")).toBe(false);

    // 提交阶段：不新增测试
    expect(shouldIncludeExecutionTestingSkill("planner_commit")).toBe(false);

    // 即使 purpose 传了 implement，但角色是 planner 或 reviewer 时也绝不追加
    expect(shouldIncludeExecutionTestingSkill("implement", "planner")).toBe(false);
    expect(shouldIncludeExecutionTestingSkill("implement", "reviewer")).toBe(false);
  });

  it("核心提示词包含统一真实浏览器核验与通用人机交互措辞", () => {
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("三层组织");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("OpenTabs");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("分别使用 e2e 和 opentabs 层级");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("不得合并或互相替代");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("user_interaction");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("临时配置绝不提交");
  });

  it("actual injected test skill retains all four requested responsibilities and only resumes missing work", () => {
    const material = getExecutionSkillResources()["devflow-test/SKILL.md"]!;
    expect(material).toContain("单元 → 集成 → E2E → OpenTabs 真实浏览器测试");
    expect(material).toContain("用户原文与已批准计划优先");
    expect(material).toContain("E2E 的 passed、skipped 或不适用说明只属于 E2E");
    expect(material).toContain("实际操作现有 OpenTabs 工具连接的真实浏览器后说明结果");
    expect(material).toContain("不为补第四项重跑前三项");
    expect(material).toContain("不要求生成证明材料，不增加平台校验");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("E2E 的通过或跳过不代表 OpenTabs 已完成或不适用");
    expect(REAL_BROWSER_VERIFICATION_PROMPT).toContain("只补尚未完成的项目");
    expect(batchExecutionInstructions).toContain(REAL_BROWSER_VERIFICATION_PROMPT);
    expect(batchExecutionInstructions).toContain("不凭提示词宣称工具一定可用");
    expect(getExecutionSkillResources()["devflow-execute/SKILL.md"]).toContain("E2E 的 passed/skipped 不改变 OpenTabs 状态");
    const planning = readFileSync(join(resolveExecutionSkillsRoot(), "devflow-plan/SKILL.md"), "utf8");
    expect(planning).toContain("在计划正文分别列出四项责任与预期结果");
    expect(planning).toContain("仅安排缺项或实际受影响的回归");
  });
});
