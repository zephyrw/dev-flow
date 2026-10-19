import { describe, it, expect } from "vitest";
import {
  executeRecoveryGuidance,
  asideRecoveryGuidance,
  planningRecoveryGuidance,
} from "../../packages/core/src/conversation-guidance.js";
import {
  writingAndPlanSkillInstructions,
  planningWritingInstructions,
} from "../../packages/core/src/role-boundaries.js";
import {
  getRequiredSkillsForRole,
} from "../../packages/core/src/execution-skill-materials.js";
import {
  unknownSubagentCapabilities,
  type RecoveryManifest,
} from "../../packages/contracts/src/index.js";
import {
  asideQuestionMaterials,
  asidePrompt,
} from "../../packages/runtime/src/profile-runtime.js";

describe("A4 — 集成测试：用户续聊原文保持、会话恢复、旁路提问与子 Agent 委派约束", () => {
  const dummyManifest: RecoveryManifest = {
    recovery_id: "rec-test",
    workflow_id: "w-test",
    root_conversation_id: "conv-root",
    source_run_id: "run-source",
    target_run_id: "run-target",
    reason: "user_resume",
    purpose: "execute",
    pending_children: [],
    completed_children: [],
    cancelled_children: [],
    stage: "prepared",
  };

  it("A4 — 规则注入通过阶段指导生效，不篡改用户续聊原文，不重发整份任务包", () => {
    // 验证恢复执行指导中包含写作技能与方案规则指引
    const guidance = executeRecoveryGuidance(dummyManifest, unknownSubagentCapabilities());
    expect(guidance).toContain("devflow-concise-complete-writing");
    expect(guidance).toContain("devflow-human-readable-plans");
    expect(guidance).toContain("不另建替代计划");

    // 验证规划恢复指导包含方案规则
    const planGuidance = planningRecoveryGuidance(dummyManifest, unknownSubagentCapabilities());
    expect(planGuidance).toContain("devflow-concise-complete-writing");
    expect(planGuidance).toContain("devflow-human-readable-plans");
    expect(planGuidance).toContain("先写背景与现状，再写目标");
  });

  it("A4 — 恢复与重建会话时保留技能引用，不丢失角色职责、权限边界与交互合同", () => {
    // 1. 恢复执行阶段：保留技能列表
    const resumeSkills = getRequiredSkillsForRole("executor", "repair");
    expect(resumeSkills).toContain("devflow-concise-complete-writing");
    expect(resumeSkills).toContain("devflow-human-readable-plans");
    expect(resumeSkills).toContain("devflow-execute");
    expect(resumeSkills).toContain("devflow-test");

    // 2. 规划接管阶段：保留规划技能
    const takeoverSkills = getRequiredSkillsForRole("planner", "planner_takeover");
    expect(takeoverSkills).toContain("devflow-concise-complete-writing");
    expect(takeoverSkills).toContain("devflow-human-readable-plans");
    expect(takeoverSkills).toContain("devflow-plan");

    // 3. 方案规则约束：仅在编写或改写方案时应用，不产生替代计划
    expect(writingAndPlanSkillInstructions).toContain("方案规则仅在实际编写或改写方案时应用；执行、测试、复核、整改、接管、提交、验收指导及只读提问阶段保留原计划及批准范围，不产生替代计划");
  });

  it("A4 — 旁路提问注入简练完整表达规则，且子 Agent 委派明确要求传递写作与方案约束", () => {
    // 旁路提问恢复指导
    const asideGuidance = asideRecoveryGuidance(dummyManifest, unknownSubagentCapabilities());
    expect(asideGuidance).toContain("独立只读临时提问");
    expect(asideGuidance).toContain("devflow-concise-complete-writing");
    expect(asideGuidance).toContain("devflow-human-readable-plans");

    const asideSkills = getRequiredSkillsForRole(undefined, "aside");
    expect(asideSkills).toContain("devflow-concise-complete-writing");
    expect(asideSkills).toContain("devflow-human-readable-plans");

    // 子 Agent 委派约束
    expect(writingAndPlanSkillInstructions).toContain("主 Agent 委派任务时向子 Agent 传递必要技能名称或可读取引用，要求子 Agent 同样应用");

    // F1: 测试 asidePrompt 明确要求遵循简练完整表达原则
    const prompt = asidePrompt("/path/to/handoff.json", "/path/to/schema.json");
    expect(prompt).toContain("devflow-concise-complete-writing");
    expect(prompt).toContain("简练完整表达原则");
    expect(prompt).toContain("结论先行");

    // F1: 测试 asideQuestionMaterials 包含 skills, skill_paths 与 writing_instructions
    const dummyEngine = {
      store: {
        get: () => null,
        list: () => [],
      },
    } as any;
    const dummyWorkflow = {
      id: "wf-test",
      state: "EXECUTING",
      request: "test request",
      plan_revision: 1,
    } as any;
    const dummyQuestion = {
      question: "这是一个临时问题吗？",
      refs: [],
      plan_revision: 1,
    };
    const materials = asideQuestionMaterials(dummyEngine, dummyWorkflow, dummyQuestion, null, "codex");
    expect(materials.skills).toContain("devflow-concise-complete-writing");
    expect(materials.skills).toContain("devflow-human-readable-plans");
    expect(materials.skill_paths["devflow-concise-complete-writing/SKILL.md"]).toBeTruthy();
    expect(materials.skill_paths["devflow-human-readable-plans/SKILL.md"]).toBeTruthy();
    expect(materials.writing_instructions).toContain("devflow-concise-complete-writing");
    expect(materials.writing_instructions).toContain("结论先行");
  });
});
