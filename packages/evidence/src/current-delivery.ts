import {
  type Workflow,
  type Run,
  type Plan,
  type Delivery,
  type DeliveryRevision,
  type AcceptanceResult,
  type Workspace,
  FlowError,
  requireCondition,
  resolveTaskModel,
} from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { WorkspaceFingerprintService } from "../../workspace/src/fingerprint.js";
import { readFileSync, existsSync } from "node:fs";
import { hash } from "../../core/src/util.js";
import { join, basename } from "node:path";

export interface CurrentDeliveryInspection {
  valid: boolean;
  reason?: string;
  revision?: DeliveryRevision;
  delivery?: Delivery;
  acceptanceResults?: AcceptanceResult[];
}

export class CurrentDeliveryReader {
  constructor(private store: Store) {}

  /**
   * 获取当前工作流未被显式作废的最新 DeliveryRevision
   */
  getLatestRevision(workflowId: string): DeliveryRevision | undefined {
    return this.store
      .list<DeliveryRevision>("delivery_revision", workflowId)
      .reverse()
      .find((r) => !r.invalidated);
  }

  /**
   * 读取工作流对应的计划（兼容多版本键）
   */
  getPlan(workflow: Workflow): Plan | undefined {
    let planRecord = this.store.get<{ plan: Plan }>(
      "plan",
      `${workflow.id}-${workflow.plan_revision}`,
    );
    if (!planRecord) {
      planRecord = this.store.get<{ plan: Plan }>("plan", workflow.id);
    }
    return planRecord?.plan;
  }

  /**
   * 严格核验当前 DeliveryRevision 是否处于当前有效状态 (RQ-15, fail-closed)
   * 统一供进度展示、两道质量审查、人工功能核验及最终 Git 交付读取
   */
  inspectCurrentDelivery(
    workflowId: string,
    options: {
      allowPendingExecution?: boolean;
      verifyWorkspaceFingerprint?: boolean;
      verifyArchivedReports?: boolean;
    } = {},
  ): CurrentDeliveryInspection {
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    if (!workflow) {
      return { valid: false, reason: `工作流 ${workflowId} 不存在` };
    }

    const plan = this.getPlan(workflow);
    if (!plan || resolveTaskModel(plan) !== "native-v2") {
      return { valid: false, reason: "非 native-v2 工作流" };
    }

    const activeRev = this.store
      .list<DeliveryRevision>("delivery_revision", workflowId)
      .reverse()
      .find(
        (r) => !r.invalidated && r.plan_revision === workflow.plan_revision,
      );

    if (!activeRev) {
      return {
        valid: false,
        reason: "缺少当前计划版本的有效交付核验记录",
      };
    }

    // 1. 校验计划哈希与快照
    if (
      activeRev.plan_hash !== workflow.plan_hash ||
      (workflow.snapshot_id && activeRev.snapshot_id !== workflow.snapshot_id)
    ) {
      return {
        valid: false,
        revision: activeRev,
        reason: "交付记录与当前工作流计划哈希或快照不一致",
      };
    }

    // 2. 校验对应的 Delivery 记录
    const delivery = this.store
      .list<Delivery>("delivery", workflowId)
      .find((d) => d.id === activeRev.delivery_id && d.status === "passed");
    if (!delivery) {
      return {
        valid: false,
        revision: activeRev,
        reason: "当前交付状态未通过或不存在",
      };
    }

    // 3. 校验工作区存在性与输入指纹 (fail-closed)
    const workspaces = this.store.list<Workspace>("workspace", workflowId);
    if (workspaces.length === 0) {
      return {
        valid: false,
        revision: activeRev,
        delivery,
        reason: "工作流缺少登记的工作区",
      };
    }
    for (const ws of workspaces) {
      if (!existsSync(ws.root)) {
        return {
          valid: false,
          revision: activeRev,
          delivery,
          reason: `工作区目录不存在: ${ws.root}`,
        };
      }
      if (options.verifyWorkspaceFingerprint !== false) {
        const recordedFp = activeRev.input_fingerprints[ws.repo_id];
        if (!recordedFp) {
          return {
            valid: false,
            revision: activeRev,
            delivery,
            reason: `交付记录中缺少仓库 '${ws.repo_id}' 的输入指纹`,
          };
        }
        const currentFp = WorkspaceFingerprintService.compute(
          ws.root,
        ).fingerprint;
        if (currentFp !== recordedFp) {
          return {
            valid: false,
            revision: activeRev,
            delivery,
            reason: `工作区 '${ws.repo_id}' 输入指纹发生漂移`,
          };
        }
      }
    }

    // 4. 校验归档测试报告完整性与原始哈希 (fail-closed)
    if (
      options.verifyArchivedReports !== false &&
      (!delivery.archive_root ||
        !Object.keys(delivery.report_hashes ?? {}).length)
    ) {
      return {
        valid: false,
        revision: activeRev,
        delivery,
        reason: "交付缺少归档报告目录或哈希，须重新提交交付",
      };
    }
    if (options.verifyArchivedReports !== false && delivery.report_hashes) {
      for (const [relPath, expectedHash] of Object.entries(
        delivery.report_hashes,
      )) {
        const archive = join(
          delivery.archive_root!,
          "reports",
          basename(relPath),
        );
        if (basename(relPath) !== relPath || !existsSync(archive)) {
          return {
            valid: false,
            revision: activeRev,
            delivery,
            reason: `归档测试报告文件缺失: ${relPath}`,
          };
        }
        const actualBytes = readFileSync(archive);
        const actualHash = hash(actualBytes);
        if (actualHash !== expectedHash) {
          return {
            valid: false,
            revision: activeRev,
            delivery,
            reason: `归档测试报告已被外部篡改: ${relPath}`,
          };
        }
      }
    }

    // 5. 校验执行 Run 与完成状态 (fail-closed)
    if (activeRev.run_id) {
      const run = this.store.get<Run>("run", activeRev.run_id);
      if (
        !run ||
        run.workflow_id !== workflowId ||
        run.plan_revision !== workflow.plan_revision ||
        delivery.run_id !== run.id
      ) {
        return {
          valid: false,
          revision: activeRev,
          delivery,
          reason: `关联执行轮次不存在: ${activeRev.run_id}`,
        };
      }
      if (
        !options.allowPendingExecution &&
        (run.status !== "completed" ||
          run.exit_code !== 0 ||
          this.store.get("run_stop", run.id))
      ) {
        return {
          valid: false,
          revision: activeRev,
          delivery,
          reason: `执行轮次 ${run.id} 状态为 ${run.status}，非完成状态`,
        };
      }
    }

    if (
      !activeRev.run_id ||
      (!options.allowPendingExecution && !activeRev.execution_finished)
    ) {
      return {
        valid: false,
        revision: activeRev,
        delivery,
        reason: "交付执行尚未完成 (execution_finished 为 false)",
      };
    }

    // 6. 提取 acceptanceResults
    const acceptanceResults = this.store
      .list<AcceptanceResult>("acceptance_result", workflowId)
      .filter((r) => r.delivery_id === delivery.id);

    const required =
      plan.tests?.filter(
        (t) => !plan.exemptions?.some((e) => e.layer === t.layer),
      ) ?? [];
    const coverage =
      required.length > 0 &&
      required.every((t) =>
        t.expected_case_ids.every((c) =>
          acceptanceResults.some(
            (r) =>
              r.requirement_id === t.id &&
              (r.scene_id === c || r.case_id === c),
          ),
        ),
      );
    if (
      !coverage ||
      acceptanceResults.length === 0 ||
      acceptanceResults.some((r) => r.status !== "passed")
    ) {
      return {
        valid: false,
        revision: activeRev,
        delivery,
        reason: "验收用例未全部通过或为空",
      };
    }

    return {
      valid: true,
      revision: activeRev,
      delivery,
      acceptanceResults,
    };
  }

  /**
   * 必须要求有效交付，否则抛出异常
   */
  requireValidDelivery(workflowId: string): CurrentDeliveryInspection {
    const inspection = this.inspectCurrentDelivery(workflowId);
    if (!inspection.valid || !inspection.delivery || !inspection.revision) {
      throw new FlowError(
        "DELIVERY_INVALID",
        `工作流 ${workflowId} 当前交付无效: ${inspection.reason || "未知原因"}`,
        422,
      );
    }
    return inspection;
  }
}
