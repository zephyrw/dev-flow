import {
  ApprovedExecutionInstructions,
  PlanApprovalRecordV2,
  RunApprovalRef,
  normalizeInstructionsText,
  ExecutionInstructionPayload,
} from "../../contracts/src/plan-approval.js";
import { hash } from "./util.js";
import { FlowError } from "../../contracts/src/index.js";

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
    approval_id: fallbackId,
    plan_revision: record.plan_revision ?? record.revision,
    plan_hash: record.plan_hash,
    text: instructions.text,
    text_hash: instructions.text_hash,
    scope: "approved-plan",
  };
}

/**
 * 为执行轮次校验并解析附加指令材料
 * 满足 ISO-01 ~ ISO-05 校验不变量：
 * 1. 重新核算正文哈希，防篡改 (ISO-01)
 * 2. 校验 approval_id 一致性 (ISO-02)
 * 3. 校验本次可执行派发计划 (ISO-03)
 * 4. 校验 run.plan_revision 与 ref 一致 (ISO-04)
 * 5. V2 审批记录缺失 ref 阻断派发，仅兼容旧格式运行 (ISO-05)
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
  if (run.plan_revision !== undefined && run.plan_revision !== currentPlanRevision) {
    throw new FlowError("APPROVAL_PLAN_MISMATCH", "运行计划版本与当前派发目标不符", 409);
  }
  const targetRevision = run.approval_ref?.plan_revision ?? currentPlanRevision;
  const approvalKey = `${workflowId}-${targetRevision}`;
  const record = store.get<any>("approval", approvalKey);

  if (run.approval_ref) {
    const ref = run.approval_ref;
    if (!record) {
      throw new FlowError("APPROVAL_RECORD_MISSING",
        `审批记录缺失: 运行引用 approval ${ref.approval_id} 未找到, 无法安全派发`, 404);
    }

    const expectedApprovalId = approvalKey;
    if (ref.approval_id !== expectedApprovalId) {
      throw new FlowError("APPROVAL_RECORD_MISSING",
        `审批引用失配: 引用 approval_id ${ref.approval_id} 与记录 ${expectedApprovalId} 不匹配`, 409);
    }

    const recordWorkflowId = record.workflow_id;
    if (recordWorkflowId !== workflowId) {
      throw new FlowError("APPROVAL_OWNER_MISMATCH",
        `审批归属不符: 记录所属 ${recordWorkflowId} 与当前任务 ${workflowId} 不一致`, 403);
    }

    const recordRevision = record.plan_revision ?? record.revision;
    if (recordRevision !== ref.plan_revision) {
      throw new FlowError("APPROVAL_PLAN_MISMATCH",
        `计划版本不一致: 引用版本 v${ref.plan_revision} 与审批记录版本 v${recordRevision} 不匹配`, 409);
    }

    if (record.plan_hash !== ref.plan_hash) {
      throw new FlowError("APPROVAL_PLAN_MISMATCH",
        `计划哈希不一致: 引用计划哈希 ${ref.plan_hash} 与审批记录哈希 ${record.plan_hash} 不匹配`, 409);
    }

    if (
      ref.plan_revision !== currentPlanRevision ||
      ref.plan_hash !== currentPlanHash
    ) {
      throw new FlowError("APPROVAL_PLAN_MISMATCH",
        `当前派发目标不符: 引用计划 v${ref.plan_revision} (${ref.plan_hash}) 与当前派发计划 v${currentPlanRevision} (${currentPlanHash}) 不匹配`, 409);
    }

    if (run.plan_revision !== undefined && run.plan_revision !== ref.plan_revision) {
      throw new FlowError("APPROVAL_PLAN_MISMATCH",
        `运行计划版本不匹配: run.plan_revision v${run.plan_revision} 与 ref.plan_revision v${ref.plan_revision} 不一致`, 409);
    }

    const recordInstructionsHash =
      record.execution_instructions?.text_hash ?? "";
    if (recordInstructionsHash !== ref.instructions_hash) {
      throw new FlowError("APPROVAL_INSTRUCTIONS_TAMPERED",
        `指令哈希不一致: 引用指令哈希 ${ref.instructions_hash} 与审批记录指令哈希 ${recordInstructionsHash} 不匹配`, 409);
    }

    const stored = record.execution_instructions;
    if (!stored || typeof stored.text !== "string" || stored.scope !== "approved-plan" ||
        stored.schema_version !== 1 || stored.text.length > 20000 ||
        hash(normalizeInstructionsText(stored.text)) !== recordInstructionsHash) {
      throw new FlowError("APPROVAL_INSTRUCTIONS_TAMPERED", "审批指令正文或摘要不一致", 409);
    }

    const instructions: ApprovedExecutionInstructions | null =
      record.execution_instructions ?? null;
    const payload = buildApprovedExecutionInstructionsPayload(
      record,
      ref.approval_id,
    );
    return { instructions, payload };
  }

  // ISO-05: 若存在 V2 审批记录，新运行缺失 ref 是完整性缺失，阻断派发
  if (record && record.schema_version === 2) {
    throw new FlowError("APPROVAL_REFERENCE_MISSING",
      `审批引用缺失: V2 审批记录存在但当前运行未携带 approval_ref, 阻断派发`, 409);
  }

  // 历史审批仅兼容空指令，不能通过去掉 schema_version 绕过 V2 校验。
  if (record?.execution_instructions) {
    throw new FlowError("APPROVAL_REFERENCE_MISSING", "带附加指令的审批缺少运行引用", 409);
  }
  return { instructions: null, payload: null };
}
