import type { FastifyPluginAsync } from "fastify";
import {
  CONVERSATION_ERROR,
  FlowError,
  Id,
} from "../../../../packages/contracts/src/index.js";
import type { Store } from "../../../../packages/store/src/store.js";
import { ProjectAsideHistory } from "../../../../packages/asides/src/project-history.js";

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

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "分页游标无效", 400);
  }
  return value;
}

function parseOptionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "分页游标无效", 400);
  }
  return parsed;
}

function parseAfterCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "增量游标无效", 400);
  }
  return parsed;
}
