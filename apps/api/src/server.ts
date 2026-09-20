import { createBaseServer } from "./base-server.js";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
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
} from "../../../packages/contracts/src/index.js";
import { makeMcp, workerNames } from "../../../packages/mcp/src/tools.js";
import type { Engine } from "../../../packages/core/src/engine.js";
import {
  objectHash,
  hash,
  publicEvent,
  now,
} from "../../../packages/core/src/util.js";
import type { LocalRuntime } from "../../../packages/runtime/src/runtime.js";
import {
  resumeApproved,
  reconcileProcesses,
} from "../../../packages/runtime/src/recovery.js";
import { CreateWorkflowService } from "../../../packages/core/src/create-workflow.js";
import { WorkspaceReferenceService } from "../../../packages/workspace/src/references.js";
import { AsideSessionService } from "../../../packages/asides/src/service.js";
import { FunctionalIssueService } from "../../../packages/core/src/functional-issues.js";
import { repositoryInfo } from "../../../packages/git/src/git.js";
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
import { registerAgyAccountRoutes } from "./agy-account-routes.js";
import { registerAgyAccountPolicyRoutes } from "./agy-account-policy-routes.js";
import { bootstrapAccountService } from "./account-service-bootstrap.js";
import type { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";

export async function buildServer(
  engine: Engine,
  options: { webRoot?: string; accountService?: AgyAccountService } = {},
) {
  const { app, humanCheck: human } = createBaseServer({
    get port() { return engine.config.server.port; },
    humanOrigin: engine.config.server.human_origin,
    mode: "full", storageInstance: engine.config.storage_root, registerStatic: false,
    errorRetryable: modelErrorRetryable,
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
  const asideService = new AsideSessionService(engine.store);
  const issueService = new FunctionalIssueService(engine.store);
  const documentService = new DocumentService(
    engine.store,
    engine.config.storage_root,
  );
  const feedbackService = new FeedbackService(engine.store);
  const modelServices = registerModelRoutes(app, engine, human, accessService);

  app.get("/api/workflows", async (req) => {
    human(req);
    return engine.list();
  });
  app.post("/api/workflows", async (req) => {
    human(req);
    const body = req.body as any;
    if (body.workspace_root) {
      // 统一新任务创建服务入口 (N06)
      const res = createWorkflowService.execute({
        request_id:
          body.request_id || body.idempotency_key || `req_${Date.now()}`,
        workspace_root: body.workspace_root,
        request_text: body.request_text || body.request || "",
        refs: body.refs,
        workspace_mode: body.workspace_mode,
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

  // /btw 临时只读提问路由 (RQ-09 & 5.2 节)
  app.post("/api/workflows/:id/asides", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as any).id);
    const body = (req.body || {}) as any;
    const text = body.text || body.question || "";
    requireCondition(
      text.trim().length > 0,
      "EMPTY_QUESTION",
      "提问正文不能为空",
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

    engine.get(workflowId);
    const aside = asideService.submitQuestion(
      workflowId,
      text,
      body.refs ?? [],
      body.profile_revision,
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
    requireCondition(
      wf.version === body.expected_version &&
        (wf.snapshot_id ?? null) === (body.snapshot_id ?? null),
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

    if (body.expected_version !== undefined) {
      const w = engine.get(workflowId);
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }

    const workspaces = engine.store.list<any>("workspace", workflowId);
    const gd = new GitDeliveryCoordinator(
      engine.store,
      engine.config.workspace_root,
    );
    const receipt = await gd.cleanupWorkspaces(workflowId, workspaces);
    return { receipt };
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

    requireCondition(
      engine.get(workflowId).state === "HUMAN_PENDING",
      "INVALID_STATE",
      "功能核验阶段才能提交功能问题",
      409,
    );
    const issue = engine.store.transaction(() => {
      const issue = issueService.createIssue(workflowId, text, body.refs ?? []);
      engine.store.put("functional_fix_intent", workflowId, workflowId, {
        ...engine.store.get<Record<string, unknown>>(
          "functional_fix_intent",
          workflowId,
        ),
        source_snapshot: engine.get(workflowId).snapshot_id,
      });
      const message = feedbackService.submitFeedback({
        workflow_id: workflowId,
        request_id: body.request_id ?? issue.issue_id,
        kind: "functional",
        text,
        refs: body.refs ?? [],
      });
      attachIssueRepairOptions(modelServices.repairs, {
        workflow_id: workflowId,
        request_id: body.request_id ?? issue.issue_id,
        issue,
        body,
        store: engine.store,
        specs: modelServices.specs,
      });
      engine.queueFormalFeedback(workflowId, message.message_id);
      return issue;
    });
    void engine.dispatch();
    return issue;
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
    if ((req.query as any)?.view === "summary") return engine.summary(key);
    const detail = engine.detail(key, false);
    return {
      ...detail,
      events: detail.events.map((e) => engine.store.publicEvent(e)),
      attachment_status: listAttachmentRecords(engine.store, key),
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
    requireCondition(
      text.length > 0,
      "EMPTY_FEEDBACK",
      "反馈正文不能为空",
      400,
    );

    const w = engine.get(key);
    if (body.expected_version !== undefined) {
      requireCondition(
        w.version === body.expected_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${body.expected_version}, 当前 v${w.version}`,
        409,
      );
    }

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
      await engine.stop(key, "local_console");
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
    return engine.stop(key, "local_console");
  });
  app.post("/api/workflows/:id/recover", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    assertResumeMode(engine, key, (req.body || {}) as Record<string, unknown>);
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
    await (engine.runtime as LocalRuntime).environments.stop(key);
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
    await (engine.runtime as LocalRuntime).browser.reconcile(key);
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
import { decideOperation } from "../../../packages/core/src/interactions.js";
