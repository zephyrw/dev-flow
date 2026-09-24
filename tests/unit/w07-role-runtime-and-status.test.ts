import { describe, expect, it } from "vitest";
import { States, type ToolProfile } from "../../packages/contracts/src/index.js";
import {
  formatWorkflowState,
  isKnownWorkflowState,
  getWorkflowStateTone,
} from "../../packages/presentation/src/workflow-status.js";
import {
  projectRoleRuntime,
  isProfileEquivalent,
} from "../../packages/presentation/src/role-runtime.js";

const plannerProfile: ToolProfile = {
  id: "planner",
  revision: 1,
  adapterId: "codex",
  modelId: "gpt-4o",
  modelSelection: "explicit",
  selectionKind: "fixed",
  options: {},
  reasoning: { mode: "explicit", value: "high" },
};

const executorProfile: ToolProfile = {
  id: "executor",
  revision: 1,
  adapterId: "agy",
  modelId: "gemini-2.5-pro",
  modelSelection: "explicit",
  selectionKind: "fixed",
  options: {},
  reasoning: { mode: "explicit", value: "high" },
};

const independentReviewerProfile: ToolProfile = {
  id: "reviewer",
  revision: 1,
  adapterId: "codex",
  modelId: "o3-mini",
  modelSelection: "explicit",
  selectionKind: "fixed",
  options: {},
  reasoning: { mode: "explicit", value: "medium" },
};

describe("W07: D09 状态统一映射与回退测试", () => {
  it("合同中所有 29 个 States 均有有效中文映射，且非空", () => {
    for (const state of States) {
      expect(isKnownWorkflowState(state)).toBe(true);
      const text = formatWorkflowState(state);
      expect(text).toBeDefined();
      expect(typeof text).toBe("string");
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain("状态待识别");
      expect(getWorkflowStateTone(state)).toBeDefined();
    }
  });

  it("包含 QUALITY_REVIEW, PLANNER_TAKEOVER, PAUSED 等新增合法状态", () => {
    expect(formatWorkflowState("QUALITY_REVIEW")).toBe("质量审查中");
    expect(formatWorkflowState("PLANNER_TAKEOVER")).toBe("规划接管中");
    expect(formatWorkflowState("PAUSED")).toBe("已暂停");
    expect(formatWorkflowState("DELIVERY_VERIFYING")).toBe("交付验证中");
  });

  it("未知状态安全回退，不崩溃且不返回空白", () => {
    const unknown = formatWorkflowState("SOME_NEW_FUTURE_STATE");
    expect(unknown).toContain("状态待识别");
    expect(unknown).toContain("SOME_NEW_FUTURE_STATE");
    expect(formatWorkflowState(null)).toBe("未知状态");
    expect(formatWorkflowState(undefined)).toBe("未知状态");
  });
});

describe("W07: 9.5 节双行模型展示真值表测试", () => {
  const baseDetail = {
    workflow: {
      id: "wf-1",
      state: "PLANNING",
      run_id: "run-1",
    },
    execution_spec: {
      spec: {
        plannerProfile,
        executorProfile,
        roleOverrides: {
          reviewer: { mode: "inherit" },
          review_fixer: { mode: "inherit" },
          functional_fixer: { mode: "inherit" },
        },
      },
    },
    runs: [
      {
        id: "run-1",
        purpose: "planning",
        routing_role: "planner",
        profile: plannerProfile,
      },
    ],
  };

  it("场景 1: planning 活动 -> 上行高亮，下行显示任务执行配置", () => {
    const result = projectRoleRuntime(baseDetail, { connected: true });
    expect(result.plannerRow.isActive).toBe(true);
    expect(result.executorRow.isActive).toBe(false);
    expect(result.plannerRow.displayText).toContain("Codex");
    expect(result.executorRow.displayText).toContain("AGY");
    expect(result.compactBadge).toBeUndefined();
  });

  it("场景 2: implement 活动 -> 下行高亮，上行显示任务规划配置", () => {
    const detail = {
      ...baseDetail,
      workflow: { ...baseDetail.workflow, state: "EXECUTING" },
      runs: [
        {
          id: "run-1",
          purpose: "implement",
          routing_role: "executor",
          profile: executorProfile,
        },
      ],
    };
    const result = projectRoleRuntime(detail, { connected: true });
    expect(result.plannerRow.isActive).toBe(false);
    expect(result.executorRow.isActive).toBe(true);
    expect(result.compactBadge).toBeUndefined();
  });

  it("场景 3: reviewer 与规划选择一致 (inherit) -> 上行高亮，说明当前用于复核", () => {
    const detail = {
      ...baseDetail,
      workflow: { ...baseDetail.workflow, state: "REVIEWING" },
      runs: [
        {
          id: "run-1",
          purpose: "quality_review",
          routing_role: "reviewer",
          profile: plannerProfile,
        },
      ],
    };
    const result = projectRoleRuntime(detail, { connected: true });
    expect(result.plannerRow.isActive).toBe(true);
    expect(result.plannerRow.activeReason).toBe("当前用于复核");
    expect(result.executorRow.isActive).toBe(false);
    expect(result.compactBadge).toBeUndefined();
  });

  it("场景 4: 独立且不同的 reviewer 活动 -> 两行不高亮，紧凑复核中说明实际模型", () => {
    const detail = {
      ...baseDetail,
      workflow: { ...baseDetail.workflow, state: "QUALITY_REVIEW" },
      execution_spec: {
        spec: {
          plannerProfile,
          executorProfile,
          roleOverrides: {
            reviewer: {
              mode: "explicit",
              profile: independentReviewerProfile,
            },
            review_fixer: { mode: "inherit" },
            functional_fixer: { mode: "inherit" },
          },
        },
      },
      runs: [
        {
          id: "run-1",
          purpose: "quality_review",
          routing_role: "reviewer",
          profile: independentReviewerProfile,
        },
      ],
    };
    const result = projectRoleRuntime(detail, { connected: true });
    // 两行都不冒充当前模型
    expect(result.plannerRow.isActive).toBe(false);
    expect(result.executorRow.isActive).toBe(false);
    // 紧凑复核标识
    expect(result.compactBadge).toBeDefined();
    expect(result.compactBadge?.label).toBe("复核中");
    expect(result.compactBadge?.displayText).toContain("o3-mini");
    // 额度归属明确标注当前复核模型
    expect(result.quotaTarget?.isIndependentReviewer).toBe(true);
  });

  it("场景 5: functional_fixer 与执行一致 -> 下行高亮，说明当前用于功能修复", () => {
    const detail = {
      ...baseDetail,
      workflow: { ...baseDetail.workflow, state: "EXECUTING" },
      runs: [
        {
          id: "run-1",
          purpose: "functional_fix",
          routing_role: "functional_fixer",
          profile: executorProfile,
        },
      ],
    };
    const result = projectRoleRuntime(detail, { connected: true });
    expect(result.plannerRow.isActive).toBe(false);
    expect(result.executorRow.isActive).toBe(true);
    expect(result.executorRow.activeReason).toBe("当前用于功能修复");
    expect(result.compactBadge).toBeUndefined();
  });

  it("场景 6: functional_fixer 为独立不同配置 -> 两行不高亮，紧凑修复中", () => {
    const independentFixer: ToolProfile = {
      ...plannerProfile,
      id: "fixer",
      modelId: "claude-3-7-sonnet",
    };
    const detail = {
      ...baseDetail,
      workflow: { ...baseDetail.workflow, state: "EXECUTING" },
      execution_spec: {
        spec: {
          plannerProfile,
          executorProfile,
          roleOverrides: {
            reviewer: { mode: "inherit" },
            review_fixer: { mode: "inherit" },
            functional_fixer: {
              mode: "explicit",
              profile: independentFixer,
            },
          },
        },
      },
      runs: [
        {
          id: "run-1",
          purpose: "functional_fix",
          routing_role: "functional_fixer",
          profile: independentFixer,
        },
      ],
    };
    const result = projectRoleRuntime(detail, { connected: true });
    expect(result.plannerRow.isActive).toBe(false);
    expect(result.executorRow.isActive).toBe(false);
    expect(result.compactBadge?.label).toBe("修复中");
  });

  it("场景 7: 同一个模型承担两个角色 -> 仅实际职责对应行高亮，不同时亮", () => {
    const sameProfileDetail = {
      ...baseDetail,
      execution_spec: {
        spec: {
          plannerProfile,
          executorProfile: { ...plannerProfile, id: "executor" },
          roleOverrides: {
            reviewer: { mode: "inherit" },
            review_fixer: { mode: "inherit" },
            functional_fixer: { mode: "inherit" },
          },
        },
      },
      runs: [
        {
          id: "run-1",
          purpose: "planning",
          routing_role: "planner",
          profile: plannerProfile,
        },
      ],
    };
    const resPlanner = projectRoleRuntime(sameProfileDetail, { connected: true });
    expect(resPlanner.plannerRow.isActive).toBe(true);
    expect(resPlanner.executorRow.isActive).toBe(false);

    // 切换到执行
    const execSameDetail = {
      ...sameProfileDetail,
      runs: [
        {
          id: "run-1",
          purpose: "implement",
          routing_role: "executor",
          profile: plannerProfile,
        },
      ],
    };
    const resExec = projectRoleRuntime(execSameDetail, { connected: true });
    expect(resExec.plannerRow.isActive).toBe(false);
    expect(resExec.executorRow.isActive).toBe(true);
  });

  it("场景 8: STOPPED/COMPLETED -> 无活动高亮", () => {
    const detail = {
      ...baseDetail,
      workflow: { ...baseDetail.workflow, state: "STOPPED" },
    };
    const result = projectRoleRuntime(detail, { connected: true });
    expect(result.plannerRow.isActive).toBe(false);
    expect(result.executorRow.isActive).toBe(false);
  });

  it("场景 9: 断线 -> 不宣称实时活动", () => {
    const result = projectRoleRuntime(baseDetail, { connected: false });
    expect(result.plannerRow.isActive).toBe(false);
    expect(result.executorRow.isActive).toBe(false);
    expect(result.plannerRow.tooltip).toContain("连接中断");
  });
});
