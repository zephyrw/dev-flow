import Fastify from "fastify";
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
} from "../../../packages/contracts/src/index.js";
import { makeMcp, workerNames } from "../../../packages/mcp/src/tools.js";
import type { Engine } from "../../../packages/core/src/engine.js";
import {
  objectHash,
  hash,
  publicEvent,
} from "../../../packages/core/src/util.js";
import type { LocalRuntime } from "../../../packages/runtime/src/runtime.js";
import {
  resumeApproved,
  reconcileProcesses,
} from "../../../packages/runtime/src/recovery.js";
export async function buildServer(engine: Engine) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(websocket, { options: { maxPayload: 65536 } });
  const origin = new URL(engine.config.server.human_origin);
  // The console trusts the current local user. Model bearer tokens only belong
  // to MCP/worker routes; they must never authorize a console action.
  const human = (request: any) =>
    requireCondition(
      !request.headers.authorization,
      "FORBIDDEN",
      "模型令牌不能调用控制台操作",
      403,
    );
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    requireCondition(
      host === origin.host || host === `127.0.0.1:${engine.config.server.port}`,
      "HOST_DENIED",
      "Host 不匹配",
      403,
    );
    if (req.headers.origin)
      requireCondition(
        req.headers.origin === origin.origin,
        "ORIGIN_DENIED",
        "Origin 不匹配",
        403,
      );
    if (req.url.startsWith("/api/")) {
      const site = req.headers["sec-fetch-site"];
      requireCondition(
        !site || site === "same-origin" || site === "none",
        "FETCH_SITE_DENIED",
        "控制台接口只接受本机同源访问",
        403,
      );
    }
    if (req.headers.upgrade?.toLowerCase() === "websocket")
      requireCondition(
        req.headers.origin === origin.origin,
        "ORIGIN_DENIED",
        "事件流需要同源连接",
        403,
      );
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.url !== "/mcp" &&
      !req.url.startsWith("/api/worker/")
    )
      requireCondition(
        req.headers.origin === origin.origin &&
          req.headers["content-type"]?.startsWith("application/json"),
        "CSRF_DENIED",
        "需要同源 JSON 请求",
        403,
      );
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cross-Origin-Resource-Policy", "same-origin")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
  });
  app.setErrorHandler((error, req, reply) => {
    const known = error instanceof FlowError;
    const status = known
      ? error.status
      : error instanceof z.ZodError
        ? 422
        : 500;
    reply.code(status).send({
      error: {
        code: known
          ? error.code
          : status === 422
            ? "VALIDATION_ERROR"
            : "INTERNAL_ERROR",
        message:
          known || error instanceof z.ZodError
            ? error.message
            : "操作失败，请检查本机服务日志",
      },
    });
    if (status === 500) console.error(error);
  });
  app.get("/api/health", async () => ({
    ok: true,
    version: "0.2.0",
    service: "devflow",
    instance: hash(resolve(engine.config.storage_root).toLowerCase()),
  }));
  app.get("/api/projects", async (req) => {
    human(req);
    return engine.store.list("project");
  });
  app.post("/api/projects", async (req) => {
    human(req);
    return engine.registerProject(req.body);
  });
  app.get("/api/workflows", async (req) => {
    human(req);
    return engine.list();
  });
  app.post("/api/workflows", async (req) => {
    human(req);
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
  app.get("/api/workflows/:id", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    if ((req.query as any)?.view === "summary") return engine.summary(key);
    const detail = engine.detail(key, false);
    return {
      ...detail,
      events: detail.events.map((e) => engine.store.publicEvent(e)),
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
  app.get("/api/workflows/:id/documents/:name", async (req, reply) => {
    human(req);
    const { id: key, name } = z
      .object({ id: Id, name: z.enum(["plan", "progress", "tests"]) })
      .parse(req.params);
    const w = engine.get(key);
    requireCondition(w.plan_revision > 0, "PLAN_MISSING", "尚无计划", 404);
    engine.exportDocuments(key);
    const file = join(
      engine.config.storage_root,
      "documents",
      key,
      "r" + w.plan_revision,
      { plan: "计划.md", progress: "开发进度.md", tests: "测试进度.md" }[name],
    );
    requireCondition(
      existsSync(file),
      "DOCUMENT_MISSING",
      "简单任务的进度包含在计划中",
      404,
    );
    return reply
      .type("text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${name}.md"`)
      .send(readFileSync(file));
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
        }>("development_evidence", a.evidence);
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
    const b = z
      .object({
        text: z.string().trim().min(1).max(19999),
        scope: z.enum(["within_plan", "new_scope"]),
      })
      .parse(req.body);
    const key = Id.parse((req.params as any).id);
    const w = engine.get(key);
    engine.store.event(key, w.project_id, "UserGuidance", {
      text: b.text,
      scope: b.scope,
      status: "received",
    });
    if (["EXECUTING", "VERIFYING", "QUEUED", "HUMAN_PENDING"].includes(w.state))
      await engine.stop(key, "local_console");
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
    const result = engine.feedback(key, b.text, b.scope);
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/stop", async (req) => {
    human(req);
    return engine.stop(Id.parse((req.params as any).id), "local_console");
  });
  app.post("/api/workflows/:id/recover", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
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
    const w = engine.get(key);
    requireCondition(
      w.state === "BLOCKED" && engine.store.get("acceptance", key),
      "INVALID_STATE",
      "只能对已验收但在复核时阻断的工作流重试复核",
    );
    engine.transition(key, ["BLOCKED"], "REVIEW_QUEUED", "review", {
      blocker: undefined,
    });
    engine.scheduler.enqueue(key, w.project_id);
    void engine.dispatch();
    return engine.get(key);
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
    const server = makeMcp(engine, principal);
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
  const webRoot = resolve("dist/web");
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
