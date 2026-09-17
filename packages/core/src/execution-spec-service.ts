import type { Store } from "../../store/src/store.js";
import {
  type ExecutionSpec,
  type ToolProfile,
  type SupportedAdapterId,
  SupportedAdapters,
  ExecutionSpecSchema,
  ToolProfileSchema,
} from "../../contracts/src/execution-spec.js";
import { FlowError, requireCondition, Id } from "../../contracts/src/index.js";
import { id, now, objectHash } from "./util.js";

export interface UpdateExecutionSpecRequest {
  request_id: string;
  expected_version: number;
  workflow_id: string;
  planner_profile: ToolProfile;
  executor_profile: ToolProfile;
  template_id?: string;
  template_revision?: number;
  interrupt_requested?: boolean;
}

export class ExecutionSpecService {
  constructor(private store: Store) {}

  /**
   * 获取工作流当前的最新执行配置快照
   */
  getLatestSpec(workflowId: string): ExecutionSpec {
    const specs = this.store.list<ExecutionSpec>("execution_spec", workflowId);
    requireCondition(
      specs.length > 0,
      "SPEC_NOT_FOUND",
      `未找到工作流 ${workflowId} 的执行配置`,
      404,
    );
    specs.sort((a, b) => b.revision - a.revision);
    return specs[0]!;
  }

  /**
   * 获取工作流特定修订版本的执行配置
   */
  getSpecByRevision(workflowId: string, revision: number): ExecutionSpec {
    const specs = this.store.list<ExecutionSpec>("execution_spec", workflowId);
    const matched = specs.find((s) => s.revision === revision);
    requireCondition(
      matched,
      "SPEC_REVISION_NOT_FOUND",
      `未找到执行配置修订版本 r${revision}`,
      404,
    );
    return matched!;
  }

  /**
   * 发布新的执行配置修订版本 (RQ-03)
   */
  updateExecutionSpec(req: UpdateExecutionSpecRequest): {
    spec: ExecutionSpec;
    interruptRequired: boolean;
  } {
    return this.store.transaction(() => {
      const workflowId = req.workflow_id;
      Id.parse(req.request_id);
      const key = workflowId + ":" + req.request_id,
        requestHash = objectHash(req);
      const prior = this.store.get<any>("spec_update_receipt", key);
      if (prior) {
        requireCondition(
          prior.hash === requestHash,
          "IDEMPOTENCY_CONFLICT",
          "同一请求不能修改执行配置",
          409,
        );
        return prior.result;
      }
      const currentSpec = this.getLatestSpec(workflowId);
      requireCondition(
        req.expected_version === currentSpec.revision,
        "VERSION_CONFLICT",
        "执行配置版本已变化",
        409,
      );

      // 严格校验 Profile 合同
      const plannerProfile = ToolProfileSchema.parse(req.planner_profile);
      const executorProfile = ToolProfileSchema.parse(req.executor_profile);

      const mode =
        plannerProfile.adapterId === executorProfile.adapterId
          ? "single_tool"
          : "composite";
      const nextRevision = currentSpec.revision + 1;

      const newSpec: ExecutionSpec = {
        id: id("spec"),
        revision: nextRevision,
        workflow_id: workflowId,
        template_id: req.template_id ?? currentSpec.template_id,
        template_revision:
          req.template_revision ?? currentSpec.template_revision,
        mode,
        plannerProfile,
        executorProfile,
        created_at: now(),
      };

      // 校验完整 Schema
      ExecutionSpecSchema.parse(newSpec);

      // 持久化新 revision，完全冻结历史 revision
      this.store.put("execution_spec", newSpec.id, workflowId, newSpec);

      const interruptRequired = Boolean(req.interrupt_requested);
      if (interruptRequired) {
        // 在 outbox 中写入通知，由调度引擎在安全边界进行中断或在新 Run 时生效
        this.store.enqueue(workflowId, "dispatch_run", {
          workflow_id: workflowId,
          purpose: "spec_switch",
          spec_revision: nextRevision,
          interrupted: true,
        });
      }

      const result = { spec: newSpec, interruptRequired };
      this.store.put("spec_update_receipt", key, workflowId, {
        hash: requestHash,
        result,
      });
      return result;
    });
  }
}
