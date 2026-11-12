import type { FastifyPluginAsync } from "fastify";
import { Id } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../../../../packages/store/src/store.js";
import { WorkflowAsideHistory } from "../../../../packages/asides/src/workflow-history.js";
import {
  optionalString,
  parseAfterCursor,
  parseOptionalInt,
} from "./aside-query.js";

export type WorkflowAsidesPluginOptions = {
  store: Store;
  human: (request: any) => void;
};

/**
 * 按任务（workflowId）隔离的临时提问历史、位置、详情与增量更新路由。
 */
export const workflowAsidesPlugin: FastifyPluginAsync<
  WorkflowAsidesPluginOptions
> = async (app, opts) => {
  const history = new WorkflowAsideHistory(opts.store);

  app.get("/api/workflows/:workflowId/aside-history", async (req) => {
    opts.human(req);
    const workflowId = Id.parse(
      (req.params as { workflowId: string }).workflowId,
    );
    const query = (req.query || {}) as Record<string, unknown>;
    return history.listPage(workflowId, {
      limit: parseOptionalInt(query.limit),
      before: optionalString(query.before),
      snapshot_cursor: parseOptionalInt(query.snapshot_cursor),
    });
  });

  app.get("/api/workflows/:workflowId/asides/:asideId", async (req) => {
    opts.human(req);
    const params = req.params as { workflowId: string; asideId: string };
    const workflowId = Id.parse(params.workflowId);
    const asideId = Id.parse(params.asideId);
    return history.getDetail(workflowId, asideId);
  });

  app.get(
    "/api/workflows/:workflowId/asides/:asideId/position",
    async (req) => {
      opts.human(req);
      const params = req.params as { workflowId: string; asideId: string };
      const workflowId = Id.parse(params.workflowId);
      const asideId = Id.parse(params.asideId);
      const query = (req.query || {}) as Record<string, unknown>;
      return history.position(
        workflowId,
        asideId,
        parseOptionalInt(query.snapshot_cursor),
      );
    },
  );

  app.get("/api/workflows/:workflowId/aside-updates", async (req) => {
    opts.human(req);
    const workflowId = Id.parse(
      (req.params as { workflowId: string }).workflowId,
    );
    const query = (req.query || {}) as Record<string, unknown>;
    const after = parseAfterCursor(query.after);
    return history.listUpdates(workflowId, after);
  });
};
