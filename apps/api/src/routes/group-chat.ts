import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgyAccountService } from "../../../../packages/agy-accounts/src/service.js";
import type { Engine } from "../../../../packages/core/src/engine.js";
import type { ModelCatalogService } from "../../../../packages/core/src/model-catalog-service.js";
import { ModelAccessService } from "../../../../packages/core/src/model-access-service.js";
import { resolveAgyAccountContext } from "../../../../packages/core/src/model-identity.js";
import { FlowError } from "../../../../packages/contracts/src/index.js";
import { isHydrogenModelId } from "../../../../packages/adapters/agy/src/model-configuration.js";
import { readMaintenanceMarker } from "../../../../packages/installer/src/transaction.js";
import { actionInput, key, modelInput, nickname, scenes } from "../../../../packages/group-chat/src/contracts.js";
import { createGroupModelRunner, type RunModel } from "../../../../packages/group-chat/src/model-runner.js";
import { GroupChat } from "../../../../packages/group-chat/src/service.js";

const title = z.string().trim().min(1).max(100);
const version = z.number().int().positive();
const params = z.object({ id: key });
const mutation = z.object({ version });
const groupInput = z.object({ title, human: nickname, members: z.array(modelInput).min(1).max(16), admin: z.number().int().min(0), model_workspace: z.string().trim().min(1).max(4096).optional() });
export function registerGroupChat(app: FastifyInstance, engine: Engine, catalog: ModelCatalogService, human: (req: FastifyRequest) => unknown, accountService: AgyAccountService, runModel?: RunModel, skillPath?: string, accessService?: ModelAccessService) {
  const access = accessService ?? new ModelAccessService(engine.store, { catalog });
  const loadToolCatalog = async (tool: string, cwd?: string) => {
    const scope = tool === "codebuddy-code" && cwd ? "workspace:" + cwd : undefined;
    if (tool === "agy" && accountService.isManaged()) {
      await accountService.syncActiveAccountFromHost();
    }
    let models = catalog.getModels(tool, scope);
    if (
      (tool === "codebuddy-code" || (tool === "agy" && accountService.isManaged())) &&
      (models.status !== "fresh" || models.discoveryStatus === "missing")
    ) {
      const { operation } = catalog.refreshModels({ adapter: tool, scope_id: scope, request_id: randomUUID() });
      const result = await catalog.waitForOperation(operation.id);
      if (result.status !== "committed") throw new Error(result.error_message ?? "模型目录读取失败，请刷新后重试");
      models = catalog.getModels(tool, scope);
    }
    return models;
  };
  const runner = createGroupModelRunner(loadToolCatalog, engine.config.models.codex_executable, engine.config.models.agy_executable, accountService, async (member, cwd, models, signal) => {
    signal.throwIfAborted();
    const profile = {
      id: member.id, revision: 1, adapterId: member.tool, modelSelection: "explicit" as const,
      selectionKind: "fixed" as const, modelId: member.model, options: {},
      reasoning: member.effort ? { mode: "explicit" as const, value: member.effort } : undefined,
    };
    const requestId = randomUUID();
    const verification = access.verifyAccess({ request_id: requestId, profile, catalog: models, workspaceRoot: cwd });
    let job = verification.job;
    try {
      while (job.status === "queued" || job.status === "checking") {
        signal.throwIfAborted();
        if (Date.now() > Date.parse(job.deadline_at) + 1000) throw new Error("CodeBuddy 模型访问核验超时，请重试本成员");
        await new Promise(resolve => setTimeout(resolve, 50));
        job = access.getVerification(job.id);
      }
      signal.throwIfAborted();
      if (job.status !== "verified") throw new Error(job.error_message ?? "CodeBuddy 模型访问核验失败，请检查工作区配置与账号");
      access.assertCachedAccess(profile, access.identityFromProfile(profile, cwd));
      if (models.nativeConfigScope !== access.resolveNativeConfig(profile, access.identityFromProfile(profile, cwd)).nativeConfigScope)
        throw new Error("CodeBuddy 工作区配置已变化，请刷新模型目录后重试");
    } finally {
      if (!verification.cached && job.request_id === requestId &&
          (signal.aborted || Date.now() > Date.parse(job.deadline_at) + 1000)) await access.cancelVerification(job.id, randomUUID());
    }
  });
  const chat = new GroupChat(engine.store, engine.config.storage_root, runModel ?? runner.run,
    () => !engine.maintenanceBlocked && !readMaintenanceMarker(engine.config.storage_root)?.block_new_dispatch, skillPath);
  app.addHook("onClose", async () => {
    await chat.close();
    await runner.close();
    if (!accessService) await access.close();
  });
  const id = (req: FastifyRequest) => {
    human(req);
    return params.parse(req.params).id;
  };
  const validateGroupMembers = async (members: Array<z.infer<typeof modelInput>>, modelWorkspace?: string) => {
    const agyManaged = accountService.isManaged();
    let agyCatalog: Awaited<ReturnType<typeof loadToolCatalog>> | undefined;
    for (const member of members) {
      if (member.tool !== "agy") continue;
      const hydrogen = isHydrogenModelId(member.model);
      const agyContext = resolveAgyAccountContext(engine.store);
      if (hydrogen && (!agyContext.verified || !agyContext.contextKey)) {
        throw new FlowError("AGY_MODEL_CAPABILITY_UNKNOWN", "当前未确认 AGY 真实账号身份与认证上下文，无法保存 Gemini 4 Hydrogen", 409);
      }
      if (!hydrogen && !agyManaged) {
        const peek = catalog.getModels("agy");
        if (peek.status !== "fresh" || peek.discoveryStatus === "missing") continue;
      }
      if (!agyCatalog) agyCatalog = await loadToolCatalog("agy", modelWorkspace);
      if (
        agyCatalog.status !== "fresh" ||
        agyCatalog.discoveryStatus === "missing" ||
        (hydrogen && (!agyCatalog.accountContextKey || agyCatalog.accountContextKey !== agyContext.contextKey))
      ) {
        throw new FlowError("MODEL_NOT_LISTED", "当前 AGY 账号模型目录尚未确认，无法保存群配置", 422);
      }
      const entry = agyCatalog.entries.find(
        item => item.nativeId === member.model && !item.hidden && item.availability === "listed" && item.selectionKind === "fixed",
      );
      if (!entry) {
        throw new FlowError("MODEL_NOT_LISTED", `当前 AGY 账号不支持模型 ${member.model}`, 422);
      }
      if (member.effort) {
        if (entry.effort.status !== "supported" || !entry.effort.values.includes(member.effort)) {
          throw new FlowError("EFFORT_UNSUPPORTED", `模型 ${member.model} 不支持思考强度 ${member.effort}`, 422);
        }
        const expectedVariant = entry.effort.variants?.[member.effort];
        if (expectedVariant && expectedVariant !== member.model) {
          throw new FlowError("EFFORT_UNSUPPORTED", `模型 ${member.model} 与思考强度 ${member.effort} 不匹配`, 422);
        }
      }
    }
  };
  app.get("/api/groups", req => { human(req); return chat.groups(); });
  app.post("/api/groups", async req => {
    human(req);
    const input = groupInput.parse(req.body);
    await validateGroupMembers(input.members, input.model_workspace);
    return chat.createGroup(input.title, input.human, input.members, input.admin, input.model_workspace);
  });
  app.put("/api/groups/:id", async req => {
    const group = id(req);
    const input = groupInput.extend({ version }).parse(req.body);
    await validateGroupMembers(input.members, input.model_workspace);
    return chat.replaceGroup(group, input.version, input.title, input.human, input.members, input.admin, input.model_workspace);
  });
  app.delete("/api/groups/:id", async req => {
    const group = id(req);
    return chat.deleteGroup(group);
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
  app.patch("/api/group-sessions/:id/title", req => {
    const row = id(req);
    const input = mutation.extend({ title }).parse(req.body);
    return chat.renameSession(row, input.version, input.title);
  });
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
