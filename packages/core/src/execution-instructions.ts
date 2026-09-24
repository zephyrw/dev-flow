import {
  ApprovedExecutionInstructions,
  PlanApprovalRecordV2,
  RunApprovalRef,
  normalizeInstructionsText,
  ExecutionInstructionPayload,
} from "../../contracts/src/plan-approval.js";
import { hash } from "./util.js";

/**
 * 规范化用户输入的附加指令并计算 SHA-256 摘要
 */
export function createApprovedExecutionInstructions(
  rawText?: string | null,
): ApprovedExecutionInstructions {
  const text = normalizeInstructionsText(rawText);
  const text_hash = hash(text);
  return {
    schema_version: 1,
    text,
    text_hash,
    scope: "approved-plan",
  };
}

/**
 * 将已批准附加指令格式化为清晰的自然语言提示分节
 */
export function formatExecutionInstructionsForPrompt(
  instructions?: ApprovedExecutionInstructions | null,
): string {
  if (!instructions || !instructions.text.trim()) {
    return "";
  }
  return [
    "",
    "## 审批附加执行指令（必须遵循的约束）",
    "以下指令由用户在批准本次计划时附加，在本次实现、测试、修复和恢复中必须持续遵循。",
    "注意：这些属于已生效的持续约束，不要求重复做已完成的工作：",
    "",
    instructions.text,
    "",
  ].join("\n");
}

/**
 * 构造符合材料规范的 approved_execution_instructions 对象
 */
export function buildApprovedExecutionInstructionsPayload(
  record: any,
  fallbackId: string,
): ExecutionInstructionPayload | null {
  if (!record) return null;
  const instructions: ApprovedExecutionInstructions | undefined =
    record.execution_instructions;
  if (!instructions || !instructions.text) {
    return null;
  }
  return {
    approval_id: record.approval_id ?? fallbackId,
    plan_revision: record.plan_revision ?? record.revision,
    plan_hash: record.plan_hash,
    text: instructions.text,
    text_hash: instructions.text_hash,
    scope: "approved-plan",
  };
}

/**
 * 为执行轮次校验并解析附加指令材料
 * 带有 RunApprovalRef 的运行遇到 approval 不存在、归属不符、版本或指令 hash 不一致时抛出异常阻止派发；
 * 兼容无指令或旧版本记录。
 */
export function verifyAndResolveExecutionInstructions(
  store: { get: <T>(table: string, key: string) => T | undefined },
  workflowId: string,
  run: { approval_ref?: RunApprovalRef; plan_revision?: number },
  currentPlanRevision: number,
  currentPlanHash: string,
): {
  instructions: ApprovedExecutionInstructions | null;
  payload: ExecutionInstructionPayload | null;
} {
  const targetRevision = run.approval_ref?.plan_revision ?? currentPlanRevision;
  const approvalKey = `${workflowId}-${targetRevision}`;
  const record = store.get<any>("approval", approvalKey);

  if (run.approval_ref) {
    const ref = run.approval_ref;
    if (!record) {
      throw new Error(
        `审批记录缺失: 运行引用 approval ${ref.approval_id} 未找到, 无法安全派发`,
      );
    }
    const recordWorkflowId = record.workflow_id ?? workflowId;
    if (recordWorkflowId !== workflowId) {
      throw new Error(
        `审批归属不符: 记录所属 ${recordWorkflowId} 与当前任务 ${workflowId} 不一致`,
      );
    }
    const recordRevision = record.plan_revision ?? record.revision;
    if (recordRevision !== ref.plan_revision) {
      throw new Error(
        `计划版本不一致: 引用版本 v${ref.plan_revision} 与审批记录版本 v${recordRevision} 不匹配`,
      );
    }
    if (record.plan_hash !== ref.plan_hash) {
      throw new Error(
        `计划哈希不一致: 引用计划哈希 ${ref.plan_hash} 与审批记录哈希 ${record.plan_hash} 不匹配`,
      );
    }
    const recordInstructionsHash =
      record.execution_instructions?.text_hash ?? "";
    if (recordInstructionsHash !== ref.instructions_hash) {
      throw new Error(
        `指令哈希不一致: 引用指令哈希 ${ref.instructions_hash} 与审批记录指令哈希 ${recordInstructionsHash} 不匹配`,
      );
    }
    const instructions: ApprovedExecutionInstructions | null =
      record.execution_instructions ?? null;
    const payload = buildApprovedExecutionInstructionsPayload(
      record,
      ref.approval_id,
    );
    return { instructions, payload };
  }

  // 兼容旧运行或未带 approval_ref 的情况
  if (record && record.execution_instructions) {
    const payload = buildApprovedExecutionInstructionsPayload(
      record,
      approvalKey,
    );
    return { instructions: record.execution_instructions, payload };
  }

  return { instructions: null, payload: null };
}
