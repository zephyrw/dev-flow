import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "../../../packages/store/src/store.js";
import { AgyRecoveryCheckpointManager } from "../../../packages/runtime/src/agy-recovery-checkpoint.js";
import { AgyWorkflowRecoveryCoordinator } from "../../../packages/runtime/src/agy-workflow-recovery.js";
import { FlowError } from "../../../packages/contracts/src/index.js";

const requestId = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const ref = z.string().min(1).max(200);

export const CancelRecoveryBodySchema = z
  .object({
    request_id: requestId,
    expected_revision: revision,
  })
  .strict();

export interface RecoveryQueryPort {
  get(workflowId: string): any;
}

export function registerAgyWorkflowRecoveryRoutes(
  app: FastifyInstance,
  store: Store,
  engine: RecoveryQueryPort & { cancelAccountRecoveryTarget?: any; cancelQueuedAccountRecovery?: any; stopRun?: any },
  human: (req: any) => void,
) {
  const coordinator = new AgyWorkflowRecoveryCoordinator();
  const checkpointManager = new AgyRecoveryCheckpointManager(store);

  // 工作流账号恢复安全 DTO 列表 (R2-D10 / CR27, CR29)
  app.get("/api/workflows/:id/agy-recoveries", async (req) => {
    human(req);
    const { id: workflowId } = z.object({ id: ref }).parse(req.params);
    engine.get(workflowId); // 验证工作流存在
    const progressList = checkpointManager.listRecoveryProgressForWorkflow(workflowId);

    return progressList.map((p) => {
      const manifest = checkpointManager.getRecoveryManifest(p.manifest_id);
      const sourceCheckpoint = manifest
        ? checkpointManager.getSourceCheckpoint(manifest.source_checkpoint_id)
        : undefined;

      return {
        recovery_id: p.recovery_id,
        workflow_id: workflowId,
        manifest_id: p.manifest_id,
        source_run_id: p.source_run_id,
        target_run_id: p.target_run_id ?? null,
        logical_work_id: manifest?.logical_work_id ?? "root",
        decision: p.decision,
        state: p.state,
        reason: p.reason ?? null,
        revision: p.revision,
        budget: sourceCheckpoint?.budget
          ? {
              execution_budget_ms: sourceCheckpoint.budget.execution_budget_ms,
              consumed_ms: sourceCheckpoint.budget.consumed_ms,
              remaining_ms: sourceCheckpoint.budget.remaining_ms,
            }
          : null,
        workspace_complete: !!sourceCheckpoint?.workspace_checkpoint_ref,
        delivery_id: p.delivery_id ?? null,
        started_at: p.started_at ?? null,
        completed_at: p.completed_at ?? null,
      };
    });
  });

  // 单目标恢复取消 (R2-D10 / CR28, N09)
  app.post("/api/workflows/:id/agy-recoveries/:recovery_id/cancel", async (req, reply) => {
    human(req);
    const { id: workflowId, recovery_id: recoveryId } = z
      .object({ id: ref, recovery_id: ref })
      .parse(req.params);
    engine.get(workflowId); // 验证工作流存在

    const body = CancelRecoveryBodySchema.parse(req.body);

    const result = await coordinator.cancelRecovery({
      workflowId,
      recoveryId,
      requestId: body.request_id,
      expectedRevision: body.expected_revision,
      store,
      checkpointManager,
      engine,
    });

    const isStopping = result.progress.state === "delivery_pending" || (result as any).stopping;
    const statusCode = isStopping ? 202 : 200;

    return reply.code(statusCode).send({
      cancelled: result.success,
      recovery_id: recoveryId,
      progress: {
        recovery_id: result.progress.recovery_id,
        workflow_id: workflowId,
        manifest_id: result.progress.manifest_id,
        source_run_id: result.progress.source_run_id,
        target_run_id: result.progress.target_run_id ?? null,
        decision: result.progress.decision,
        state: result.progress.state,
        reason: result.progress.reason ?? null,
        revision: result.progress.revision,
        started_at: result.progress.started_at ?? null,
        completed_at: result.progress.completed_at ?? null,
      },
    });
  });
}
