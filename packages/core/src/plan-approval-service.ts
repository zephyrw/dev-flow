import {
  PlanApprovalRecordV2,
  PlanApprovalResponse,
  ApprovedExecutionInstructions,
} from "../../contracts/src/plan-approval.js";
import { FlowError } from "../../contracts/src/index.js";
import {
  createApprovedExecutionInstructions,
} from "./execution-instructions.js";
import { DocumentService } from "./document-service.js";
import { canonical, hash, objectHash, now } from "./util.js";
import type { Engine } from "./engine.js";

export interface PlanApprovalExecuteInput {
  workflowId: string;
  requestId: string;
  binding: Record<string, unknown>;
  executionInstructionsText?: string | null;
  documentId?: string;
  documentRevision?: number;
  documentHash?: string;
  expectedVersion?: number;
  callerProof?: string;
  schemaVersion?: 1 | 2;
  feedbackCursor?: number;
}

export class PlanApprovalService {
  constructor(
    private readonly engine: Engine,
    private readonly documentService?: DocumentService,
  ) {}

  /**
   * 统一执行计划审批：支持幂等回执、附加执行指令绑定、文档审批与工作流状态原子流转
   */
  async approve(input: PlanApprovalExecuteInput) {
    return this.approveSync(input);
  }

  approveSync(input: PlanApprovalExecuteInput): {
    ok: true;
    approval: PlanApprovalRecordV2;
    workflow: any;
    document?: any;
    response: PlanApprovalResponse;
  } {
    const {
      workflowId,
      requestId,
      binding,
      executionInstructionsText,
      documentId,
      documentRevision,
      documentHash,
      expectedVersion,
      callerProof,
      schemaVersion = 1,
      feedbackCursor = 0,
    } = input;

    // 规范化附加指令并在服务端计算哈希（不信任客户端哈希）
    const instructions: ApprovedExecutionInstructions =
      createApprovedExecutionInstructions(executionInstructionsText);

    const requestDigest = hash(
      canonical({
        workflowId,
        action: "approve",
        expectedVersion,
        binding,
        documentId,
        documentRevision,
        documentHash,
        instructionsText: instructions.text,
        instructionsHash: instructions.text_hash,
        schemaVersion,
        feedbackCursor,
      }),
    );

    return this.engine.store.transaction(() => {
      // 1. 幂等检查优先于状态门禁
      const cachedReceipt = this.engine.store.get<{
        request_id: string;
        request_digest: string;
        response: PlanApprovalResponse;
        workflow: any;
        document?: any;
      }>("plan_approval_receipt", requestId);

      if (cachedReceipt) {
        if (cachedReceipt.request_digest !== requestDigest) {
          throw new FlowError(
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
            `请求 ID ${requestId} 已被用于不同的审批内容，禁止修改重试`,
            409,
          );
        }
        return {
          ok: true,
          approval: cachedReceipt.response.approval,
          workflow: cachedReceipt.workflow,
          document: cachedReceipt.document,
          response: cachedReceipt.response,
        };
      }

      // 2. 检查工作流版本与状态门禁
      const w = this.engine.get(workflowId);
      if (expectedVersion !== undefined && w.version !== expectedVersion) {
        throw new FlowError(
          "VERSION_CONFLICT",
          `工作流版本冲突: 期望 v${expectedVersion}, 当前 v${w.version}`,
          409,
        );
      }

      if (!["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(w.state)) {
        throw new FlowError(
          "INVALID_STATE",
          `当前工作流处于 ${w.state} 状态，没有待批准的计划`,
          409,
        );
      }

      // 3. 校验文档（若提供 documentId）
      let approvedDoc: any = undefined;
      if (documentId && !this.documentService) { throw new FlowError("DOCUMENT_SERVICE_MISSING", "文档审批服务不可用", 500); }
      if (documentId && this.documentService) {
        const approvalDocument = this.engine.store.must<any>(
          "project_document",
          documentId,
        );
        const plan = this.engine.plan(workflowId);
        const expectedDocHash =
          plan.plan.design_ref?.content_hash ??
          hash((plan.plan.markdown ?? "").replace(/\r\n/g, "\n"));

        const passedDocRevision = documentRevision ?? plan.revision;
        const passedDocHash = documentHash ?? expectedDocHash;

        if (
          approvalDocument.id !== documentId ||
          plan.revision !== passedDocRevision ||
          expectedDocHash !== passedDocHash
        ) {
          throw new FlowError(
            "DOCUMENT_BINDING_INVALID",
            "批准文档不是当前正式计划",
            409,
          );
        }

        approvedDoc = this.documentService.approveDocument(
          workflowId,
          documentId,
          {
            request_id: requestId,
            expected_version: expectedVersion ?? w.version,
            document_revision: passedDocRevision,
            document_hash: passedDocHash,
            feedback_cursor: feedbackCursor,
          },
        );
      }

      // 非空指令及 V2 空正文都必须纳入用户确认的绑定。
      const expectedExtra = instructions.text || schemaVersion === 2
        ? { execution_instructions_hash: instructions.text_hash }
        : {};
      const suppliedHash = (binding.extra as Record<string, unknown> | undefined)?.execution_instructions_hash;
      if (suppliedHash !== undefined && suppliedHash !== instructions.text_hash) {
        throw new FlowError("INSTRUCTIONS_HASH_MISMATCH", "指令摘要与正文不一致", 409);
      }
      const bHash = objectHash(binding);
      const isExtraMatched = bHash === objectHash(this.engine.binding(workflowId, "approve", expectedExtra));
      const isDefaultMatched = bHash === objectHash(this.engine.binding(workflowId, "approve", {}));
      if (!isExtraMatched && !isDefaultMatched) {
        throw new FlowError("BINDING_CHANGED", "计划或审批指令已变化，请重新核对", 409);
      }
      if (!callerProof) { throw new FlowError("PROOF_INVALID", "缺少人工审批凭据", 403); }
      this.engine.auth.consumeProof(callerProof, "approve", binding);
      const effectiveProof = callerProof;

      // 6. 原子写入 PlanApprovalRecordV2
      const approvalKey = `${workflowId}-${w.plan_revision}`;
      const approvalRecord: PlanApprovalRecordV2 = {
        schema_version: 2,
        workflow_id: workflowId,
        plan_revision: w.plan_revision,
        revision: w.plan_revision,
        plan_hash: w.plan_hash ?? "",
        document_hash: documentHash ?? null,
        request_id: requestId,
        approved_at: now(),
        proof: effectiveProof,
        execution_instructions: instructions,
      };

      this.engine.store.put("approval", approvalKey, workflowId, approvalRecord);

      // 7. 清理并流转工作流
      this.engine.clearCurrentImplementationIntent(workflowId);
      this.engine.supersedePendingContinuation(workflowId);
      this.engine.store.remove("pending_dispatch_purpose", workflowId);
      const updatedWorkflow = this.engine.transition(
        workflowId,
        [w.state],
        "QUEUED",
        "prepare",
      );

      this.engine.scheduler.enqueue(workflowId, w.project_id);
      this.engine.store.enqueue(workflowId, "dispatch", {});

      const { proof: _proof, ...publicApproval } = approvalRecord;
      const response: PlanApprovalResponse = {
        workflow_id: workflowId,
        approval: publicApproval as PlanApprovalRecordV2,
        request_id: requestId,
        transitioned: true,
      };

      // 8. 写入幂等回执
      this.engine.store.put("plan_approval_receipt", requestId, workflowId, {
        request_id: requestId,
        request_digest: requestDigest,
        response,
        workflow: updatedWorkflow,
        document: approvedDoc,
        created_at: now(),
      });

      return {
        ok: true,
        approval: publicApproval,
        workflow: updatedWorkflow,
        document: approvedDoc,
        response,
      };
    });
  }
}
