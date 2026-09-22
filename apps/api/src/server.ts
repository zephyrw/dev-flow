import { createBaseServer } from "./base-server.js";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, basename, normalize } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
  FlowError,
  requireCondition,
  Id,
  ProjectSchema,
  RepairSelectionSchema,
  type FunctionalIssue,
  type RepairModelBatch,
  type Project,
  CONVERSATION_ENTITY,
  type ConversationAttempt,
  type ConversationMessage,
  type Workspace,
  type Run,
} from "../../../packages/contracts/src/index.js";
import { ProjectAssetMigrationService } from "../../../packages/core/src/project-asset-migration.js";
import { decideOperation } from "../../../packages/core/src/interactions.js";
import type { Store } from "../../../packages/store/src/store.js";
import type { ConversationService } from "../../../packages/core/src/conversation-service.js";
import { makeMcp, workerNames } from "../../../packages/mcp/src/tools.js";
import type { Engine } from "../../../packages/core/src/engine.js";
import {
  objectHash,
  hash,
  publicEvent,
  now,
} from "../../../packages/core/src/util.js";
import {
  LocalRuntime,
  runtimeStopPort,
} from "../../../packages/runtime/src/runtime.js";
import { CreateWorkflowService, generateWorkflowId } from "../../../packages/core/src/create-workflow.js";
import { WorkspaceReferenceService } from "../../../packages/workspace/src/references.js";
import { AsideSessionService } from "../../../packages/asides/src/service.js";
import { FunctionalIssueService } from "../../../packages/core/src/functional-issues.js";
import { repositoryInfo, previewWorktreePath } from "../../../packages/git/src/git.js";
import { GitDeliveryCoordinator } from "../../../packages/git/src/delivery-coordinator.js";
import { DocumentService } from "../../../packages/core/src/document-service.js";
import { FeedbackService } from "../../../packages/core/src/feedback-service.js";
import { ModelAccessService } from "../../../packages/core/src/model-access-service.js";
import { ModelCatalogService } from "../../../packages/core/src/model-catalog-service.js";
import {
  assertResumeMode,
  assertStopIdentity,
  attachIssueRepairOptions,
  listFunctionalIssueViews,
  modelErrorRetryable,
  registerModelRoutes,
} from "./model-routes.js";
import { PlanReviewService } from "../../../packages/core/src/plan-review.js";
import { SourceChangeService } from "../../../packages/core/src/source-change.js";
import { listAttachmentRecords } from "../../../packages/evidence/src/archive-consumer.js";
import { registerAgyAccountRoutes, registerAgyWorkflowRecoveryRoutes } from "./agy-account-routes.js";
import { registerAgyAccountPolicyRoutes } from "./agy-account-policy-routes.js";
import { bootstrapAccountService } from "./account-service-bootstrap.js";
import type { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";
import { ExecutionSessionStore } from "../../../packages/core/src/execution-session-store.js";
import { SessionBindingRepairService } from "../../../packages/core/src/session-binding-repair.js";
import { CliDispatchManager } from "../../../packages/runtime/src/cli-dispatch.js";
import {
  generateResumeInstructions,
  createDefaultAdapterRegistry,
  resolveToolExecutable,
  resolveSessionIdentity,
} from "../../../packages/adapters/sdk/src/index.js";
import { nativeLaunch } from "../../../packages/adapters/sdk/src/launch.js";
import { latestSpec, bindProfile } from "../../../packages/core/src/run-profile.js";
import type { ToolProfile } from "../../../packages/contracts/src/execution-spec.js";
import {
  SessionBindingAdoptInputSchema,
  SessionBindingRepairApplyInputSchema,
  SessionBindingRepairRollbackInputSchema,
} from "../../../packages/contracts/src/session-binding.js";
import { conversationFilePlugin } from "./routes/conversation-files.js";
import { projectAsidesPlugin } from "./routes/project-asides.js";
import { conversationPlugin } from "./routes/conversations.js";
import { conversationControlPlugin } from "./routes/conversation-controls.js";
import { conversationMessagePlugin } from "./routes/conversation-messages.js";
import { ConversationFileService } from "../../../packages/core/src/conversation-files.js";
import {
  ConversationControlService,
  CONVERSATION_CONTROL_FENCE,
  type ConversationControlFence,
  type ConversationControlRequest,
  type ConversationControlResult,
} from "../../../packages/core/src/conversation-control.js";
import {
  ConversationMessageService,
  type ConversationMessageResult,
} from "../../../packages/core/src/conversation-message-service.js";
import { conversationServiceOf, engineRecoveryRunPort, bindConversationRecovery } from "../../../packages/runtime/src/profile-runtime.js";
import {
  ConversationRecovery,
} from "../../../packages/runtime/src/conversation-recovery.js";
import {
  resumeApproved,
  reconcileProcesses,
} from "../../../packages/runtime/src/recovery.js";

export async function buildServer(
  engine: Engine,
  options: { webRoot?: string; accountService?: AgyAccountService } = {},
) {
  const { app, humanCheck: human } = createBaseServer({
    get port() { return engine.config.server.port; },
    humanOrigin: engine.config.server.human_origin,
    mode: "full", storageInstance: engine.config.storage_root, registerStatic: false,
    errorRetryable: modelErrorRetryable,
    writeContentTypeAllowed,
  });
  await app.register(websocket, { options: { maxPayload: 65536 } });
  app.get("/api/projects", async (req) => {
    human(req);
    return engine.store.list("project");
  });
  app.post("/api/projects", async (req) => {
    human(req);
    return engine.registerProject(req.body);
  });
  const accountService =
    options.accountService ||
    bootstrapAccountService(engine.store, {
      authHostExecutable: engine.config.agy_accounts.auth_host_executable,
      agyCliPath: engine.config.models.agy_executable,
      hostExecutable: engine.config.host.executable,
      settings: engine.config.agy_accounts,
    });
  const accessService = new ModelAccessService(engine.store, {
    catalog: new ModelCatalogService(engine.store),
    withManagedAccountVerification: (identity, verify) => accountService.withModelVerification(
      { realm_id: identity.realmId, account_id: identity.accountId, auth_epoch: identity.authEpoch }, verify,
    ),
  });
  app.addHook("onClose", async () => {
    await accessService.close();
    if (!options.accountService) await accountService.close();
  });
  const createWorkflowService = new CreateWorkflowService(
    engine.store,
    engine.config,
    accessService,
  );
  const sessionStore = new ExecutionSessionStore(engine.store);
  const dispatchManager = new CliDispatchManager(engine.store);
  const asideService = new AsideSessionService(engine.store);
  const issueService = new FunctionalIssueService(engine.store);
  const documentService = new DocumentService(
    engine.store,
    engine.config.storage_root,
  );
  const feedbackService = new FeedbackService(engine.store);
  const modelServices = registerModelRoutes(app, engine, human, accessService);
  const conversations = conversationServiceOf(engine.store);
  const conversationFiles = new ConversationFileService(
    engine.store,
    engine.config.storage_root,
  );
  const conversationControls = new ConversationControlService(
    engine.store,
    conversations,
    runtimeStopPort(engine.runtime as LocalRuntime | undefined),
  );
  engine.pauseTree = async (workflowId, request) => {
    const fence = existingPauseFence(engine.store, workflowId, request.root_id);
    if (fence) return conversationControls.reconcile(workflowId, fence.control_id);
    return conversationControls.pauseTree(workflowId, request);
  };
  const conversationMessages = new ConversationMessageService({
    store: engine.store,
    files: conversationFiles,
    feedback: feedbackService,
    asides: asideService,
    issues: issueService,
    conversations,
    storageRoot: engine.config.storage_root,
    control: { pauseTree: (workflowId, request) => conversationControls.pauseTree(workflowId, request) },
  });
  const conversationRecovery = new ConversationRecovery({
    store: engine.store,
    conversations,
    controls: conversationControls,
    runPort: engineRecoveryRunPort(engine),
  });
  bindConversationRecovery(engine.store, conversationRecovery);
  await app.register(conversationFilePlugin, {
    files: conversationFiles,
    human,
  });
  await app.register(projectAsidesPlugin, { store: engine.store, human });
  await app.register(conversationPlugin, {
    conversations,
    store: engine.store,
    human,
  });
  await app.register(conversationControlPlugin, {
    controls: conversationControls,
    human,
  });
  await app.register(conversationMessagePlugin, {
    messages: {
      submit: async (workflowId: string, body: unknown) => {
        const result = await conversationMessages.submit(workflowId, body);
        await afterConversationMessage(engine, workflowId, result);
        return result;
      },
    } as ConversationMessageService,
    human,
  });

  app.get("/api/workflows", async (req) => {
    human(req);
    return engine.list();
  });
  app.post("/api/workspaces/preview", async (req) => {
    human(req);
    const b = z
      .object({
        workspace_root: z.string().min(1),
        request_id: z.string().optional(),
        workflow_id: z.string().optional(),
        repo_id: z.string().default("main"),
        workspace_mode: z
          .enum(["existing_workspace", "new_worktree"])
          .default("existing_workspace"),
        explicit_path: z.string().optional(),
        worktree_path: z.string().optional(),
        project_configured_path: z.string().optional(),
        branch: z.string().optional(),
      })
      .parse(req.body);
    const effectiveWorkflowId =
      b.workflow_id ||
      (b.request_id ? generateWorkflowId(b.request_id) : "preview-wf");

    // 服务端读取已登记 Project，客户端不得伪造 project_configured_path
    const normSource = normalize(resolve(b.workspace_root)).toLowerCase();
    const existingProject = engine.store
      .list<Project>("project")
      .find((p) =>
        p.repositories.some(
          (r: any) => normalize(resolve(r.path)).toLowerCase() === normSource,
        ),
      );
    const effectiveRepo =
      existingProject?.repositories.find(
        (r: any) => normalize(resolve(r.path)).toLowerCase() === normSource,
      ) ?? existingProject?.repositories[0];
    const serverConfiguredPath = effectiveRepo?.worktree_base_path;

    return previewWorktreePath({
      sourceRoot: b.workspace_root,
      workflowId: effectiveWorkflowId,
      repoId: effectiveRepo?.id ?? b.repo_id,
      mode: b.workspace_mode,
      explicitPath: b.worktree_path || b.explicit_path,
      projectConfiguredPath: serverConfiguredPath,
      branch: b.branch,
    });
  });

  app.post("/api/workflows", async (req) => {
    human(req);
    const body = req.body as any;
    if (body.workspace_root) {
      // 统一新任务创建服务入口 (N06, CW-D11)
      const res = createWorkflowService.execute({
        request_id:
          body.request_id || body.idempotency_key || `req_${Date.now()}`,
        workspace_root: body.workspace_root,
        request_text: body.request_text || body.request || "",
        refs: body.refs,
        workspace_mode: body.workspace_mode,
        worktree_path: body.worktree_path || body.explicit_path,
        worktree_paths: body.worktree_paths,
        branch: body.branch,
        branches: body.branches,
        planner_profile_id: body.planner_profile_id,
        executor_profile_id: body.executor_profile_id,
        planner_profile: body.planner_profile,
        executor_profile: body.executor_profile,
        role_overrides: body.role_overrides,
        source_defaults_revision: body.source_defaults_revision,
      });
      void engine.dispatch().catch((e) => console.error("调度失败", String(e)));
      return { workflow: res.workflow, is_existing: res.is_existing };
    }
    const b = z
      .object({
        project_id: Id,
        title: z.string().min(1),
        request: z.string().min(1),
        complexity: z.enum(["simple", "complex"]),
        workspace_mode: z.enum(["existing_workspace", "new_worktree"]),
        idempotency_key: Id,
      })
      .parse(req.body);
    return engine.create(b, b.idempotency_key);
  });

  const referenceRoot = async (q: any) => {
    if (q.workflow_id) {
      engine.get(Id.parse(q.workflow_id));
      const workspaces = engine.store.list<any>("workspace", q.workflow_id);
      const ws = q.repo_id
        ? workspaces.find((w) => w.repo_id === q.repo_id)
        : workspaces[0];
      requireCondition(ws, "WORKSPACE_MISSING", "请选择当前任务仓库", 422);
      return ws.root as string;
    }
    requireCondition(
      typeof q.workspace_root === "string" && q.workspace_root.trim(),
      "WORKSPACE_REQUIRED",
      "先选择工作区路径",
      422,
    );
    return (await repositoryInfo(q.workspace_root)).path;
  };
  // 工作区 @ 引用候选与目录浏览路由 (RQ-10)
  app.get("/api/workspaces/references", async (req) => {
    human(req);
    const q = (req.query || {}) as any;
    const query = String(q.query || "");
    const dir = q.directory !== undefined ? q.directory : q.dir;
    const root = await referenceRoot(q);
    if (dir !== undefined) {
      return WorkspaceReferenceService.listDirectory(root, String(dir));
    }
    return WorkspaceReferenceService.searchReferences(root, query);
  });

  // 工作区文件有界预览 (RQ-11)
  app.get("/api/workspaces/reference-preview", async (req) => {
    human(req);
    const q = (req.query || {}) as any;
    const root = await referenceRoot(q);
    return WorkspaceReferenceService.readTextPreview(
      root,
      q.relative_path || q.path || "",
    );
  });

  app.get("/api/workflows/:id/session-bindings", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const w = engine.get(workflowId);
    const bindings = sessionStore.listBindings(workflowId);
    const strategy = (w as any).binding_strategy ?? "unified";
    const migrationPending = (w as any).migration_pending ?? false;

    // CW3-F26: 从当前 workflow.run_id 对应、归属一致的持久 Run/dispatch 取实际 binding ID
    // legacy 或无已确认当前绑定就不返回 current_binding_id。唯一合法绑定的页面便利选择按原合同保留，多个历史绑定不得冒充当前
    let currentBindingId: string | undefined;
    if (strategy !== "legacy") {
      const boundBindings = bindings.filter((b: any) => b.state === "bound");
      if (w.run_id) {
        const dispatches = engine.store.list<any>("cli_dispatch_record", workflowId);
        const currentDispatch = dispatches.find((d: any) => d.run_id === w.run_id);
        if (currentDispatch?.binding_id) {
          const match = boundBindings.find((b: any) => b.id === currentDispatch.binding_id);
          if (match) {
            currentBindingId = match.id;
          }
        }
      }
      // 若无当前 Run 的 dispatch 匹配，但全任务有且仅有唯一一个合法 bound 绑定，按原合同保留便利选择
      if (!currentBindingId && boundBindings.length === 1 && boundBindings[0]) {
        currentBindingId = boundBindings[0].id;
      }
    }

    return {
      workflow_id: workflowId,
      workflow_version: (w as any).version ?? 1,
      binding_strategy: strategy,
      migration_pending: migrationPending,
      bindings,
      current_binding_id: currentBindingId,
    };
  });

  app.post("/api/workflows/:id/session-bindings/adopt", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const input = SessionBindingAdoptInputSchema.parse(req.body);

    // 1. CW3-F16: 幂等检查优先于占用门禁，相同 request_id 正文一致直接重放
    const idemKey = `adopt_${workflowId}_${input.request_id}`;
    const existingIdem = engine.store.get<{ request_hash: string; result: any }>("idempotency_record", idemKey);
    if (existingIdem) {
      const reqDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (existingIdem.request_hash === reqDigest) {
        const wf = engine.get(workflowId);
        return {
          binding: existingIdem.result,
          replayed: true,
          workflow_version: (wf as any).version ?? 1,
        };
      }
      throw new FlowError(
        "IDEMPOTENCY_CONFLICT",
        `相同 request_id (${input.request_id}) 但请求正文不一致`,
        409,
      );
    }

    // 2. 检查写者状态 (CW2-D06 / §9.1 第 3 项: 调度停用 与 写者 idle 必须同时满足)
    const occupancy = dispatchManager.readInvocationOccupancy(workflowId);
    const control = dispatchManager.getDispatchControl(workflowId);
    if (control.dispatch_enabled) {
      throw new FlowError(
        "DISPATCH_NOT_DISABLED",
        "必须先停用任务自动调度，方可接管外部会话",
        409,
      );
    }
    if (occupancy.state !== "idle") {
      throw new FlowError(
        "WRITER_ACTIVE",
        `当前存在未结束的受管调用 (状态: ${occupancy.state})，禁止接管外部会话`,
        409,
      );
    }

    // 3. CW4-F05: 使用请求已有的 profile_ref，从任务关联 execution_spec 的 profile 中解析实际工具配置并检查对应 revision
    const spec = latestSpec(engine.store, workflowId);
    requireCondition(spec, "EXECUTION_SPEC_NOT_FOUND", "未找到任务对应的执行配置 (execution_spec)", 404);
    const profiles = [spec.plannerProfile, spec.executorProfile].filter(
      (p) => p.id === input.profile_ref.id,
    );
    requireCondition(profiles.length > 0, "PROFILE_NOT_FOUND", "指定工具配置不属于当前任务", 404);
    const profile = profiles.find((p) => p.revision === input.profile_ref.revision);
    requireCondition(
      profile,
      "PROFILE_REVISION_MISMATCH",
      "指定工具配置版本已变化，请刷新后重试",
      409,
    );

    // 4. 用该配置和所属 workspace 走现有身份解析流程，把完整真实身份传给 adoptExistingSession
    const workspaces = engine.store.list<Workspace>("workspace", workflowId);
    const targetWs = workspaces.find((w) => w.id === input.workspace_id);
    requireCondition(targetWs, "WORKSPACE_NOT_FOUND", `未找到属于当前任务的工作区: ${input.workspace_id}`, 404);

    const adapterRegistry = createDefaultAdapterRegistry();
    const adapter = adapterRegistry.mustGet(profile.adapterId);
    const resolvedIdentity = await resolveSessionIdentity(adapter, {
      frozenProfile: profile,
      workspace: {
        root: targetWs.root,
        all_workspaces: workspaces,
      },
      effectiveEnvironment: process.env as Record<string, string>,
    });

    if (!resolvedIdentity.resolved) {
      throw new FlowError(
        "IDENTITY_UNVERIFIED",
        resolvedIdentity.unresolved_reason || "会话身份尚未通过可信解析，禁止接管",
        400,
      );
    }

    const binding = sessionStore.adoptExistingSession(workflowId, input, {
      adapter_id: resolvedIdentity.adapter_id,
      host_id: resolvedIdentity.host_id,
      client_scope_id: resolvedIdentity.client_scope_id,
      provider_account_scope: resolvedIdentity.provider_account_scope,
      canonical_model_id: resolvedIdentity.canonical_model_id,
      workspace_identity: resolvedIdentity.workspace_identity,
      workspace_root: targetWs.root,
      source_root: targetWs.source_root ?? targetWs.root,
      repo_id: targetWs.repo_id ?? "main",
      expected_workflow_version: input.expected_workflow_version,
      expected_control_revision: input.expected_control_revision,
    });
    const workflow = engine.get(workflowId);
    return {
      binding,
      replayed: false,
      workflow_version: (workflow as any).version ?? 1,
    };
  });

  // CW2-D02: 资产与工作树迁移服务路由
  app.get("/api/workflows/:id/assets/preview", async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const service = new ProjectAssetMigrationService(engine.store, engine.config.storage_root);
    const q = req.query || {};
    return service.preview({
      workflowId,
      workspaceId: q.workspace_id,
      mode: q.mode,
      explicitTargetRoot: q.target_root,
    });
  });

  app.post("/api/workflows/:id/assets/preview", async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const service = new ProjectAssetMigrationService(engine.store, engine.config.storage_root);
    const b = req.body || {};
    return service.preview({
      workflowId,
      workspaceId: b.workspace_id,
      mode: b.mode,
      explicitTargetRoot: b.target_root,
    });
  });

  app.post("/api/workflows/:id/assets/apply", async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const service = new ProjectAssetMigrationService(engine.store, engine.config.storage_root);
    const body = req.body || {};
    requireCondition(body.request_id, "REQUEST_ID_REQUIRED", "request_id 不能为空", 400);
    return await service.apply({
      ...body,
      workflow_id: workflowId,
    });
  });

  app.post("/api/workflows/:id/assets/resume", async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const service = new ProjectAssetMigrationService(engine.store, engine.config.storage_root);
    const body = req.body || {};
    requireCondition(body.migration_id, "MIGRATION_ID_REQUIRED", "migration_id 不能为空", 400);
    requireCondition(body.request_id, "REQUEST_ID_REQUIRED", "request_id 不能为空", 400);
    return await service.resume(workflowId, body.migration_id, body.request_id);
  });

  app.post("/api/workflows/:id/assets/rollback", async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const service = new ProjectAssetMigrationService(engine.store, engine.config.storage_root);
    const body = req.body || {};
    requireCondition(body.migration_id, "MIGRATION_ID_REQUIRED", "migration_id 不能为空", 400);
    requireCondition(body.request_id, "REQUEST_ID_REQUIRED", "request_id 不能为空", 400);
    return await service.rollback(workflowId, body.migration_id, body.request_id);
  });

  app.post(
    "/api/workflows/:id/session-bindings/repair-preview",
    async (req) => {
      human(req);
      const workflowId = Id.parse((req.params as any).id);
      const repairService = new SessionBindingRepairService(engine.store);
      const expectedVersion = (req.body as any)?.expected_workflow_version;
      return repairService.previewRepair(workflowId, expectedVersion);
    },
  );

  app.post(
    "/api/workflows/:id/session-bindings/repair",
    async (req) => {
      human(req);
      const workflowId = Id.parse((req.params as any).id);
      const input = SessionBindingRepairApplyInputSchema.parse(req.body);
      const repairService = new SessionBindingRepairService(engine.store);
      return repairService.applyRepair(workflowId, input);
    },
  );

  app.post(
    "/api/workflows/:id/session-bindings/repair-rollback",
    async (req) => {
      human(req);
      const workflowId = Id.parse((req.params as any).id);
      const input = SessionBindingRepairRollbackInputSchema.parse(req.body);
      const repairService = new SessionBindingRepairService(engine.store);
      return repairService.rollbackRepair(workflowId, input);
    },
  );

  app.get(
    "/api/workflows/:id/session-bindings/:bindingId/resume-instructions",
    async (req) => {
      human(req);
      const workflowId = Id.parse((req.params as any).id);
      const bindingId = Id.parse((req.params as any).bindingId);
      const binding = sessionStore.getBindingById(bindingId);
      requireCondition(
        binding && binding.workflow_id === workflowId,
        "BINDING_NOT_FOUND",
        "未找到对应的会话绑定",
        404,
      );
      const occupancy = dispatchManager.readInvocationOccupancy(workflowId);
      const control = dispatchManager.getDispatchControl(workflowId);
      const w = engine.get(workflowId);
      const migrationInProgress = Boolean(
        (w as any).migration_pending ||
        control.reasons.some((r: any) => r.reason === "migration")
      );

      const safeEnv: Record<string, string> = {};
      if (binding.adapter_id === "codex" && binding.client_scope_id) {
        safeEnv.CODEX_HOME = binding.client_scope_id;
      } else if (binding.adapter_id === "agy" && binding.client_scope_id) {
        safeEnv.AGY_HOME = binding.client_scope_id;
      }

      // CW4-F02: resume API 从该绑定关联 Run 的冻结 profile 获取原工具入口，复用现有启动入口解析规则
      let cliLaunch: { executablePath: string; prefixArgs: string[] } | undefined;
      const runId = binding.latest_run_id || binding.first_run_id;
      let profile: ToolProfile | undefined;
      if (runId) {
        const r = engine.store.get<Run>("run", runId);
        profile = (r as any)?.profile;
      }
      if (!profile) {
        const spec = latestSpec(engine.store, workflowId);
        if (spec) {
          profile =
            spec.executorProfile.adapterId === binding.adapter_id
              ? spec.executorProfile
              : spec.plannerProfile.adapterId === binding.adapter_id
                ? spec.plannerProfile
                : undefined;
        }
      }
      if (!profile) {
        try {
          const bp = bindProfile(engine.store, engine.config, workflowId, "implement");
          if (bp.profile.adapterId === binding.adapter_id) {
            profile = bp.profile;
          }
        } catch {}
      }

      if (profile) {
        try {
          const adapter = createDefaultAdapterRegistry().get(binding.adapter_id as any);
          if (adapter) {
            const adp = adapter as any;
            const executablePath = resolveToolExecutable(
              adp.defaultBinaryName,
              profile.executableRef,
              adp.fallbackDirs,
            );
            if (executablePath) {
              const launch = nativeLaunch(executablePath, binding.adapter_id);
              const extraPrefix = Array.isArray((profile.options as any)?.prefixArgs)
                ? (profile.options as any).prefixArgs
                : [];
              cliLaunch = {
                executablePath: launch.executable,
                prefixArgs: [...launch.prefix, ...extraPrefix],
              };
            }
          }
        } catch {}
      }

      return generateResumeInstructions({
        bindingId: binding.id,
        workflowId: binding.workflow_id,
        adapterId: binding.adapter_id,
        conversationId: binding.conversation_id || "",
        cwd: binding.workspace_root,
        bindingRevision: binding.revision,
        bindingState: binding.state,
        managedWriterState: occupancy.state,
        dispatchEnabled: control.dispatch_enabled,
        modelId: binding.canonical_model_id,
        safeEnv,
        migrationInProgress,
        cliLaunch,
      });
    },
  );

  app.get("/api/workflows/:id/dispatch-control", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    return dispatchManager.getDispatchControl(workflowId);
  });

  app.post("/api/workflows/:id/dispatch-control", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const b = z
      .object({
        request_id: z.string().optional(),
        expected_control_revision: z.number().int().nonnegative().optional(),
        dispatch_enabled: z.boolean(),
        reason: z.string().optional(),
      })
      .parse(req.body);
    return dispatchManager.setDispatchControl({
      workflowId,
      dispatch_enabled: b.dispatch_enabled,
      reason: b.reason,
      request_id: b.request_id,
      expected_control_revision: b.expected_control_revision,
    });
  });

  // /btw 临时只读提问路由 (RQ-09 & 5.2 节)
  app.post("/api/workflows/:id/asides", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const body = (req.body || {}) as any;
    const text = body.text || body.question || "";
    if (body.expected_version !== undefined) {
      const w = engine.get(workflowId);
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }
    let result: ConversationMessageResult | undefined;
    try {
      result = await conversationMessages.submitAside(workflowId, {
        request_id: body.request_id || body.idempotency_key || `req_${Date.now()}`,
        text,
        refs: body.refs ?? [],
        attachment_ids: body.attachment_ids ?? [],
        root_conversation_id: body.root_conversation_id,
        expected_generation: body.expected_generation,
      });
    } catch (error) {
      if (!isMissingConversation(error)) throw error;
    }
    if (result) {
      await afterConversationMessage(engine, workflowId, result);
      return (
        engine.store.get("aside_session", result.aside_id ?? "") ?? result
      );
    }
    engine.get(workflowId);
    const aside = asideService.submitQuestion(
      workflowId,
      text,
      body.refs ?? [],
      body.profile_revision,
      undefined,
      body.attachment_ids ?? [],
    );
    void engine.dispatch();
    return aside;
  });

  app.get("/api/workflows/:id/asides", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const list = engine.store.list<any>("aside_session", workflowId);
    list.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const q = (req.query || {}) as any;
    const limit = q?.limit ? Number(q.limit) : 50;
    return list.slice(0, limit);
  });

  app.post("/api/workflows/:id/asides/:asideId/cancel", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const asideId = Id.parse((req.params as any).asideId);
    const body = (req.body || {}) as any;

    if (body.expected_version !== undefined) {
      const w = engine.get(workflowId);
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }

    const aside = engine.store.get<any>("aside_session", asideId);
    requireCondition(
      aside?.workflow_id === workflowId,
      "NOT_FOUND",
      "提问不属于该任务",
      404,
    );
    if (aside.run_id) await engine.runtime?.stop(aside.run_id);
    await pauseAsideTree(
      conversationControls,
      conversations,
      workflowId,
      aside,
    );
    asideService.cancelSession(workflowId, asideId);
    void engine.dispatch();
    return { ok: true, status: "cancelled" };
  });

  app.post("/api/workflows/:id/asides/:asideId/promote", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const asideId = Id.parse((req.params as any).asideId);
    const body = (req.body || {}) as any;

    if (body.expected_version !== undefined) {
      const w = engine.get(workflowId);
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }

    const message = asideService.promoteToFormalFeedback(
      workflowId,
      asideId,
      body.text,
      body.target_revision ?? body.answer_revision,
    );
    engine.queueFormalFeedback(workflowId, message.message_id);
    void engine.dispatch();
    return message;
  });

  app.post("/api/workflows/:id/confirm-function", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const hasOpen = issueService.hasUnresolvedIssues(workflowId);
    requireCondition(
      !hasOpen,
      "UNRESOLVED_ISSUES",
      "存在未关闭的功能问题，无法确认功能通过",
      422,
    );
    const body = z
      .object({
        request_id: Id,
        expected_version: z.number().int(),
        snapshot_id: z.string().min(1).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    const key = "confirm-function:" + workflowId + ":" + body.request_id;
    const prior = engine.store.get<any>("confirmation_receipt", key);
    if (prior) {
      requireCondition(
        prior.hash === objectHash(body),
        "IDEMPOTENCY_CONFLICT",
        "相同确认请求内容不同",
        409,
      );
      return prior.response;
    }
    const wf = engine.get(workflowId);
    const expectedSnapshot = wf.snapshot_id ?? null;
    const bodySnapshot = body.snapshot_id ?? null;
    requireCondition(
      wf.version === body.expected_version &&
        expectedSnapshot === bodySnapshot,
      "VERSION_CONFLICT",
      "核验对象已变化",
      409,
    );
    const binding = engine.binding(workflowId, "accept");
    const proof = engine.auth.recordConfirmation("accept", binding);
    try {
      const workflow = await engine.accept(workflowId, proof, binding);
      const response = { ok: true, workflow };
      engine.store.put("confirmation_receipt", key, workflowId, {
        hash: objectHash(body),
        response,
      });
      void engine.dispatch().catch((e) => console.error("调度失败", String(e)));
      return response;
    } finally {
      engine.store.remove("human_proof", proof);
    }
  });

  app.post("/api/workflows/:id/cleanup/retry", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const body = (req.body || {}) as any;

    const w = engine.get(workflowId);
    requireCondition(
      ["CLEANUP_PENDING", "COMPLETED", "COMMITTED", "FAILED"].includes(w.state),
      "INVALID_STATE",
      `当前状态 (${w.state}) 不允许执行工作区清理或重试`,
      409,
    );

    if (body.expected_version !== undefined) {
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }

    const gd = new GitDeliveryCoordinator(
      engine.store,
      engine.config.workspace_root,
    );

    // CW-D01: 旧 /cleanup/retry 无本次新选择时只能读状态，不能借旧失败记录继续删
    if (body.explicit_selection !== true || !Array.isArray(body.selected_workspaces)) {
      gd.reconcileCompletedWorkflows(workflowId);
      const receipt = engine.store.get<any>("cleanup_receipt", workflowId);
      const w = engine.get(workflowId);
      return {
        receipt,
        workflow: w,
        message: w.state === "COMPLETED" ? "交付已完成、工作树保留" : "未指定明确清理选择，仅返回当前状态",
      };
    }

    const allWorkspaces = engine.store.list<any>("workspace", workflowId);
    const requestedItems: Array<{ id: string; root?: string; branch?: string; expected_version?: number }> = [];

    for (const item of body.selected_workspaces) {
      if (typeof item === "string") {
        throw new FlowError(
          "INVALID_ARGUMENT",
          "已废弃字符串工作区清理入参，必须传入包含 id、root、branch 的精确结构对象",
          400,
        );
      } else if (item && typeof item === "object" && item.id) {
        requestedItems.push({
          id: item.id,
          root: item.root,
          branch: item.branch,
          expected_version: item.expected_version,
        });
      }
    }

    const receipt = await gd.cleanupWorkspaces(workflowId, requestedItems, {
      explicit_selection: true,
      preview_version: body.preview_version,
      preview_digest: body.preview_digest,
      expected_control_revision: body.expected_control_revision,
      expected_workflow_version: body.expected_version ?? body.expected_workflow_version,
    });
    return { receipt };
  });

  // CW2-D01 / §4 第 6 项规范：只读清理预览
  app.get("/api/workflows/:id/workspaces/cleanup/preview", async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const gd = new GitDeliveryCoordinator(
      engine.store,
      engine.config.workspace_root,
    );
    const requestedIds = req.query?.workspace_ids
      ? (Array.isArray(req.query.workspace_ids)
          ? (req.query.workspace_ids as string[])
          : String(req.query.workspace_ids).split(","))
      : undefined;
    return await gd.previewCleanupWorkspaces(workflowId, requestedIds);
  });

  // 功能问题跟踪路由 (RQ-08 & 5.2 节)
  const handleCreateIssue = async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const body = (req.body || {}) as any;
    const text = body.text || body.description || "";
    requireCondition(
      text.trim().length > 0,
      "EMPTY_DESCRIPTION",
      "问题描述不能为空",
      400,
    );

    if (body.expected_version !== undefined) {
      const w = engine.get(workflowId);
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }

    const requestId = body.request_id ?? crypto.randomUUID();
    const assignRepair = (issue: FunctionalIssue) => attachIssueRepairOptions(modelServices.repairs, {
      workflow_id: workflowId,
      request_id: requestId,
      issue,
      body,
      store: engine.store,
      specs: modelServices.specs,
    });
    let result: ConversationMessageResult | undefined;
    try {
      result = await conversationMessages.submitFunctional(workflowId, {
        request_id: requestId,
        text,
        refs: body.refs ?? [],
        attachment_ids: body.attachment_ids ?? [],
        root_conversation_id: body.root_conversation_id,
        expected_generation: body.expected_generation,
      }, {
        idempotencyContext: {
          repair_model: body.repair_model,
          remember_for_task: body.remember_for_task,
          expected_spec_revision: body.expected_spec_revision,
        },
        onIssueCreated: assignRepair,
      });
    } catch (error) {
      if (!isMissingConversation(error)) throw error;
    }
    if (!result) {
      requireCondition(
        engine.get(workflowId).state === "HUMAN_PENDING",
        "INVALID_STATE",
        "功能核验阶段才能提交功能问题",
        409,
      );
      const issue = engine.store.transaction(() => {
        const created = issueService.createIssue(
          workflowId,
          text,
          body.refs ?? [],
          {},
          body.attachment_ids ?? [],
        );
        engine.store.put("functional_fix_intent", workflowId, workflowId, {
          ...engine.store.get<Record<string, unknown>>("functional_fix_intent", workflowId),
          source_snapshot: engine.get(workflowId).snapshot_id,
        });
        const message = feedbackService.submitFeedback({
          workflow_id: workflowId,
          request_id: body.request_id ?? created.issue_id,
          kind: "functional",
          text,
          refs: body.refs ?? [],
          attachment_ids: body.attachment_ids ?? [],
        });
        assignRepair(created);
        engine.queueFormalFeedback(workflowId, message.message_id);
        return created;
      });
      void engine.dispatch();
      return issue;
    }
    await afterConversationMessage(engine, workflowId, result);
    const saved = readConversationMessage(
      engine.store,
      workflowId,
      result.message_id,
    );
    return (
      issueService
        .listIssues(workflowId)
        .find((item) => item.issue_id === saved?.functional_issue_id) ?? result
    );
  };

  const handleListIssues = async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const issues = issueService.listIssues(workflowId);
    const views = listFunctionalIssueViews(
      engine,
      modelServices.specs,
      workflowId,
    );
    return issues.map((issue) => {
      const view = views.find((item) => item.issue.issue_id === issue.issue_id);
      return view ? { ...issue, ...view } : issue;
    });
  };

  const handleConfirmIssue = async (req: any) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const issueId = Id.parse((req.params as any).issueId);
    const body = z
      .object({
        request_id: z.string().uuid().optional(),
        expected_version: z.number().int().optional(),
        delivery_revision_id: z.string().optional(),
        passed: z.boolean(),
        feedback: z.string().optional(),
        repair_model: RepairSelectionSchema.optional(),
        remember_for_task: z.boolean().optional(),
        batch_id: z.string().optional(),
        expected_assignment_revision: z.number().int().nonnegative().optional(),
        expected_spec_revision: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);
    const requestId = body.request_id ?? crypto.randomUUID();
    const operationId = objectHash({ workflowId, issueId, requestId });
    const payloadHash = objectHash(body);
    const result = engine.store.transaction(() => {
      const prior = engine.store.get<{ hash: string; issue: FunctionalIssue }>(
        "functional_confirmation",
        operationId,
      );
      if (prior) {
        requireCondition(
          prior.hash === payloadHash,
          "IDEMPOTENCY_CONFLICT",
          "同一请求不能修改为不同内容",
          409,
        );
        return { issue: prior.issue, replayed: true };
      }
      const workflow = engine.get(workflowId);
      if (body.expected_version !== undefined) {
        requireCondition(
          workflow.version === body.expected_version,
          "VERSION_CONFLICT",
          "工作流版本已变化",
          409,
        );
      }
      const currentIssue = issueService
        .listIssues(workflowId)
        .find((issue) => issue.issue_id === issueId);
      requireCondition(
        workflow.state === "HUMAN_PENDING" &&
          currentIssue?.status === "ready_for_retest",
        "INVALID_STATE",
        "只能在等待验收时复测已完成修复的问题",
        409,
      );
      // main accepts lightweight completion records here; human retesting does
      // not require a separate delivery-evidence entity.
      requireCondition(
        body.delivery_revision_id === undefined ||
          body.delivery_revision_id === currentIssue!.fix_delivery_id,
        "DELIVERY_STALE",
        "问题已由后续轮次修复，请刷新后复测",
        409,
      );
      const changingSelection =
        body.repair_model !== undefined || body.remember_for_task === true;
      requireCondition(
        !body.passed || !changingSelection,
        "INVALID_REQUEST",
        "确认通过时不能同时修改修复处理者",
        422,
      );
      if (changingSelection) {
        const batch = engine.store
          .list<RepairModelBatch>("repair_model_batch", workflowId)
          .find(
            (item) =>
              item.id === body.batch_id &&
              item.kind === "functional" &&
              item.status === "open" &&
              item.issue_ids.includes(issueId),
          );
        requireCondition(
          Boolean(batch),
          "REPAIR_BATCH_MISMATCH",
          "修复批次与当前问题不一致",
          409,
        );
        const expectedAssignment = z
          .number()
          .int()
          .nonnegative()
          .parse(body.expected_assignment_revision);
        const expectedSpec = z
          .number()
          .int()
          .nonnegative()
          .parse(body.expected_spec_revision);
        if (body.repair_model !== undefined) {
          modelServices.repairs.assign({
            workflow_id: workflowId,
            request_id: requestId,
            batch_id: batch!.id,
            expected_assignment_revision: expectedAssignment,
            expected_spec_revision: expectedSpec,
            selection: body.repair_model,
            remember_for_task: body.remember_for_task === true,
          });
        } else {
          // This branch is inside the confirmation transaction. Remembering the
          // existing handler must not clear or replace its one-time assignment.
          const view = modelServices.repairs
            .listOpenBatches(workflowId)
            .find((item) => item.batch.id === batch!.id)!;
          requireCondition(
            (view.assignment?.revision ?? 0) === expectedAssignment,
            "REPAIR_BATCH_MISMATCH",
            "修复指派版本已变化",
            409,
          );
          const spec = modelServices.specs.readView(workflowId).spec;
          modelServices.specs.updateExecutionSpec({
            workflow_id: workflowId,
            request_id: requestId,
            expected_spec_revision: expectedSpec,
            planner_profile: spec.plannerProfile,
            executor_profile: spec.executorProfile,
            role_overrides: {
              ...spec.roleOverrides,
              functional_fixer: {
                mode: "explicit",
                profile: view.assignment?.profile ?? view.inherited_profile,
              },
            },
          });
        }
      }
      const issue = issueService.userConfirmIssue(
        workflowId,
        issueId,
        body.passed,
        body.feedback,
      );
      if (!body.passed) {
        engine.store.put("functional_fix_intent", workflowId, workflowId, {
          ...engine.store.get<Record<string, unknown>>(
            "functional_fix_intent",
            workflowId,
          ),
          source_snapshot: workflow.snapshot_id,
        });
        const message = feedbackService.submitFeedback({
          request_id: requestId,
          workflow_id: workflowId,
          kind: "functional",
          text: body.feedback ?? issue.description,
          refs: issue.refs,
        });
        engine.queueFormalFeedback(workflowId, message.message_id);
      }
      engine.store.put("functional_confirmation", operationId, workflowId, {
        hash: payloadHash,
        issue,
      });
      return { issue, replayed: false };
    });
    if (!body.passed && !result.replayed) void engine.dispatch();
    return result.issue;
  };

  app.post("/api/workflows/:id/functional-issues", handleCreateIssue);
  app.post("/api/workflows/:id/issues", handleCreateIssue);

  app.get("/api/workflows/:id/functional-issues", handleListIssues);
  app.get("/api/workflows/:id/issues", handleListIssues);

  app.post(
    "/api/workflows/:id/functional-issues/:issueId/confirm",
    handleConfirmIssue,
  );
  app.post("/api/workflows/:id/issues/:issueId/confirm", handleConfirmIssue);

  app.get("/api/workflows/:id", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    if ((req.query as any)?.view === "summary") {
      return {
        ...engine.summary(key),
        conversation_tree: conversations.getTree(key),
      };
    }
    const detail = engine.detail(key, false);
    return {
      ...detail,
      events: detail.events.map((e) => engine.store.publicEvent(e)),
      attachment_status: listAttachmentRecords(engine.store, key),
      conversation_tree: conversations.getTree(key),
    };
  });
  app.get("/api/workflows/:id/attachments", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    engine.get(key);
    const deliveryId = z
      .object({ delivery_id: z.string().optional() })
      .parse(req.query).delivery_id;
    return {
      attachment_status: listAttachmentRecords(engine.store, key, deliveryId),
    };
  });
  app.get("/api/workflows/:id/history", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    engine.get(key);
    const query = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    const events = (
      engine.store.db
        .prepare(
          "SELECT data FROM events WHERE workflow_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
        )
        .all(key, query.before ?? Number.MAX_SAFE_INTEGER, query.limit) as {
        data: string;
      }[]
    )
      .reverse()
      .map((row) => engine.store.publicEvent(JSON.parse(row.data)));
    return {
      events,
      next_before: events.length === query.limit ? events[0]!.event_seq : null,
    };
  });
  app.get("/api/workflows/:id/diff", async (req) => {
    human(req);
    const w = engine.get(Id.parse((req.params as any).id));
    const query = z
      .object({ repo_id: Id.optional(), path: z.string().optional() })
      .parse(req.query);
    const snapshot = w.snapshot_id
      ? engine.store.must<any>("snapshot", w.snapshot_id)
      : undefined;
    if (query.repo_id && query.path)
      return engine.git.fileDiff(w.id, query.repo_id, query.path, snapshot);
    return engine.git.changes(w.id, snapshot);
  });
  // 反馈游标查询路由 (RQ-08 & 5.2 节)
  app.get("/api/workflows/:id/messages", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const q = (req.query || {}) as any;
    const afterSeq = q.after_seq !== undefined ? Number(q.after_seq) : 0;
    const limit = q.limit !== undefined ? Number(q.limit) : 50;
    return feedbackService.listMessages(workflowId, afterSeq, limit);
  });

  // 文档详情与版本查询路由 (RQ-07, RQ-08 & 5.2 节)
  app.get("/api/workflows/:id/documents/:documentId", async (req, reply) => {
    human(req);
    const { id: key, documentId } = req.params as any;
    const q = (req.query || {}) as any;
    const revision = q.revision !== undefined ? Number(q.revision) : undefined;

    // 历史 markdown 下载路由兼容 (progress / tests)
    if (["progress", "tests", "plan-self-check"].includes(documentId)) {
      const w = engine.get(key);
      requireCondition(w.plan_revision > 0, "PLAN_MISSING", "尚无计划", 404);
      engine.exportDocuments(key);
      const file = join(
        engine.config.storage_root,
        "documents",
        key,
        "r" + w.plan_revision,
        {
          progress: "开发进度.md",
          tests: "测试进度.md",
          "plan-self-check": "执行模型计划复核.md",
        }[documentId as "progress" | "tests" | "plan-self-check"]!,
      );
      requireCondition(
        existsSync(file),
        "DOCUMENT_MISSING",
        "简单任务的进度包含在计划中",
        404,
      );
      return reply
        .type("text/markdown; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="${documentId}.md"`,
        )
        .send(readFileSync(file));
    }

    try {
      const doc = documentService.getDocument(key, documentId, revision);
      return {
        ok: true,
        document: doc,
      };
    } catch (err) {
      if (documentId === "plan") {
        const w = engine.get(key);
        requireCondition(w.plan_revision > 0, "PLAN_MISSING", "尚无计划", 404);
        const planRecord = engine.store.get<any>(
          "plan",
          `${key}_r${w.plan_revision}`,
        );
        if (planRecord) {
          return {
            ok: true,
            document: {
              id: planRecord.id,
              workflow_id: key,
              document_type: "plan",
              revision: planRecord.revision,
              hash: planRecord.hash,
              content:
                typeof planRecord.plan === "string"
                  ? planRecord.plan
                  : JSON.stringify(planRecord.plan, null, 2),
              approved_by_human: Boolean(planRecord.approved_by_human),
            },
          };
        }
      }
      throw err;
    }
  });

  // 文档严格核验与审批路由 (RQ-08 & 5.2 节)
  app.post("/api/workflows/:id/documents/:documentId/approve", async (req) => {
    human(req);
    const { id: key, documentId } = req.params as any;
    const body = (req.body || {}) as any;
    const requestId = body.request_id || `req_${Date.now()}`;
    const expectedVersion =
      body.expected_version !== undefined
        ? Number(body.expected_version)
        : undefined;
    const docRevision = Number(body.document_revision ?? 1);
    const docHash = String(body.hash || body.document_hash || "");
    const feedbackCursor = Number(body.feedback_cursor ?? 0);

    const w = engine.get(key);
    if (expectedVersion !== undefined) {
      requireCondition(
        w.version === expectedVersion,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${expectedVersion}, 当前 v${w.version}`,
        409,
      );
    }

    const approvalDocument = engine.store.must<any>(
      "project_document",
      documentId,
    );
    requireCondition(
      approvalDocument.id === documentId &&
        engine.plan(key).revision === docRevision &&
        (engine.plan(key).plan.design_ref?.content_hash ??
          hash(
            (engine.plan(key).plan.markdown ?? "").replace(/\r\n/g, "\n"),
          )) === docHash,
      "DOCUMENT_BINDING_INVALID",
      "批准文档不是当前正式计划",
      409,
    );
    return engine.store.transaction(() => {
      const approvedDoc = documentService.approveDocument(key, documentId, {
        request_id: requestId,
        expected_version: expectedVersion ?? w.version,
        document_revision: docRevision,
        document_hash: docHash,
        feedback_cursor: feedbackCursor,
      });

      const binding = engine.binding(key, "approve");
      const receipt = engine.auth.recordConfirmation("approve", binding);
      let engineResult;
      try {
        engineResult = engine.approve(key, receipt, binding);
        void engine.dispatch();
      } finally {
        engine.store.remove("human_proof", receipt);
      }

      return {
        ok: true,
        document: approvedDoc,
        workflow: engineResult,
      };
    });
  });

  app.get(
    "/api/workflows/:id/evidence/:evidence/files/:index",
    async (req, reply) => {
      human(req);
      const a = z
        .object({
          id: Id,
          evidence: Id,
          index: z.coerce.number().int().nonnegative(),
        })
        .parse(req.params);
      const evidence =
        engine.store.get<{
          workflow_id: string;
          files: { path: string; hash: string }[];
        }>("evidence", a.evidence) ??
        engine.store.get<{
          workflow_id: string;
          files: { path: string; hash: string }[];
        }>("development_evidence", a.evidence) ??
        engine.displayEvidence(a.id).find((e) => e.id === a.evidence);
      requireCondition(evidence, "NOT_FOUND", "测试证据不存在", 404);
      requireCondition(
        evidence.workflow_id === a.id,
        "FORBIDDEN",
        "证据不属于当前工作流",
        403,
      );
      const file = evidence.files[a.index];
      requireCondition(file, "FILE_MISSING", "没有该证据文件", 404);
      const content = readFileSync(file.path);
      requireCondition(
        hash(content) === file.hash,
        "EVIDENCE_TAMPERED",
        "证据文件内容已经变化",
      );
      return reply
        .type("application/octet-stream")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(basename(file.path))}`,
        )
        .send(content);
    },
  );
  app.post("/api/workflows/:id/plan", async (req) => {
    human(req);
    const b = z
      .object({
        plan: z.unknown(),
        expected_version: z.number(),
        idempotency_key: Id,
      })
      .parse(req.body);
    return engine.submitValidatedPlan(
      Id.parse((req.params as any).id),
      b.plan,
      b.expected_version,
      b.idempotency_key,
    );
  });
  app.post("/api/workflows/:id/approve", async (req) => {
    human(req);
    const b = z
      .object({ binding: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(req.body);
    const key = Id.parse((req.params as any).id);
    const receipt = engine.auth.recordConfirmation("approve", b.binding);
    try {
      const result = engine.approve(key, receipt, b.binding);
      void engine.dispatch();
      return result;
    } finally {
      engine.store.remove("human_proof", receipt);
    }
  });
  app.post("/api/workflows/:id/plan/reject", async (req) => {
    human(req);
    const result = new PlanReviewService(engine).reject(
      Id.parse((req.params as any).id),
      req.body,
    );
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/source-change/preview", async (req) => {
    human(req);
    const body = z
      .object({ expected_version: z.number().int().positive() })
      .strict()
      .parse(req.body);
    return new SourceChangeService(engine).preview(
      Id.parse((req.params as any).id),
      body.expected_version,
    );
  });
  app.post("/api/workflows/:id/source-change/resolve", async (req) => {
    human(req);
    const result = await new SourceChangeService(engine).resolve(
      Id.parse((req.params as any).id),
      req.body,
    );
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/plan/questions", async (req) => {
    human(req);
    const result = new PlanReviewService(engine).question(
      Id.parse((req.params as any).id),
      req.body,
    );
    void engine.dispatch();
    return result;
  });
  app.get("/api/workflows/:id/plan/questions", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    engine.get(key);
    const query = z
      .object({ plan_revision: z.coerce.number().int().positive() })
      .parse(req.query);
    return engine.store
      .list<any>("aside_session", key)
      .filter((q) => q.plan_revision === query.plan_revision)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  });
  app.post("/api/workflows/:id/accept", async (req) => {
    human(req);
    const b = z
      .object({ binding: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(req.body);
    const key = Id.parse((req.params as any).id);
    const receipt = engine.auth.recordConfirmation("accept", b.binding);
    try {
      const result = await engine.accept(key, receipt, b.binding);
      void engine.dispatch();
      return result;
    } finally {
      engine.store.remove("human_proof", receipt);
    }
  });
  app.post("/api/workflows/:id/feedback", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    const body = (req.body || {}) as any;
    const text = String(body.text || "").trim();
    const w = engine.get(key);
    if (body.expected_version !== undefined) {
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }
    let submitted: ConversationMessageResult | undefined;
    try {
      submitted = await conversationMessages.submitFormal(key, {
        request_id:
          body.request_id || body.idempotency_key || `req_${Date.now()}`,
        text,
        refs: body.refs ?? [],
        attachment_ids: body.attachment_ids ?? [],
        root_conversation_id: body.root_conversation_id,
        expected_generation: body.expected_generation,
      });
    } catch (error) {
      if (!isMissingConversation(error)) throw error;
    }
    if (!submitted) {
      requireCondition(
        text.length > 0,
        "EMPTY_FEEDBACK",
        "反馈正文不能为空",
        400,
      );
      return submitLegacyFeedback(engine, feedbackService, key, body, text);
    }
    const saved = readConversationMessage(
      engine.store,
      key,
      submitted.message_id,
    );
    const feedbackMsg = saved?.feedback_message_id
      ? engine.store.get<any>("feedback_message", saved.feedback_message_id)
      : undefined;
    engine.store.event(key, w.project_id, "UserGuidance", {
      text: text || saved?.text || "",
      scope: body.scope ?? "within_plan",
      status: "received",
      feedback_id: saved?.feedback_message_id,
    });
    if (!body.interrupt_requested && body.scope !== "new_scope") {
      await afterConversationMessage(engine, key, submitted);
      return { ok: true, message: feedbackMsg, result: engine.get(key) };
    }
    if (
      body.interrupt_requested ||
      ["EXECUTING", "VERIFYING", "QUEUED", "HUMAN_PENDING"].includes(
        engine.get(key).state,
      )
    ) {
      await engine.stop(key, "local_console").catch(() => {});
    }
    await engine.waitForIdle(key);
    if (
      [
        "STOPPED",
        "BLOCKED",
        "RECOVERY_REQUIRED",
        "WAITING_INPUT",
        "WAITING_AUTHORIZATION",
      ].includes(engine.get(key).state)
    ) {
      await (engine.runtime as LocalRuntime)?.browser?.reconcile(key);
      await (engine.runtime as LocalRuntime)?.environments?.stop(key);
      reconcileProcesses(engine, key);
    }
    requireCondition(
      !engine.store
        .list<{ status: string }>("operation_request", key)
        .some((r) => r.status === "pending"),
      "AUTHORIZATION_PENDING",
      "先批准或拒绝待授权操作；可以在授权卡片中填写处理意见",
    );
    const result = engine.feedback(
      key,
      text || saved?.text || "",
      body.scope ?? "within_plan",
    );
    void engine.dispatch();
    return {
      ok: true,
      message: feedbackMsg,
      result,
    };
  });
  app.post("/api/workflows/:id/stop", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    assertStopIdentity(
      engine,
      key,
      (req.body || {}) as Record<string, unknown>,
    );
    return stopWorkflowIfAllowed(engine, key);
  });
  app.post("/api/workflows/:id/recover", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    assertResumeMode(engine, key, (req.body || {}) as Record<string, unknown>);
    const body = (req.body || {}) as any;
    await resumeActiveTree(
      conversationControls,
      conversationRecovery,
      conversations,
      key,
      body,
    );
    await engine.waitForIdle(key);
    await (engine.runtime as LocalRuntime)?.browser?.reconcile(key);
    await (engine.runtime as LocalRuntime)?.environments
      ?.stop(key)
      .catch(() => {});
    const result = resumeApproved(engine, key);
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/operations/:requestId/decision", async (req) => {
    human(req);
    const { id: key, requestId } = z
      .object({ id: Id, requestId: Id })
      .parse(req.params);
    const body = z
      .object({
        approved: z.boolean(),
        fingerprint: z.string().min(1),
        note: z.string().max(4000).default(""),
      })
      .strict()
      .parse(req.body);
    const request = decideOperation(
      engine,
      key,
      requestId,
      body.approved,
      body.fingerprint,
      body.note,
    );
    const w = engine.get(key);
    if (w.run_id) await engine.runtime?.stop(w.run_id);
    await engine.waitForIdle(key);
    await (engine.runtime as LocalRuntime)?.browser?.reconcile(key);
    await (engine.runtime as LocalRuntime)?.environments?.stop(key);
    reconcileProcesses(engine, key);
    const result = engine.feedback(
      key,
      `用户${body.approved ? "批准" : "拒绝"}操作 ${request.id}。${body.note}。读取 operations 上下文；${body.approved ? "调用 devflow_run_operation 执行该请求，不重复申请授权" : "不能执行该操作，按用户意见调整做法"}。`,
      "within_plan",
    );
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/commit/retry", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    reconcileProcesses(engine, key);
    return engine.retryCommit(key);
  });
  app.post("/api/workflows/:id/review/retry", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    assertStopIdentity(
      engine,
      key,
      (req.body || {}) as Record<string, unknown>,
    );
    return engine.retryReview(key);
  });
  app.post("/api/workflows/:id/environment/stop", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    requireCondition(
      ["HUMAN_PENDING", "COMMITTED", "BLOCKED", "STOPPED"].includes(
        engine.get(key).state,
      ),
      "INVALID_STATE",
      "执行期间不能释放环境",
    );
    await (engine.runtime as LocalRuntime).environments?.stop?.(key);
    return { ok: true };
  });
  app.post("/api/workflows/:id/browser/lock", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    requireCondition(
      engine.get(key).state === "HUMAN_PENDING",
      "INVALID_STATE",
      "当前不能人工浏览器验收",
    );
    requireCondition(
      engine.scheduler.acquire(key, "human", ["browser:shared"]),
      "BROWSER_BUSY",
      "浏览器被占用",
    );
    return { ok: true };
  });
  app.post("/api/workflows/:id/browser/release", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    engine.scheduler.release(key, "human", ["browser:shared"], true);
    return { ok: true };
  });
  app.post("/api/workflows/:id/browser/reconcile", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    await (engine.runtime as LocalRuntime).browser?.reconcile?.(key);
    return { ok: true };
  });
  app.get("/api/settings", async (req) => {
    human(req);
    return {
      config: engine.config,
      leases: engine.store.list("lease"),
      runtime_ready: existsSync(engine.config.host.executable),
      execution_user: "current_windows_user",
    };
  });
  app.post("/api/worker/policy", async (req) => {
    const p = engine.auth.verify(
      req.headers.authorization?.replace(/^Bearer /, ""),
      "worker",
    );
    engine.worker(p, p.workflow_id!);
    const b = z.object({ tool: z.enum(workerNames) }).parse(req.body);
    return { allowed: true, tool: b.tool };
  });
  app.all("/mcp", async (req, reply) => {
    const principal = engine.auth.verify(
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    requireCondition(
      principal.role !== "human",
      "FORBIDDEN",
      "人类令牌不能作为模型令牌",
      403,
    );
    const server = makeMcp(engine, principal, accessService);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get("/api/notifications", { websocket: true }, (socket, req) => {
    human(req);
    const listener = (event: any) => {
      if (
        [
          "WorkflowCreated",
          "StateChanged",
          "CheckCompleted",
          "PlanSubmitted",
        ].includes(event.type)
      ) {
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013, "Reconnect");
          return;
        }
        socket.send(
          JSON.stringify({
            workflow_id: event.workflow_id,
            project_id: event.project_id,
            type: event.type,
          }),
        );
      }
    };
    engine.store.on("event", listener);
    socket.on("close", () => engine.store.off("event", listener));
  });
  app.get("/api/events", { websocket: true }, async (socket, req) => {
    human(req);
    const query = z
      .object({
        workflow_id: Id,
        after: z.coerce.number().int().nonnegative().default(0),
        tail: z.coerce.number().int().min(1).max(200).optional(),
      })
      .safeParse(req.query);
    if (!query.success) {
      socket.close(1008, "Invalid cursor");
      return;
    }
    let cursor = query.data.after;
    const workflow = query.data.workflow_id;
    if (cursor === 0 && query.data.tail) {
      const tail = engine.store.recentEvents(workflow, query.data.tail);
      cursor = tail.length
        ? tail[0]!.event_seq - 1
        : engine.store.eventCursor(workflow);
    }
    const send = (event: any) => {
      if (event.workflow_id === workflow && event.event_seq > cursor) {
        if (socket.bufferedAmount > 8 * 1024 * 1024) {
          socket.close(1013, "Reconnect with cursor");
          return;
        }
        socket.send(JSON.stringify(engine.store.publicEvent(event)));
        cursor = event.event_seq;
      }
    };
    engine.store.on("event", send);
    socket.on("close", () => engine.store.off("event", send));
    while (socket.readyState === 1) {
      while (socket.readyState === 1 && socket.bufferedAmount > 1024 * 1024) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (socket.readyState !== 1) break;
      const batch = engine.store.events(workflow, cursor, 200);
      if (!batch.length) break;
      for (const event of batch) send(event);
      await new Promise((resolve) => setImmediate(resolve));
      if (batch.length < 200) break;
    }
  });

  registerAgyAccountRoutes(app, accountService, human);
  registerAgyWorkflowRecoveryRoutes(app, engine.store, engine, human);
  registerAgyAccountPolicyRoutes(app, accountService, human, id => { engine.get(id); });

  const webRoot = resolve(options.webRoot ?? "dist/web");
  if (existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply
            .code(404)
            .send({ error: { code: "NOT_FOUND", message: "接口不存在" } })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}

function writeContentTypeAllowed(
  method: string,
  url: string,
  contentType: string | string[] | undefined,
): boolean {
  const type = String(contentType ?? "");
  if (type.startsWith("application/json")) return true;
  return isConversationFileContentPut(method, url) && type.startsWith("application/octet-stream");
}

function isMissingConversation(error: unknown): boolean {
  return (
    error instanceof FlowError &&
    (error.code === "NOT_FOUND" ||
      error.code === "CONVERSATION_NOT_IN_WORKFLOW" ||
      error.code === "STALE_ROOT")
  );
}

async function submitLegacyFeedback(
  engine: Engine,
  feedbackService: FeedbackService,
  key: string,
  body: any,
  text: string,
) {
  const w = engine.get(key);
  const requestId =
    body.request_id || body.idempotency_key || `req_${Date.now()}`;
  const kind =
    body.kind ??
    (["PLAN_PENDING", "REPAIR_PLAN_PENDING", "PLANNING"].includes(w.state)
      ? "planning"
      : "execution");
  const feedbackMsg = feedbackService.submitFeedback({
    request_id: requestId,
    workflow_id: key,
    kind,
    text,
    refs: body.refs,
    attachment_ids: body.attachment_ids,
    target_document_revision: body.target_document_revision,
    interrupt_requested: body.interrupt_requested,
  });
  engine.store.event(key, w.project_id, "UserGuidance", {
    text,
    scope: body.scope ?? "within_plan",
    status: "received",
    feedback_id: feedbackMsg.message_id,
  });
  if (!body.interrupt_requested && body.scope !== "new_scope") {
    const result = engine.queueFormalFeedback(key, feedbackMsg.message_id);
    void engine.dispatch();
    return { ok: true, message: feedbackMsg, result };
  }
  if (
    body.interrupt_requested ||
    ["EXECUTING", "VERIFYING", "QUEUED", "HUMAN_PENDING"].includes(w.state)
  ) {
    await engine.stop(key, "local_console").catch(() => {});
  }
  await engine.waitForIdle(key);
  if (
    [
      "STOPPED",
      "BLOCKED",
      "RECOVERY_REQUIRED",
      "WAITING_INPUT",
      "WAITING_AUTHORIZATION",
    ].includes(engine.get(key).state)
  ) {
    await (engine.runtime as LocalRuntime)?.browser?.reconcile(key);
    await (engine.runtime as LocalRuntime)?.environments?.stop(key);
    reconcileProcesses(engine, key);
  }
  requireCondition(
    !engine.store
      .list<{ status: string }>("operation_request", key)
      .some((r) => r.status === "pending"),
    "AUTHORIZATION_PENDING",
    "先批准或拒绝待授权操作；可以在授权卡片中填写处理意见",
  );
  const result = engine.feedback(key, text, body.scope ?? "within_plan");
  void engine.dispatch();
  return { ok: true, message: feedbackMsg, result };
}

function isConversationFileContentPut(method: string, url: string): boolean {
  if (method !== "PUT") return false;
  const path = url.split("?")[0] ?? "";
  return /\/api\/workflows\/[^/]+\/conversation-files\/[^/]+\/content$/.test(
    path,
  );
}

function latestRootGeneration(
  attempts: ConversationAttempt[],
  rootId: string,
): number {
  return (
    attempts
      .filter((item) => item.conversation_id === rootId)
      .sort((a, b) => a.generation - b.generation)
      .at(-1)?.generation ?? 0
  );
}

function existingPauseFence(
  store: Store,
  workflowId: string,
  rootId: string,
): ConversationControlFence | undefined {
  return store
    .list<ConversationControlFence>(CONVERSATION_CONTROL_FENCE, workflowId)
    .filter((item) => item.root_id === rootId && item.dispatch_frozen)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
}

async function pauseActiveTree(
  controls: ConversationControlService,
  conversations: ConversationService,
  store: Store,
  workflowId: string,
  requestId?: string,
): Promise<ConversationControlResult | undefined> {
  const tree = conversations.getTree(workflowId);
  const rootId = tree.active_root_id;
  if (!rootId) return undefined;
  const generation = latestRootGeneration(tree.attempts, rootId);
  const fence = existingPauseFence(store, workflowId, rootId);
  if (fence) return controls.reconcile(workflowId, fence.control_id);
  try {
    return await controls.pauseTree(workflowId, {
      request_id: requestId || `stop:${workflowId}:${rootId}:${generation}`,
      action: "pause",
      root_id: rootId,
      expected_generation: generation,
    });
  } catch (error) {
    if (
      error instanceof FlowError &&
      (error.code === "NOT_FOUND" ||
        error.code === "STALE_ROOT" ||
        error.code === "VERSION_CONFLICT")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function resumeActiveTree(
  controls: ConversationControlService,
  recovery: ConversationRecovery,
  conversations: ConversationService,
  workflowId: string,
  body: { request_id?: string; root_id?: string; expected_generation?: number },
): Promise<void> {
  const tree = conversations.getTree(workflowId);
  const rootId = body.root_id ?? tree.active_root_id;
  if (!rootId) return;
  const request: ConversationControlRequest = {
    request_id:
      body.request_id ||
      `recover:${workflowId}:${rootId}:${latestRootGeneration(tree.attempts, rootId)}`,
    action: "resume",
    root_id: rootId,
    expected_generation:
      body.expected_generation ?? latestRootGeneration(tree.attempts, rootId),
  };
  try {
    await recovery.arrangeRecovery(workflowId, request, {
      reason: "user_resume",
    });
  } catch (error) {
    if (error instanceof FlowError && error.code === "NOT_FOUND") {
      try {
        controls.resumeTree(workflowId, request);
      } catch {}
      return;
    }
    throw error;
  }
}

async function pauseAsideTree(
  controls: ConversationControlService,
  conversations: ConversationService,
  workflowId: string,
  aside: { id: string; run_id?: string },
): Promise<void> {
  const tree = conversations.getTree(workflowId);
  const attempt = aside.run_id
    ? tree.attempts.find((item) => item.run_id === aside.run_id)
    : undefined;
  const node = attempt
    ? tree.nodes.find((item) => item.id === attempt.conversation_id)
    : tree.nodes.find((item) => item.kind === "aside" && item.id === item.root_id);
  if (!node) return;
  try {
    await controls.pauseTree(workflowId, {
      request_id: `aside-cancel:${aside.id}`,
      action: "pause",
      root_id: node.root_id,
      expected_generation: latestRootGeneration(tree.attempts, node.root_id),
    });
  } catch (error) {
    if (error instanceof FlowError && error.code === "NOT_FOUND") return;
    throw error;
  }
}

function readConversationMessage(
  store: Store,
  workflowId: string,
  messageId: string,
): ConversationMessage | undefined {
  const saved = store.get<ConversationMessage>(
    CONVERSATION_ENTITY.message,
    messageId,
  );
  if (saved?.workflow_id === workflowId) return saved;
  return store
    .list<ConversationMessage>(CONVERSATION_ENTITY.message, workflowId)
    .find((item) => item.id === messageId);
}

async function afterConversationMessage(
  engine: Engine,
  workflowId: string,
  result: ConversationMessageResult,
): Promise<void> {
  const saved = readConversationMessage(
    engine.store,
    workflowId,
    result.message_id,
  );
  if (saved?.functional_issue_id) {
    engine.store.put("functional_fix_intent", workflowId, workflowId, {
      source_snapshot: engine.get(workflowId).snapshot_id,
    });
  }
  const running = ["EXECUTING", "VERIFYING", "QUEUED", "REVIEWING"].includes(
    engine.get(workflowId).state,
  );
  if (result.mode === "formal" && running) {
    await stopWorkflowIfAllowed(engine, workflowId);
  }
  if (saved?.feedback_message_id) {
    try {
      engine.queueFormalFeedback(workflowId, saved.feedback_message_id);
    } catch {}
  }
  void engine.dispatch();
}

async function stopWorkflowIfAllowed(engine: Engine, workflowId: string) {
  try {
    return await engine.stop(workflowId, "local_console");
  } catch (error) {
    if (error instanceof FlowError && error.code === "INVALID_STATE") {
      return engine.get(workflowId);
    }
    throw error;
  }
}
