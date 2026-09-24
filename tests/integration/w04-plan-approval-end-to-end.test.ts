import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { PlanApprovalService } from "../../packages/core/src/plan-approval-service.js";
import { verifyAndResolveExecutionInstructions } from "../../packages/core/src/execution-instructions.js";
import { objectHash } from "../../packages/core/src/util.js";

describe("W04: 计划审批附加执行指令端到端集成测试", () => {
  let fixtureRoot: string | undefined;

  afterEach(() => {
    if (fixtureRoot) {
      try {
        rmSync(fixtureRoot, { recursive: true, force: true });
      } catch {}
    }
  });

  it("端到端闭环：审批附加指令、V2记录持久化、幂等防重与运行材料解析", async () => {
    const s = setup();
    fixtureRoot = s.root;
    const r = await repository(s.root);
    const p = project(r.repo);
    await s.engine.registerProject(p);

    const w = s.engine.create(
      {
        project_id: p.id,
        title: "端到端审批指令测试",
        request: "实现某特性",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "fixture",
    );

    // 提交计划进入 PLAN_PENDING
    s.engine.submitPlan(
      w.id,
      plan(objectHash(p), r.baseline),
      w.version,
      "plan-req-1",
    );

    const pendingWorkflow = s.engine.get(w.id);
    expect(pendingWorkflow.state).toBe("PLAN_PENDING");

    const planApprovalService = new PlanApprovalService(s.engine);
    const approvalProof = proof(s.engine, w.id, "approve");
    const instructionsText = "尽量复用已有组件；完成测试后再提交。";
    const requestId = "req-approval-e2e-1";

    // 1. 首次审批成功
    const result = await planApprovalService.approve({
      workflowId: w.id,
      requestId,
      binding: approvalProof.binding as any,
      executionInstructionsText: instructionsText,
      callerProof: approvalProof.proof,
    });

    expect(result.ok).toBe(true);
    expect(result.approval.schema_version).toBe(2);
    expect(result.approval.workflow_id).toBe(w.id);
    expect(result.approval.plan_revision).toBe(pendingWorkflow.plan_revision);
    expect(result.approval.execution_instructions.text).toBe(instructionsText);
    expect(result.approval.execution_instructions.scope).toBe("approved-plan");
    expect(result.workflow.state).toBe("QUEUED");

    // 2. 幂等性测试：相同 request_id、相同内容重试，返回既有回执
    const idempotentResult = await planApprovalService.approve({
      workflowId: w.id,
      requestId,
      binding: approvalProof.binding as any,
      executionInstructionsText: instructionsText,
    });
    expect(idempotentResult.ok).toBe(true);
    expect(idempotentResult.approval.request_id).toBe(requestId);
    expect(idempotentResult.approval.execution_instructions.text).toBe(instructionsText);

    // 3. 幂等冲突测试：相同 request_id 但篡改附加指令正文，抛出 409
    await expect(
      planApprovalService.approve({
        workflowId: w.id,
        requestId,
        binding: approvalProof.binding as any,
        executionInstructionsText: "被篡改的指令",
      }),
    ).rejects.toThrow(/已被用于不同的审批内容/);

    // 4. 重复审批冲突测试：对已处于 QUEUED 状态的工作流使用新 request_id 审批，抛出 409 INVALID_STATE
    const newProof = proof(s.engine, w.id, "approve");
    await expect(
      planApprovalService.approve({
        workflowId: w.id,
        requestId: "req-approval-e2e-2",
        binding: newProof.binding as any,
        executionInstructionsText: "新请求",
        callerProof: newProof.proof,
      }),
    ).rejects.toThrow(/没有待批准的计划/);

    // 5. 校验数据库持久化的 approval 记录
    const savedApproval = s.store.get<any>(
      "approval",
      `${w.id}-${pendingWorkflow.plan_revision}`,
    );
    expect(savedApproval).toBeDefined();
    expect(savedApproval.schema_version).toBe(2);
    expect(savedApproval.execution_instructions.text).toBe(instructionsText);

    // 6. 模拟派发运行并校验 run 对象的 approval_ref 与材料解析
    const runId = "run-e2e-exec-1";
    // 构建绑定的 run
    const approvalRecord = savedApproval;
    const run = {
      id: runId,
      workflow_id: w.id,
      plan_revision: pendingWorkflow.plan_revision,
      status: "running" as const,
      approval_ref: {
        approval_id: `${w.id}-${pendingWorkflow.plan_revision}`,
        plan_revision: pendingWorkflow.plan_revision,
        plan_hash: approvalRecord.plan_hash,
        instructions_hash: approvalRecord.execution_instructions.text_hash,
      },
    };
    s.store.put("run", runId, w.id, run);

    const resolved = verifyAndResolveExecutionInstructions(
      s.store,
      w.id,
      run,
      pendingWorkflow.plan_revision,
      approvalRecord.plan_hash,
    );

    expect(resolved.instructions).toBeDefined();
    expect(resolved.instructions?.text).toBe(instructionsText);
    expect(resolved.payload?.approval_id).toBe(`${w.id}-${pendingWorkflow.plan_revision}`);
    expect(resolved.payload?.text).toBe(instructionsText);
    expect(resolved.payload?.scope).toBe("approved-plan");
  });
});
