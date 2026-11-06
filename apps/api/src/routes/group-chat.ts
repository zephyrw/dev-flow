import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgyAccountService } from "../../../../packages/agy-accounts/src/service.js";
import type { Engine } from "../../../../packages/core/src/engine.js";
import type { ModelCatalogService } from "../../../../packages/core/src/model-catalog-service.js";
import { readMaintenanceMarker } from "../../../../packages/installer/src/transaction.js";
import { actionInput, key, modelInput, nickname, scenes } from "../../../../packages/group-chat/src/contracts.js";
import { createGroupModelRunner, type RunModel } from "../../../../packages/group-chat/src/model-runner.js";
import { GroupChat } from "../../../../packages/group-chat/src/service.js";

const title = z.string().trim().min(1).max(100);
const version = z.number().int().positive();
const params = z.object({ id: key });
const mutation = z.object({ version });
const groupInput = z.object({ title, human: nickname, members: z.array(modelInput).min(1).max(16), admin: z.number().int().min(0) });
export function registerGroupChat(app: FastifyInstance, engine: Engine, catalog: ModelCatalogService, human: (req: FastifyRequest) => unknown, accountService: AgyAccountService, runModel?: RunModel, skillPath?: string) {
  const runner = createGroupModelRunner(tool => catalog.getModels(tool), engine.config.models.codex_executable, engine.config.models.agy_executable, accountService);
  const chat = new GroupChat(engine.store, engine.config.storage_root, runModel ?? runner.run,
    () => !engine.maintenanceBlocked && !readMaintenanceMarker(engine.config.storage_root)?.block_new_dispatch, skillPath);
  app.addHook("onClose", async () => {
    await chat.close();
    await runner.close();
  });
  const id = (req: FastifyRequest) => {
    human(req);
    return params.parse(req.params).id;
  };
  app.get("/api/groups", req => { human(req); return chat.groups(); });
  app.post("/api/groups", req => {
    human(req);
    const input = groupInput.parse(req.body);
    return chat.createGroup(input.title, input.human, input.members, input.admin);
  });
  app.put("/api/groups/:id", req => {
    const group = id(req);
    const input = groupInput.extend({ version }).parse(req.body);
    return chat.replaceGroup(group, input.version, input.title, input.human, input.members, input.admin);
  });
  app.get("/api/groups/:id/sessions", req => {
    const group = id(req);
    const query = z.object({ before: key.optional(), query: z.string().max(100).default("") }).parse(req.query);
    return chat.sessions(group, query.before, query.query);
  });
  app.post("/api/groups/:id/sessions", req => {
    const group = id(req);
    const input = z.object({ title, scene: z.enum(scenes) }).parse(req.body);
    return chat.createSession(group, input.title, input.scene);
  });
  for (const route of ["groups", "group-sessions"] as const) {
    const session = route === "group-sessions";
    app.patch(`/api/${route}/:id/nickname`, req => {
      const row = id(req);
      const input = mutation.extend({ member: z.union([key, z.literal("human")]), nickname }).parse(req.body);
      return chat.rename(row, session, input.version, input.member, input.nickname);
    });
    app.patch(`/api/${route}/:id/admin`, req => {
      const row = id(req);
      const input = mutation.extend({ member: key }).parse(req.body);
      return chat.changeAdmin(row, session, input.version, input.member);
    });
  }
  app.get("/api/group-sessions/:id", req => {
    const row = id(req);
    const query = z.object({ before: z.coerce.number().int().positive().optional() }).parse(req.query);
    return chat.view(row, query.before);
  });
  app.post("/api/group-sessions/:id/actions", req => {
    const row = id(req);
    const input = mutation.extend({ request: key, input: actionInput }).parse(req.body);
    return chat.act(row, input.version, input.request, input.input);
  });
  app.get("/api/group-sessions/:id/workspace", req => ({ path: chat.workspace(id(req)) }));
  app.delete("/api/group-sessions/:id", req => {
    const row = id(req);
    const input = mutation.extend({ files: z.boolean() }).parse(req.body);
    return chat.remove(row, input.version, input.files);
  });
  app.get("/api/group-sessions/:id/artifacts/:artifact", (req, reply) => {
    const row = id(req);
    const { artifact } = params.extend({ artifact: key }).parse(req.params);
    const doc = chat.document(row, artifact);
    if ((req.query as { download?: string }).download === "1")
      return reply.type("text/markdown; charset=utf-8").header("Content-Disposition", `attachment; filename="${doc.id}.md"`).send(doc.body);
    return doc;
  });
}
