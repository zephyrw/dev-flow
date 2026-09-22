import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  MutationReceiptSchema,
  RoleOverridesSchema,
  ToolProfileSchema,
  type MutationReceipt,
  type RoleOverrides,
  type ToolProfile,
  type Workflow,
} from "../../contracts/src/index.js";
import { now, objectHash } from "./util.js";
import type { ExecutionSpecService } from "./execution-spec-service.js";
import type { Engine } from "./engine.js";
import { assertProfilesVerified, collectExplicitProfiles } from "./access-guard.js";

const OPERATION_KIND = "model_config_operation";

export type SwitchRequest = {
  request_id: string;
  expected_spec_revision: number;
  planner_profile: ToolProfile;
  executor_profile: ToolProfile;
  role_overrides: RoleOverrides;
  expected_workflow_version: number;
  expected_run_id: string | null;
  resume_after_switch?: boolean;
};

export type SwitchOperation = {
  id: string;
  operation_type: "switch";
  entity_id: string;
  request_id: string;
  payload_hash: string;
  status:
    | "prepared"
    | "stopping"
    | "stopped"
    | "spec_saved"
    | "committed"
    | "rejected";
  created_at: string;
  updated_at: string;
  expected_run_id: string | null;
  expected_spec_revision: number;
  expected_workflow_version: number;
  request: SwitchRequest;
  spec_receipt?: MutationReceipt;
  receipt?: MutationReceipt;
};

function hasOwn(body: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export class ModelSwitchService {
  constructor(
    private store: Store,
    private specs: ExecutionSpecService,
  ) {}

  parseRequest(body: Record<string, unknown>, workflowId: string): SwitchRequest {
    if (hasOwn(body, "expected_version")) {
      throw new FlowError(
        "AMBIGUOUS_VERSION_FIELD",
        "请使用 expected_spec_revision 与 expected_workflow_version，不要再传 expected_version",
        422,
      );
    }
    if (!hasOwn(body, "expected_run_id")) {
      throw new FlowError(
        "ACTIVE_RUN_CHANGED",
        "必须提交 expected_run_id；无运行中轮次时传 null",
        409,
      );
    }
    return {
      request_id: z.string().uuid().parse(body.request_id),
      expected_spec_revision: z
        .number()
        .int()
        .nonnegative()
        .parse(body.expected_spec_revision),
      planner_profile: ToolProfileSchema.parse(body.planner_profile),
      executor_profile: ToolProfileSchema.parse(body.executor_profile),
      role_overrides: RoleOverridesSchema.parse(body.role_overrides),
      expected_workflow_version: z
        .number()
        .int()
        .nonnegative()
        .parse(body.expected_workflow_version),
      expected_run_id:
        body.expected_run_id === null
          ? null
          : z.string().min(1).parse(body.expected_run_id),
      resume_after_switch: body.resume_after_switch === true,
    };
  }

  assertSwitchTarget(workflow: Workflow, req: SwitchRequest) {
    if (req.expected_workflow_version !== workflow.version) {
      throw new FlowError("VERSION_CONFLICT", "工作流版本已变化", 409);
    }
    const currentRun = workflow.run_id ?? null;
    if (req.expected_run_id !== currentRun) {
      throw new FlowError(
        "ACTIVE_RUN_CHANGED",
        "当前运行轮次已变化，不能停止新轮次",
        409,
      );
    }
  }

  private assertSpecRevision(workflowId: string, expected: number) {
    const view = this.specs.readView(workflowId);
    const current = view.persisted ? view.spec.revision : 0;
    if (expected !== current) {
      throw new FlowError("SPEC_VERSION_CONFLICT", "执行配置版本已变化", 409);
    }
  }

  begin(workflowId: string, req: SwitchRequest): SwitchOperation {
    const id = switchOperationId(workflowId, req.request_id);
    const existing = this.store.get<SwitchOperation>(OPERATION_KIND, id);
    if (existing) return existing;
    const operation: SwitchOperation = {
      id,
      operation_type: "switch",
      entity_id: workflowId,
      request_id: req.request_id,
      payload_hash: switchPayloadHash(req),
      status: "prepared",
      created_at: now(),
      updated_at: now(),
      expected_run_id: req.expected_run_id,
      expected_spec_revision: req.expected_spec_revision,
      expected_workflow_version: req.expected_workflow_version,
      request: req,
    };
    this.store.put(OPERATION_KIND, id, workflowId, operation);
    return operation;
  }

  markStopping(operation: SwitchOperation) {
    return this.writeOperation({
      ...operation,
      status: "stopping",
      updated_at: now(),
    });
  }

  markStopped(operation: SwitchOperation) {
    return this.writeOperation({
      ...operation,
      status: "stopped",
      updated_at: now(),
    });
  }

  markSpecSaved(operation: SwitchOperation, receipt: MutationReceipt) {
    return this.writeOperation({
      ...operation,
      status: "spec_saved",
      updated_at: now(),
      spec_receipt: MutationReceiptSchema.parse(receipt),
    });
  }

  complete(operation: SwitchOperation, receipt: MutationReceipt): MutationReceipt {
    const parsed = MutationReceiptSchema.parse(receipt);
    this.writeOperation({
      ...operation,
      status: "committed",
      updated_at: now(),
      receipt: parsed,
    });
    return parsed;
  }

  saveSpec(workflowId: string, req: SwitchRequest): MutationReceipt {
    return this.specs.updateExecutionSpec({
      request_id: req.request_id,
      expected_spec_revision: req.expected_spec_revision,
      workflow_id: workflowId,
      planner_profile: req.planner_profile,
      executor_profile: req.executor_profile,
      role_overrides: req.role_overrides,
      accessVerified: true,
    });
  }

  async applyAfterPause(
    engine: Engine,
    workflowId: string,
    req: SwitchRequest,
  ): Promise<MutationReceipt> {
    const payloadHash = switchPayloadHash(req);
    const existing = this.store.get<SwitchOperation>(
      OPERATION_KIND,
      switchOperationId(workflowId, req.request_id),
    );
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new FlowError(
          "IDEMPOTENCY_CONFLICT",
          "同一请求不能修改为不同内容",
          409,
        );
      }
      if (existing.status === "committed" && existing.receipt) {
        return existing.receipt;
      }
      return this.continueSwitch(engine, existing);
    }
    const workflow = engine.get(workflowId);
    this.assertSwitchTarget(workflow, req);
    this.assertSpecRevision(workflowId, req.expected_spec_revision);
    const operation = this.begin(workflowId, req);
    return this.continueSwitch(engine, operation);
  }

  private async continueSwitch(
    engine: Engine,
    operation: SwitchOperation,
  ): Promise<MutationReceipt> {
    const req = operation.request;
    assertProfilesVerified(this.store, collectExplicitProfiles(
      req.planner_profile, req.executor_profile, req.role_overrides,
    ));
    let current = operation;
    current = await this.ensureStopped(engine, current);
    if (!current.spec_receipt) {
      const receipt = this.saveSpec(current.entity_id, req);
      current = this.markSpecSaved(current, receipt);
    }
    this.assertTargetRunStopped(engine, current);
    const specReceipt = current.spec_receipt;
    if (!specReceipt) {
      throw new FlowError(
        "SWITCH_SPEC_MISSING",
        "暂停切换尚未保存配置回执",
        500,
      );
    }
    const receipt = this.complete(current, {
      ...specReceipt,
      effective_from: "stopped-awaiting-resume",
    });

    if (req.resume_after_switch) {
      try {
        const { resumeApproved } = await import("../../runtime/src/recovery.js");
        resumeApproved(engine, current.entity_id, "user_resume");
        void engine.dispatch();
      } catch (resumeError) {
        // 保存成功但续行失败保留已保存配置和原恢复点
        return receipt;
      }
    }

    return receipt;
  }

  private async ensureStopped(
    engine: Engine,
    operation: SwitchOperation,
  ): Promise<SwitchOperation> {
    this.assertNoReplacementRun(engine, operation);
    const workflow = engine.get(operation.entity_id);
    if (workflow.state === "STOPPING") {
      throw new FlowError("RUN_STILL_STOPPING", "原运行轮次仍在停止，请稍后重试", 409);
    }
    let current = operation;
    if (workflow.state !== "STOPPED") {
      // A null run means the captured queue has not dispatched yet. It still
      // needs a real pause, with the null identity checked by Engine.stop.
      if (operation.status !== "prepared") {
        throw new FlowError("ACTIVE_RUN_CHANGED", "任务已离开本次暂停状态，请重新载入", 409);
      }
      this.assertSwitchTarget(workflow, operation.request);
      current = this.markStopping(operation);
      await engine.stop(operation.entity_id, "controller", operation.expected_run_id);
    }
    // Re-check even when a prior request stopped the process and then lost its
    // response. STOPPED alone does not prove the old async run has unwound.
    await engine.waitForIdle(operation.entity_id);
    this.assertTargetRunStopped(engine, current);
    return current.status === "stopped" || current.status === "spec_saved"
      ? current
      : this.markStopped(current);
  }

  private assertNoReplacementRun(engine: Engine, operation: SwitchOperation) {
    const workflow = engine.get(operation.entity_id);
    if ((workflow.run_id ?? null) !== operation.expected_run_id) {
      throw new FlowError("ACTIVE_RUN_CHANGED", "当前运行轮次已变化，不能停止新轮次", 409);
    }
  }

  private assertTargetRunStopped(engine: Engine, operation: SwitchOperation) {
    this.assertNoReplacementRun(engine, operation);
    if (engine.get(operation.entity_id).state !== "STOPPED") {
      throw new FlowError("RUN_STILL_STOPPING", "任务尚未确认暂停，不能发布暂停切换结果", 409);
    }
  }

  private writeOperation(next: SwitchOperation) {
    this.store.put(OPERATION_KIND, next.id, next.entity_id, next);
    return next;
  }
}

function switchOperationId(workflowId: string, requestId: string) {
  return (
    "op-" + objectHash({ type: "switch", entity: workflowId, requestId })
  ).slice(0, 80);
}

function switchPayloadHash(req: SwitchRequest) {
  return objectHash({
    expected_spec_revision: req.expected_spec_revision,
    planner_profile: req.planner_profile,
    executor_profile: req.executor_profile,
    role_overrides: req.role_overrides,
    expected_workflow_version: req.expected_workflow_version,
    expected_run_id: req.expected_run_id,
  });
}
