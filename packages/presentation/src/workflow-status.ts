import { States, type State } from "../../contracts/src/base.js";

export interface WorkflowStateMeta {
  label: string;
  tone: "info" | "warning" | "error" | "success" | "neutral";
  description: string;
}

export const WORKFLOW_STATE_META: Record<State, WorkflowStateMeta> = {
  RESEARCHING: {
    label: "调研中",
    tone: "info",
    description: "正在进行代码库与需求前置调研",
  },
  PLANNING: {
    label: "规划中",
    tone: "info",
    description: "正在生成实施计划",
  },
  PLAN_PENDING: {
    label: "等待计划批准",
    tone: "warning",
    description: "实施计划已生成，等待人工审批",
  },
  QUEUED: {
    label: "排队中",
    tone: "neutral",
    description: "等待执行资源或前置阶段就绪",
  },
  EXECUTING: {
    label: "实施中",
    tone: "info",
    description: "正在按计划修改代码与实施",
  },
  VERIFYING: {
    label: "交接审查",
    tone: "info",
    description: "执行完成，正在进行交付前验证与审查",
  },
  DELIVERY_VERIFYING: {
    label: "交付验证中",
    tone: "info",
    description: "正在执行自动化验证与交付核验",
  },
  QUALITY_REVIEW: {
    label: "质量审查中",
    tone: "info",
    description: "独立复核模型正在进行代码审查",
  },
  AFTER_HUMAN_REVIEW: {
    label: "审查后待处理",
    tone: "warning",
    description: "人工审查反馈已记录，等待处理",
  },
  PLANNER_TAKEOVER: {
    label: "规划接管中",
    tone: "warning",
    description: "多次修复未果，转由规划模型接管诊断",
  },
  HUMAN_PENDING: {
    label: "等待你的验收",
    tone: "warning",
    description: "实施已完成，等待人工验收",
  },
  HUMAN_VERIFY: {
    label: "等待人工核验",
    tone: "warning",
    description: "等待人工核对功能或测试结果",
  },
  REVIEW_QUEUED: {
    label: "等待代码审查",
    tone: "neutral",
    description: "已提交审查队列，等待复核开始",
  },
  REVIEWING: {
    label: "代码审查中",
    tone: "info",
    description: "正在进行代码审查",
  },
  REPAIR_PLAN_PENDING: {
    label: "等待修复计划批准",
    tone: "warning",
    description: "已生成修复方案，等待批准",
  },
  REPAIR_RESEARCH_REQUIRED: {
    label: "需要补充调研",
    tone: "warning",
    description: "修复前需要进一步调研问题根因",
  },
  INTEGRATING: {
    label: "整合代码中",
    tone: "info",
    description: "正在合并工作区与整合变更",
  },
  COMMITTING: {
    label: "提交中",
    tone: "info",
    description: "正在提交代码与同步状态",
  },
  COMMITTED: {
    label: "已提交",
    tone: "success",
    description: "变更已成功提交",
  },
  COMPLETED: {
    label: "已完成",
    tone: "success",
    description: "任务全部阶段已顺利完成",
  },
  CLEANUP_PENDING: {
    label: "等待清理工作树",
    tone: "neutral",
    description: "任务完成，等待清理隔离工作树",
  },
  COMMIT_PARTIAL: {
    label: "提交需要恢复",
    tone: "error",
    description: "部分文件提交失败，需要恢复检查",
  },
  STOPPING: {
    label: "正在暂停",
    tone: "warning",
    description: "正在安全停止当前执行",
  },
  STOPPED: {
    label: "已暂停",
    tone: "neutral",
    description: "执行已暂停",
  },
  PAUSED: {
    label: "已暂停",
    tone: "neutral",
    description: "任务处于暂停状态",
  },
  BLOCKED: {
    label: "需要处理",
    tone: "error",
    description: "遇到阻塞错误，需要人工干预或配置修复",
  },
  RECOVERY_REQUIRED: {
    label: "需要恢复检查",
    tone: "error",
    description: "运行异常中断，需要恢复检查",
  },
  WAITING_AUTHORIZATION: {
    label: "等待操作授权",
    tone: "warning",
    description: "需要获得必要授权后方可继续",
  },
  WAITING_INPUT: {
    label: "等待你的指导",
    tone: "warning",
    description: "遇到歧义或决策点，等待用户输入",
  },
};

export function isKnownWorkflowState(state: string): state is State {
  return (States as readonly string[]).includes(state);
}

export function formatWorkflowState(state?: string | null): string {
  if (!state) return "未知状态";
  if (isKnownWorkflowState(state)) {
    return WORKFLOW_STATE_META[state].label;
  }
  return `状态待识别 (${state})`;
}

export function getWorkflowStateTone(
  state?: string | null,
): "info" | "warning" | "error" | "success" | "neutral" {
  if (!state || !isKnownWorkflowState(state)) return "neutral";
  return WORKFLOW_STATE_META[state].tone;
}

export function getWorkflowStateDescription(
  state?: string | null,
): string | undefined {
  if (!state || !isKnownWorkflowState(state)) return undefined;
  return WORKFLOW_STATE_META[state].description;
}
