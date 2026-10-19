import { describe, it, expect } from "vitest";
import {
  isNativeSkillLoadingSupported,
  getRequiredSkillsForRole,
  getExecutionSkillResources,
  getExecutionSkillFilePaths,
} from "../../packages/core/src/execution-skill-materials.js";
import {
  reviewSkillResources,
  reviewSkillFilePaths,
} from "../../packages/runtime/src/review-materials.js";
import {
  planningWritingInstructions,
  executionScopeInstructions,
  reviewScopeInstructions,
  writingAndPlanSkillInstructions,
} from "../../packages/core/src/role-boundaries.js";

describe("A3 — 集成测试：规划到提交各阶段原生引用、旧入口按需读取与角色合同完整性", () => {
  it("A3 — Codex 与 AGY 原生入口不传 skill_resources 与 skill 重复全文，但包含 skills 与 skill_paths", () => {
    for (const adapter of ["codex", "agy"]) {
      const isNative = isNativeSkillLoadingSupported(adapter);
      expect(isNative).toBe(true);

      // 1. 执行/测试阶段
      const executorSkills = getRequiredSkillsForRole("executor", "implement");
      expect(executorSkills).toContain("devflow-concise-complete-writing");
      expect(executorSkills).toContain("devflow-human-readable-plans");
      expect(executorSkills).toContain("devflow-execute");
      expect(executorSkills).toContain("devflow-test");

      const execPaths = getExecutionSkillFilePaths();
      expect(Object.keys(execPaths).length).toBeGreaterThan(0);
      for (const p of Object.values(execPaths)) {
        expect(p).toBeTruthy();
      }

      // 2. 复核阶段
      const reviewerSkills = getRequiredSkillsForRole("reviewer", "quality_review");
      expect(reviewerSkills).toContain("devflow-concise-complete-writing");
      expect(reviewerSkills).toContain("devflow-human-readable-plans");
      expect(reviewerSkills).toContain("devflow-review");

      const revPaths = reviewSkillFilePaths();
      expect(Object.keys(revPaths).length).toBeGreaterThan(0);
      for (const p of Object.values(revPaths)) {
        expect(p).toBeTruthy();
      }

      // 3. 规划与接管阶段
      const plannerSkills = getRequiredSkillsForRole("planner", "planning");
      expect(plannerSkills).toContain("devflow-concise-complete-writing");
      expect(plannerSkills).toContain("devflow-human-readable-plans");
      expect(plannerSkills).toContain("devflow-plan");

      // 4. 提交阶段
      const submitterSkills = getRequiredSkillsForRole("submitter", "planner_commit");
      expect(submitterSkills).toContain("devflow-concise-complete-writing");
      expect(submitterSkills).toContain("devflow-human-readable-plans");
    }
  });

  it("A3 — 非原生/旧限制入口保留按需读取能力与完整技能正文资源", () => {
    expect(isNativeSkillLoadingSupported("cursor")).toBe(false);
    expect(isNativeSkillLoadingSupported(undefined)).toBe(false);

    // 旧入口及非原生环境下，支持按需读取全量 skill_resources
    const execResources = getExecutionSkillResources();
    expect(execResources["devflow-test/SKILL.md"]).toBeTruthy();
    expect(execResources["devflow-execute/SKILL.md"]).toBeTruthy();

    const revResources = reviewSkillResources();
    expect(revResources["devflow-review/SKILL.md"]).toBeTruthy();
    expect(revResources["devflow/references/role-and-schedule.md"]).toBeTruthy();
  });

  it("A3 — 角色安全合同与职责边界完整性：各阶段指令包含必要角色约束且方案规则不越界", () => {
    // 规划写作指导
    expect(planningWritingInstructions).toContain("先写背景与现状，再写目标");
    expect(planningWritingInstructions).toContain("devflow-concise-complete-writing");
    expect(planningWritingInstructions).toContain("devflow-human-readable-plans");
    expect(planningWritingInstructions).toContain("方案规则仅在实际编写或改写方案时应用；执行、测试、复核、整改、接管、提交、验收指导及只读提问阶段保留原计划及批准范围，不产生替代计划");

    // 执行阶段指令
    expect(executionScopeInstructions).toContain("按用户当前需求及批准计划完成实现，保留原目标、关键设计、公共契约、明确范围和验收要求，不另建替代计划");
    expect(executionScopeInstructions).toContain("devflow-concise-complete-writing");
    expect(executionScopeInstructions).toContain("devflow-human-readable-plans");

    // 审查阶段指令
    expect(reviewScopeInstructions).toContain("你负责本次需求和变更的代码质量");
    expect(reviewScopeInstructions).toContain("devflow-concise-complete-writing");
    expect(reviewScopeInstructions).toContain("devflow-human-readable-plans");

    // 全局注入的写作与计划规则约束
    expect(writingAndPlanSkillInstructions).toContain("devflow-concise-complete-writing");
    expect(writingAndPlanSkillInstructions).toContain("devflow-human-readable-plans");
  });
});
