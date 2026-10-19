import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  isNativeSkillLoadingSupported,
  getRequiredSkillsForRole,
  writingAndPlanSkillInstructions,
  resolveExecutionSkillsRoot,
} from "../../packages/core/src/execution-skill-materials.js";
import {
  ALLOWED_SKILLS,
  MANAGED_WRITING_SKILLS,
  ALL_MANAGED_SKILLS,
} from "../../packages/clients/src/installer.js";

describe("A1 — 单元测试：Codex 与 AGY 技能目录、原生加载选择与阶段引用规范", () => {
  it("A1 — 原生技能加载适配器识别：Codex 与 AGY 启用原生加载，其他客户端不启用", () => {
    expect(isNativeSkillLoadingSupported("codex")).toBe(true);
    expect(isNativeSkillLoadingSupported("agy")).toBe(true);
    expect(isNativeSkillLoadingSupported("cursor")).toBe(false);
    expect(isNativeSkillLoadingSupported("claude")).toBe(false);
    expect(isNativeSkillLoadingSupported("opencode")).toBe(false);
    expect(isNativeSkillLoadingSupported("mimo")).toBe(false);
    expect(isNativeSkillLoadingSupported(undefined)).toBe(false);
  });

  it("A1 — 受管写作技能常数定义及全量受管列表完整性", () => {
    expect(MANAGED_WRITING_SKILLS).toEqual([
      "devflow-concise-complete-writing",
      "devflow-human-readable-plans",
    ]);
    expect(ALL_MANAGED_SKILLS).toEqual([
      ...ALLOWED_SKILLS,
      ...MANAGED_WRITING_SKILLS,
    ]);
    expect(ALL_MANAGED_SKILLS.length).toBe(8);
  });

  it("A1 — 各阶段与角色应载技能列表完整且符合边界", () => {
    const plannerSkills = getRequiredSkillsForRole("planner");
    expect(plannerSkills).toContain("devflow");
    expect(plannerSkills).toContain("devflow-plan");
    expect(plannerSkills).toContain("devflow-concise-complete-writing");
    expect(plannerSkills).toContain("devflow-human-readable-plans");

    const executorSkills = getRequiredSkillsForRole("executor");
    expect(executorSkills).toContain("devflow");
    expect(executorSkills).toContain("devflow-execute");
    expect(executorSkills).toContain("devflow-test");
    expect(executorSkills).toContain("devflow-concise-complete-writing");
    expect(executorSkills).toContain("devflow-human-readable-plans");

    const reviewerSkills = getRequiredSkillsForRole("reviewer");
    expect(reviewerSkills).toContain("devflow");
    expect(reviewerSkills).toContain("devflow-review");
    expect(reviewerSkills).toContain("devflow-concise-complete-writing");
    expect(reviewerSkills).toContain("devflow-human-readable-plans");

    const submitterSkills = getRequiredSkillsForRole("submitter");
    expect(submitterSkills).toContain("devflow");
    expect(submitterSkills).toContain("devflow-concise-complete-writing");
    expect(submitterSkills).toContain("devflow-human-readable-plans");
  });

  it("A1 — 方案规则不要求普通执行重新规划，普通执行不生成新计划", () => {
    expect(writingAndPlanSkillInstructions).toContain("devflow-concise-complete-writing");
    expect(writingAndPlanSkillInstructions).toContain("devflow-human-readable-plans");
    expect(writingAndPlanSkillInstructions).toContain("方案规则仅在实际编写或改写方案时应用；执行、测试、复核、整改、接管、提交、验收指导及只读提问阶段保留原计划及批准范围，不产生替代计划");
    expect(writingAndPlanSkillInstructions).toContain("先写背景、现状、目标和制定原因，再按总分结构展开总体思路");
  });

  it("A1 — 所有阶段技能文件均包含写作规范与方案规则章节", () => {
    const root = resolveExecutionSkillsRoot();
    const stageSkills = [
      "devflow",
      "devflow-plan",
      "devflow-execute",
      "devflow-test",
      "devflow-review",
      "devflow-project-onboard",
    ];

    for (const skill of stageSkills) {
      const skillPath = join(root, skill, "SKILL.md");
      expect(existsSync(skillPath)).toBe(true);
      const content = readFileSync(skillPath, "utf8");
      expect(content).toContain("写作规范与方案规则");
      expect(content).toContain("devflow-concise-complete-writing");
      expect(content).toContain("devflow-human-readable-plans");
    }
  });
});
