import type {
  QualityFlow,
  QualityFlowPhase,
  CodeReviewResult,
  PlannerRepairResult,
  ExecutorTestResult,
} from "../../contracts/src/quality.js";

export const QUALITY_POLICY_VERSION = 2;

export type QualityFlowEventType =
  | "implement_completed"
  | "quality_review"
  | "planner_repair_completed"
  | "executor_test_completed"
  | "human_functional_feedback"
  | "human_functional_passed";

export type QualityFlowEvent =
  | { type: "implement_completed"; is_quality_repair?: boolean }
  | { type: "quality_review"; result: CodeReviewResult | { verdict?: string; summary?: string } }
  | { type: "planner_repair_completed"; result?: PlannerRepairResult }
  | { type: "executor_test_completed"; result?: ExecutorTestResult }
  | { type: "human_functional_feedback" }
  | { type: "human_functional_passed" };

export type QualityFlowAction =
  | { kind: "quality_review"; phase: QualityFlowPhase }
  | { kind: "human"; phase: QualityFlowPhase }
  | { kind: "executor_repair"; phase: QualityFlowPhase }
  | { kind: "planner_repair"; phase: QualityFlowPhase }
  | { kind: "executor_test"; phase: QualityFlowPhase }
  | { kind: "functional_fix"; phase: QualityFlowPhase }
  | { kind: "planner_commit"; phase: QualityFlowPhase }
  | { kind: "wait"; reason: string };

export type QualityFlowContext = {
  flow: QualityFlow;
  /** 首次质量整改是否已经派发过（与 completed 区分：派发中尚未完成时已完成标志仍为 false）。 */
  executor_repair_dispatched?: boolean;
};

export function createQualityFlow(workflowId: string): QualityFlow {
  return {
    workflow_id: workflowId,
    phase: "before_human",
    executor_repair_completed: false,
    planner_repairs_only: false,
  };
}

function reviewVerdict(
  result: QualityFlowEvent & { type: "quality_review" },
): "passed" | "changes_required" | "need_user" {
  const raw =
    (result.result as { verdict?: string }).verdict ??
    (result.result as { status?: string }).status;
  if (raw === "passed" || raw === "changes_required" || raw === "need_user") {
    return raw;
  }
  return "need_user";
}

/**
 * 策略 2 纯函数路由。只读取路由上下文和本轮角色结果。
 * 不读文件系统、Git diff、测试记录、附件、模型 API 或宿主调用账本。
 */
export function nextQualityAction(
  context: QualityFlowContext,
  event: QualityFlowEvent,
): { flow: QualityFlow; action: QualityFlowAction } {
  const flow: QualityFlow = { ...context.flow };

  switch (event.type) {
    case "implement_completed": {
      if (event.is_quality_repair) {
        flow.executor_repair_completed = true;
        return {
          flow,
          action: { kind: "quality_review", phase: flow.phase },
        };
      }
      // 首次开发完成 → 首次质量复核
      return {
        flow,
        action: { kind: "quality_review", phase: flow.phase },
      };
    }

    case "quality_review": {
      const verdict = reviewVerdict(event);
      if (verdict === "need_user") {
        return { flow, action: { kind: "wait", reason: "need_user" } };
      }
      if (verdict === "passed") {
        if (flow.phase === "before_human") {
          return { flow, action: { kind: "human", phase: flow.phase } };
        }
        // after_human 通过 → 冻结提交调度上下文
        return { flow, action: { kind: "planner_commit", phase: flow.phase } };
      }
      // changes_required
      if (flow.phase === "after_human") {
        // 人工后有问题直接规划修复，不套用人工前一次机会
        flow.planner_repairs_only = true;
        return {
          flow,
          action: { kind: "planner_repair", phase: flow.phase },
        };
      }
      // before_human
      if (flow.planner_repairs_only || flow.executor_repair_completed) {
        // 已完成执行整改或已接管 → 规划接管
        flow.planner_repairs_only = true;
        return {
          flow,
          action: { kind: "planner_repair", phase: flow.phase },
        };
      }
      // 首次质量整改（唯一一次）
      return {
        flow,
        action: { kind: "executor_repair", phase: flow.phase },
      };
    }

    case "planner_repair_completed": {
      flow.planner_repairs_only = true;
      return {
        flow,
        action: { kind: "executor_test", phase: flow.phase },
      };
    }

    case "executor_test_completed": {
      // 测试期间相关小修改不复核；仅按 phase 直达
      if (flow.phase === "before_human") {
        return { flow, action: { kind: "human", phase: flow.phase } };
      }
      return { flow, action: { kind: "planner_commit", phase: flow.phase } };
    }

    case "human_functional_feedback": {
      return {
        flow,
        action: { kind: "functional_fix", phase: flow.phase },
      };
    }

    case "human_functional_passed": {
      flow.phase = "after_human";
      flow.planner_repairs_only = true;
      return {
        flow,
        action: { kind: "quality_review", phase: flow.phase },
      };
    }

    default: {
      return { flow, action: { kind: "wait", reason: "unknown_event" } };
    }
  }
}

export function usesQualityPolicyV2(
  qualityPolicyVersion: number | undefined | null,
): boolean {
  return (qualityPolicyVersion ?? 1) >= QUALITY_POLICY_VERSION;
}

export function resolveWorkflowQualityFlow(
  stored: Partial<QualityFlow> | undefined,
  workflowId: string,
): QualityFlow {
  return {
    ...createQualityFlow(workflowId),
    ...(stored ?? {}),
    workflow_id: workflowId,
  };
}
