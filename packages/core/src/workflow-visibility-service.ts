import { Store } from "../../store/src/store.js";
import { FlowError, type Workflow } from "../../contracts/src/index.js";
import {
  WorkflowVisibility,
  WorkflowVisibilityUpdateRequest,
  WorkflowVisibilityResponse,
  ArchivedWorkflowSummary,
  WorkflowVisibilityFilter,
} from "../../contracts/src/workflow-visibility.js";
import { now, hash, canonical } from "./util.js";
import type { Engine } from "./engine.js";

export class WorkflowVisibilityService {
  constructor(
    private readonly store: Store,
    private readonly engine?: Engine,
  ) {}

  /**
   * 读取指定任务的可见性元数据
   * 若无记录，投影默认值：archived=false, revision=0
   */
  read(workflowId: string): WorkflowVisibility {
    const record = this.store.get<WorkflowVisibility>(
      "workflow_visibility",
      workflowId,
    );
    if (!record) {
      return {
        schema_version: 1,
        workflow_id: workflowId,
        revision: 0,
        archived: false,
        archived_at: null,
        restored_at: null,
        updated_at: new Date(0).toISOString(),
      };
    }
    return record;
  }

  /**
   * 修改任务归档状态
   * 包含幂等防重、CAS 并发检查、原子写入；不修改 Workflow 原始实体。
   */
  setArchived(
    workflowId: string,
    input: WorkflowVisibilityUpdateRequest,
  ): WorkflowVisibilityResponse {
    const { request_id, expected_visibility_revision, archived } = input;
    const requestDigest = hash(canonical({ workflowId, archived, expected_visibility_revision }));

    return this.store.transaction(() => {
      // 1. 幂等性检查
      const cachedReceipt = this.store.get<{
        request_id: string;
        request_digest: string;
        response: WorkflowVisibilityResponse;
      }>("workflow_visibility_receipt", request_id);

      if (cachedReceipt) {
        if (cachedReceipt.request_digest !== requestDigest) {
          throw new FlowError(
            "IDEMPOTENCY_CONFLICT",
            `请求 ID ${request_id} 已用于不同的可见性操作，禁止修改重试`,
            409,
          );
        }
        return cachedReceipt.response;
      }

      // 2. 确保 workflow 存在
      if (this.engine) {
        this.engine.get(workflowId);
      } else {
        const w = this.store.get<any>("workflow", workflowId);
        if (!w) {
          throw new FlowError(
            "WORKFLOW_NOT_FOUND",
            `任务 ${workflowId} 不存在`,
            404,
          );
        }
      }

      // 3. 读取当前可见性元数据
      const current = this.read(workflowId);

      // 4. CAS 版本核对
      if (current.revision !== expected_visibility_revision) {
        throw new FlowError(
          "VISIBILITY_REVISION_CONFLICT",
          `可见性版本冲突: 期望 revision ${expected_visibility_revision}, 当前为 ${current.revision}`,
          409,
        );
      }

      // 5. 判断是否为 no-op
      if (current.archived === archived) {
        const noopResponse: WorkflowVisibilityResponse = {
          workflow_id: workflowId,
          visibility: current,
          changed: false,
          request_id,
        };
        this.store.put(
          "workflow_visibility_receipt",
          request_id,
          workflowId,
          {
            request_id,
            request_digest: requestDigest,
            response: noopResponse,
            created_at: now(),
          },
        );
        return noopResponse;
      }

      // 6. 状态转换
      const currentTime = now();
      const updated: WorkflowVisibility = {
        schema_version: 1,
        workflow_id: workflowId,
        revision: current.revision + 1,
        archived,
        archived_at: archived ? currentTime : current.archived_at,
        restored_at: archived ? null : currentTime,
        updated_at: currentTime,
      };

      this.store.put(
        "workflow_visibility",
        workflowId,
        workflowId,
        updated,
      );

      const response: WorkflowVisibilityResponse = {
        workflow_id: workflowId,
        visibility: updated,
        changed: true,
        request_id,
      };

      this.store.put(
        "workflow_visibility_receipt",
        request_id,
        workflowId,
        {
          request_id,
          request_digest: requestDigest,
          response,
          created_at: currentTime,
        },
      );

      return response;
    });
  }

  /**
   * 过滤工作流列表
   */
  filterWorkflows(
    workflows: Workflow[],
    filter: WorkflowVisibilityFilter = "visible",
  ): Workflow[] {
    if (filter === "all") return workflows;
    return workflows.filter((w) => {
      const vis = this.read(w.id);
      if (filter === "archived") return vis.archived;
      return !vis.archived;
    });
  }

  /**
   * 查询归档任务列表
   */
  listArchived(options: {
    projectId?: string;
    query?: string;
    limit?: number;
    cursor?: string;
  } = {}): { items: ArchivedWorkflowSummary[]; next_cursor?: string } {
    const allVis = this.store.list<WorkflowVisibility>("workflow_visibility");
    const archivedVis = allVis.filter((v) => v.archived);

    // 按归档时间倒序
    archivedVis.sort((a, b) => {
      const timeA = a.archived_at ? new Date(a.archived_at).getTime() : 0;
      const timeB = b.archived_at ? new Date(b.archived_at).getTime() : 0;
      return timeB - timeA || a.workflow_id.localeCompare(b.workflow_id);
    });

    const items: ArchivedWorkflowSummary[] = [];

    for (const v of archivedVis) {
      const w = this.store.get<any>("workflow", v.workflow_id);
      if (!w) continue;

      if (options.projectId && w.project_id !== options.projectId) {
        continue;
      }

      if (options.query) {
        const q = options.query.toLowerCase();
        const matchTitle = (w.title || "").toLowerCase().includes(q);
        const matchId = w.id.toLowerCase().includes(q);
        if (!matchTitle && !matchId) continue;
      }

      // 获取运行状态
      const isRunning = [
        "PLANNING",
        "EXECUTING",
        "REVIEWING",
        "REPAIR_REVIEWING",
        "COMMITTING",
        "QUEUED",
        "REVIEW_QUEUED",
      ].includes(w.state);

      const workspace = this.store.list<{ branch?: string; root?: string }>("workspace", w.id)[0];
      items.push({
        workflow_id: w.id,
        project_id: w.project_id,
        title: w.title,
        current_state: w.state,
        archived_at: v.archived_at,
        visibility_revision: v.revision,
        branch: workspace?.branch,
        worktree_path: workspace?.root,
        plan_revision: w.plan_revision,
        is_running: isRunning,
      });
    }

    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const offset = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FlowError("INVALID_CURSOR", "归档分页游标无效", 400);
    }
    const paginated = items.slice(offset, offset + limit);
    const nextCursor =
      offset + limit < items.length ? String(offset + limit) : undefined;

    return {
      items: paginated,
      next_cursor: nextCursor,
    };
  }
}
