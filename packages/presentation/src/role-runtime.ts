import type { ToolProfile, RoleBinding } from "../../contracts/src/index.js";
import { formatRuntimeDisplay, isEquivalentModelName } from "./model-display.js";
import { visibleRunObservation } from "./run-observation.js";

export interface RuntimeRowView {
  role: "planner" | "executor";
  label: string;
  displayText: string;
  adapterId?: string | null;
  modelId?: string | null;
  effort?: string | null;
  isActive: boolean;
  activeReason?: string;
  tooltip?: string;
}

export interface CompactActiveBadge {
  role: string;
  label: string;
  displayText: string;
  tooltip: string;
}

export interface QuotaTargetView {
  role: string;
  adapter?: string | null;
  model?: string | null;
  isIndependentReviewer: boolean;
  description: string;
}

export interface RoleRuntimeView {
  plannerRow: RuntimeRowView;
  executorRow: RuntimeRowView;
  activeRole?: string;
  compactBadge?: CompactActiveBadge;
  quotaTarget?: QuotaTargetView;
}

export function isProfileEquivalent(
  a?: ToolProfile | null,
  b?: ToolProfile | null,
): boolean {
  if (!a || !b) return false;
  if (a.adapterId !== b.adapterId) return false;
  if (!isEquivalentModelName(a.modelId, b.modelId)) return false;

  const aMode = a.reasoning?.mode ?? "native-default";
  const bMode = b.reasoning?.mode ?? "native-default";
  if (aMode !== bMode) return false;
  if (a.reasoning?.mode === "explicit" && b.reasoning?.mode === "explicit") {
    if (a.reasoning.value !== b.reasoning.value) return false;
  }

  if (a.executableRef !== b.executableRef) return false;
  if (a.nativeConfigProfile !== b.nativeConfigProfile) return false;
  return true;
}

function resolveTaskProfiles(detail: any): {
  plannerProfile?: ToolProfile;
  executorProfile?: ToolProfile;
  reviewerBinding?: RoleBinding;
  reviewFixerBinding?: RoleBinding;
  functionalFixerBinding?: RoleBinding;
} {
  const spec =
    detail?.execution_spec?.spec ??
    detail?.execution_spec ??
    detail?.workflow?.execution_spec;

  const plannerProfile = spec?.plannerProfile ?? detail?.planner_profile;
  const executorProfile = spec?.executorProfile ?? detail?.executor_profile;
  const overrides = spec?.roleOverrides;

  return {
    plannerProfile,
    executorProfile,
    reviewerBinding: overrides?.reviewer,
    reviewFixerBinding: overrides?.review_fixer,
    functionalFixerBinding: overrides?.functional_fixer,
  };
}

function runPurposeToRole(purpose?: string): string | undefined {
  if (!purpose) return undefined;
  if (
    purpose === "planning" ||
    purpose === "planner_takeover" ||
    purpose === "planner_commit"
  ) {
    return "planner";
  }
  if (purpose === "implement" || purpose === "executor_test") {
    return "executor";
  }
  if (purpose === "quality_review" || purpose === "diagnose") {
    return "reviewer";
  }
  if (purpose === "review_fixer") {
    return "review_fixer";
  }
  if (purpose === "functional_fix") {
    return "functional_fixer";
  }
  return undefined;
}

const TERMINAL_OR_PAUSED_STATES = new Set([
  "STOPPED",
  "STOPPING",
  "PAUSED",
  "COMPLETED",
  "COMMITTED",
  "CLEANUP_PENDING",
  "COMMIT_PARTIAL",
  "BLOCKED",
  "RECOVERY_REQUIRED",
  "PLAN_PENDING",
]);

export function projectRoleRuntime(
  detail: any,
  options?: { connected?: boolean },
): RoleRuntimeView {
  const connected = options?.connected ?? true;
  const state = detail?.workflow?.state;
  const activeRunId = detail?.workflow?.run_id;
  const currentRun = activeRunId
    ? detail?.runs?.find((r: any) => r.id === activeRunId)
    : undefined;
  const observation = visibleRunObservation(detail);

  const {
    plannerProfile,
    executorProfile,
    reviewerBinding,
    functionalFixerBinding,
    reviewFixerBinding,
  } = resolveTaskProfiles(detail);

  const plannerBaseDisplay = plannerProfile
    ? formatRuntimeDisplay({
        adapterId: plannerProfile.adapterId,
        modelId: plannerProfile.modelId,
        effort:
          plannerProfile.reasoning?.mode === "explicit"
            ? plannerProfile.reasoning.value
            : undefined,
      })
    : "未配置规划模型";

  const executorBaseDisplay = executorProfile
    ? formatRuntimeDisplay({
        adapterId: executorProfile.adapterId,
        modelId: executorProfile.modelId,
        effort:
          executorProfile.reasoning?.mode === "explicit"
            ? executorProfile.reasoning.value
            : undefined,
      })
    : "未配置执行模型";

  const plannerRow: RuntimeRowView = {
    role: "planner",
    label: "规划",
    displayText: plannerBaseDisplay,
    adapterId: plannerProfile?.adapterId,
    modelId: plannerProfile?.modelId,
    effort:
      plannerProfile?.reasoning?.mode === "explicit"
        ? plannerProfile.reasoning.value
        : undefined,
    isActive: false,
  };

  const executorRow: RuntimeRowView = {
    role: "executor",
    label: "执行",
    displayText: executorBaseDisplay,
    adapterId: executorProfile?.adapterId,
    modelId: executorProfile?.modelId,
    effort:
      executorProfile?.reasoning?.mode === "explicit"
        ? executorProfile.reasoning.value
        : undefined,
    isActive: false,
  };

  // 若断线，不宣称实时活动
  if (!connected) {
    plannerRow.tooltip = "连接中断，状态待确认";
    executorRow.tooltip = "连接中断，状态待确认";
    return {
      plannerRow,
      executorRow,
      quotaTarget: {
        role: "unknown",
        adapter: plannerProfile?.adapterId,
        model: plannerProfile?.modelId,
        isIndependentReviewer: false,
        description: "连接中断，暂无可信额度",
      },
    };
  }

  // 终态、暂停状态或显式非运行态：无活动高亮
  const isRunActive = currentRun
    ? currentRun.status === undefined || currentRun.status === "running"
    : true;
  if (
    !state ||
    TERMINAL_OR_PAUSED_STATES.has(state) ||
    !activeRunId ||
    !isRunActive
  ) {
    return {
      plannerRow,
      executorRow,
      quotaTarget: {
        role: "planner",
        adapter: plannerProfile?.adapterId,
        model: plannerProfile?.modelId,
        isIndependentReviewer: false,
        description: "下次生效的规划配置",
      },
    };
  }

  // 确定当前主 run 的真实活动角色
  const activeRole =
    currentRun?.routing_role ??
    runPurposeToRole(currentRun?.purpose ?? observation?.purpose);

  if (!activeRole) {
    return {
      plannerRow,
      executorRow,
      quotaTarget: {
        role: "planner",
        adapter: plannerProfile?.adapterId,
        model: plannerProfile?.modelId,
        isIndependentReviewer: false,
        description: "当前规划模型额度",
      },
    };
  }

  const actualAdapter = observation?.adapter ?? currentRun?.profile?.adapterId;
  const actualModel =
    observation?.actual_model ??
    observation?.requested_model ??
    currentRun?.profile?.modelId;
  const actualEffort = observation?.effort;

  // 1. planning / takeover 活动
  if (activeRole === "planner") {
    plannerRow.isActive = true;
    if (actualModel) {
      plannerRow.displayText = formatRuntimeDisplay({
        adapterId: actualAdapter ?? plannerProfile?.adapterId,
        modelId: actualModel,
        effort: actualEffort,
      });
      plannerRow.adapterId = actualAdapter ?? plannerProfile?.adapterId;
      plannerRow.modelId = actualModel;
      plannerRow.effort = actualEffort;
    }
    return {
      plannerRow,
      executorRow,
      activeRole: "planner",
      quotaTarget: {
        role: "planner",
        adapter: actualAdapter ?? plannerProfile?.adapterId,
        model: actualModel ?? plannerProfile?.modelId,
        isIndependentReviewer: false,
        description: "当前规划模型额度",
      },
    };
  }

  // 2. implement / test 活动
  if (activeRole === "executor") {
    executorRow.isActive = true;
    if (actualModel) {
      executorRow.displayText = formatRuntimeDisplay({
        adapterId: actualAdapter ?? executorProfile?.adapterId,
        modelId: actualModel,
        effort: actualEffort,
      });
      executorRow.adapterId = actualAdapter ?? executorProfile?.adapterId;
      executorRow.modelId = actualModel;
      executorRow.effort = actualEffort;
    }
    return {
      plannerRow,
      executorRow,
      activeRole: "executor",
      quotaTarget: {
        role: "executor",
        adapter: actualAdapter ?? executorProfile?.adapterId,
        model: actualModel ?? executorProfile?.modelId,
        isIndependentReviewer: false,
        description: "当前执行模型额度",
      },
    };
  }

  // 3. reviewer 活动
  if (activeRole === "reviewer") {
    const isReviewerInherited =
      reviewerBinding?.mode === "inherit" ||
      !reviewerBinding ||
      isProfileEquivalent(reviewerBinding.profile, plannerProfile);

    if (isReviewerInherited) {
      plannerRow.isActive = true;
      plannerRow.activeReason = "当前用于复核";
      plannerRow.tooltip = "当前用于复核";
      return {
        plannerRow,
        executorRow,
        activeRole: "reviewer",
        quotaTarget: {
          role: "reviewer",
          adapter: actualAdapter ?? plannerProfile?.adapterId,
          model: actualModel ?? plannerProfile?.modelId,
          isIndependentReviewer: false,
          description: "当前复核模型额度（跟随规划）",
        },
      };
    } else {
      // 独立且不同的复核模型：两行都不高亮，显示紧凑复核标识
      const reviewerProfile = reviewerBinding.profile;
      const compactText = formatRuntimeDisplay({
        adapterId: actualAdapter ?? reviewerProfile?.adapterId,
        modelId: actualModel ?? reviewerProfile?.modelId,
        effort: actualEffort,
      });
      return {
        plannerRow,
        executorRow,
        activeRole: "reviewer",
        compactBadge: {
          role: "reviewer",
          label: "复核中",
          displayText: compactText,
          tooltip: `独立复核模型：${compactText}`,
        },
        quotaTarget: {
          role: "reviewer",
          adapter: actualAdapter ?? reviewerProfile?.adapterId,
          model: actualModel ?? reviewerProfile?.modelId,
          isIndependentReviewer: true,
          description: "当前复核模型额度",
        },
      };
    }
  }

  // 4. functional_fixer 活动
  if (activeRole === "functional_fixer") {
    const isFixerInherited =
      functionalFixerBinding?.mode === "inherit" ||
      !functionalFixerBinding ||
      isProfileEquivalent(functionalFixerBinding.profile, executorProfile);

    if (isFixerInherited) {
      executorRow.isActive = true;
      executorRow.activeReason = "当前用于功能修复";
      executorRow.tooltip = "当前用于功能修复";
      return {
        plannerRow,
        executorRow,
        activeRole: "functional_fixer",
        quotaTarget: {
          role: "functional_fixer",
          adapter: actualAdapter ?? executorProfile?.adapterId,
          model: actualModel ?? executorProfile?.modelId,
          isIndependentReviewer: false,
          description: "当前修复模型额度（跟随执行）",
        },
      };
    } else {
      const fixerProfile = functionalFixerBinding.profile;
      const compactText = formatRuntimeDisplay({
        adapterId: actualAdapter ?? fixerProfile?.adapterId,
        modelId: actualModel ?? fixerProfile?.modelId,
        effort: actualEffort,
      });
      return {
        plannerRow,
        executorRow,
        activeRole: "functional_fixer",
        compactBadge: {
          role: "functional_fixer",
          label: "修复中",
          displayText: compactText,
          tooltip: `独立修复模型：${compactText}`,
        },
        quotaTarget: {
          role: "functional_fixer",
          adapter: actualAdapter ?? fixerProfile?.adapterId,
          model: actualModel ?? fixerProfile?.modelId,
          isIndependentReviewer: false,
          description: "当前修复模型额度",
        },
      };
    }
  }

  // 5. review_fixer 活动
  if (activeRole === "review_fixer") {
    const isReviewFixerInherited =
      reviewFixerBinding?.mode === "inherit" ||
      !reviewFixerBinding ||
      isProfileEquivalent(reviewFixerBinding.profile, executorProfile);

    if (isReviewFixerInherited) {
      executorRow.isActive = true;
      executorRow.activeReason = "当前用于审查修复";
      executorRow.tooltip = "当前用于审查修复";
      return {
        plannerRow,
        executorRow,
        activeRole: "review_fixer",
        quotaTarget: {
          role: "review_fixer",
          adapter: actualAdapter ?? executorProfile?.adapterId,
          model: actualModel ?? executorProfile?.modelId,
          isIndependentReviewer: false,
          description: "当前修复模型额度（跟随执行）",
        },
      };
    } else {
      const fixerProfile = reviewFixerBinding.profile;
      const compactText = formatRuntimeDisplay({
        adapterId: actualAdapter ?? fixerProfile?.adapterId,
        modelId: actualModel ?? fixerProfile?.modelId,
        effort: actualEffort,
      });
      return {
        plannerRow,
        executorRow,
        activeRole: "review_fixer",
        compactBadge: {
          role: "review_fixer",
          label: "修复中",
          displayText: compactText,
          tooltip: `独立修复模型：${compactText}`,
        },
        quotaTarget: {
          role: "review_fixer",
          adapter: actualAdapter ?? fixerProfile?.adapterId,
          model: actualModel ?? fixerProfile?.modelId,
          isIndependentReviewer: false,
          description: "当前修复模型额度",
        },
      };
    }
  }

  return {
    plannerRow,
    executorRow,
    quotaTarget: {
      role: "planner",
      adapter: plannerProfile?.adapterId,
      model: plannerProfile?.modelId,
      isIndependentReviewer: false,
      description: "当前规划模型额度",
    },
  };
}
