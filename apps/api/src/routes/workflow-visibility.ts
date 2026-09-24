import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Id,
  WorkflowVisibilityUpdateRequestSchema,
} from "../../../../packages/contracts/src/index.js";
import type { WorkflowVisibilityService } from "../../../../packages/core/src/workflow-visibility-service.js";

export interface WorkflowVisibilityPluginOptions {
  visibilityService: WorkflowVisibilityService;
  human: (request: FastifyRequest) => void;
  broadcast?: (event: string, payload: unknown) => void;
}

const WorkflowParams = z.object({
  id: Id,
});

const ArchivesQuery = z.object({
  project_id: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export const workflowVisibilityPlugin: FastifyPluginAsync<
  WorkflowVisibilityPluginOptions
> = async (app, opts) => {
  const { visibilityService, human, broadcast } = opts;

  // 读取工作流归档/可见性状态
  app.get("/api/workflows/:id/visibility", async (req) => {
    human(req);
    const { id } = WorkflowParams.parse(req.params);
    const visibility = visibilityService.read(id);
    return {
      workflow_id: id,
      visibility,
    };
  });

  // 更新工作流归档状态 (归档 / 恢复)
  app.put("/api/workflows/:id/visibility", async (req) => {
    human(req);
    const { id } = WorkflowParams.parse(req.params);
    const body = WorkflowVisibilityUpdateRequestSchema.parse(req.body);
    const result = visibilityService.setArchived(id, body);

    if (result.changed && broadcast) {
      broadcast("WorkflowVisibilityChanged", {
        workflow_id: id,
        archived: result.visibility.archived,
        revision: result.visibility.revision,
      });
    }

    return result;
  });

  // 查询归档任务列表
  app.get("/api/archives", async (req) => {
    human(req);
    const query = ArchivesQuery.parse(req.query);
    return visibilityService.listArchived({
      projectId: query.project_id,
      query: query.q,
      limit: query.limit,
      cursor: query.cursor,
    });
  });
};
