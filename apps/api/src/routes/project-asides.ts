import type { FastifyPluginAsync } from "fastify";
import { Id } from "../../../../packages/contracts/src/index.js";
import type { Store } from "../../../../packages/store/src/store.js";
import { ProjectAsideHistory } from "../../../../packages/asides/src/project-history.js";
import {
  optionalString,
  parseAfterCursor,
  parseOptionalInt,
} from "./aside-query.js";

export type ProjectAsidesPluginOptions = {
  store: Store;
  human: (request: any) => void;
};

export const projectAsidesPlugin: FastifyPluginAsync<
  ProjectAsidesPluginOptions
> = async (app, opts) => {
  const history = new ProjectAsideHistory(opts.store);

  app.get("/api/projects/:projectId/asides", async (req) => {
    opts.human(req);
    const projectId = Id.parse((req.params as { projectId: string }).projectId);
    const query = (req.query || {}) as Record<string, unknown>;
    return history.listPage(projectId, {
      limit: parseOptionalInt(query.limit),
      before: optionalString(query.before),
      snapshot_cursor: parseOptionalInt(query.snapshot_cursor),
    });
  });

  app.get("/api/projects/:projectId/asides/:asideId/position", async (req) => {
    opts.human(req);
    const params = req.params as { projectId: string; asideId: string };
    const projectId = Id.parse(params.projectId);
    const asideId = Id.parse(params.asideId);
    const query = (req.query || {}) as Record<string, unknown>;
    return history.position(
      projectId,
      asideId,
      parseOptionalInt(query.snapshot_cursor),
    );
  });

  app.get("/api/projects/:projectId/aside-updates", async (req) => {
    opts.human(req);
    const projectId = Id.parse((req.params as { projectId: string }).projectId);
    const query = (req.query || {}) as Record<string, unknown>;
    const after = parseAfterCursor(query.after);
    return history.listUpdates(projectId, after);
  });
};
