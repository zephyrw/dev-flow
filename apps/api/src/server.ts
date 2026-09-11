import Fastify from "fastify";
import cookie from "@fastify/cookie";
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
import { objectHash, hash } from "../../../packages/core/src/util.js";
import type { LocalRuntime } from "../../../packages/runtime/src/runtime.js";
import {
  resumeApproved,
  reconcileProcesses,
} from "../../../packages/runtime/src/recovery.js";
export async function buildServer(engine: Engine) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 65536 } });
  const origin = new URL(engine.config.server.human_origin);
  const human = (request: any) =>
    engine.auth.verify(request.cookies.devflow_session, "human");
  const sessionSockets = new Map<string, Set<any>>();
  const attachHumanSocket = (socket: any, request: any) => {
    let principal;
    try {
      principal = human(request);
    } catch {
      socket.close(1008, "Unauthorized");
      return false;
    }
    const key = hash(request.cookies.devflow_session);
    const sockets = sessionSockets.get(key) ?? new Set<any>();
    sockets.add(socket);
    sessionSockets.set(key, sockets);
    const timer = setTimeout(
      () => socket.close(1008, "Session expired"),
      principal.expires - Date.now(),
    );
    timer.unref();
    socket.once("close", () => {
      clearTimeout(timer);
      sockets.delete(socket);
      if (!sockets.size) sessionSockets.delete(key);
    });
    return true;
  };
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
  app.get("/api/health", async () => ({ ok: true, version: "0.2.0", service: "devflow",
    instance: hash(resolve(engine.config.storage_root).toLowerCase()) }));
  app.get("/api/auth/status", async (req) => {
    let authenticated = false;
    try {
      human(req);
      authenticated = true;
    } catch {}
    return {
      paired: engine.store.list("credential").length > 0,
      authenticated,
      origin: origin.origin,
    };
  });
  app.post("/api/auth/register/options", async (req) => {
    const body = z.object({ code: z.string() }).parse(req.body);
    return engine.auth.registrationOptions(body.code);
  });
  app.post("/api/auth/register/verify", async (req, reply) => {
    const body = z
      .object({ id: Id, code: z.string(), response: z.any() })
      .parse(req.body);
    const token = await engine.auth.register(body.id, body.code, body.response);
    reply.setCookie("devflow_session", token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
      maxAge: 43200,
      secure: origin.protocol === "https:",
    });
    return { ok: true };
  });
  app.post("/api/auth/challenge", async (req) => {
    const b = z
      .object({
        action: z.enum(["login", "approve", "accept"]),
        workflow_id: Id.optional(),
      })
      .parse(req.body);
    if (b.action !== "login") human(req);
    const binding =
      b.action === "login"
        ? { action: "login" }
        : engine.binding(b.workflow_id!, b.action);
    return {
      ...(await engine.auth.authenticationOptions(b.action, binding)),
      binding,
    };
  });
  app.post("/api/auth/verify", async (req, reply) => {
    const b = z
      .object({
        id: Id,
        action: z.enum(["login", "approve", "accept"]),
        binding: z.unknown(),
        response: z.any(),
      })
      .parse(req.body);
    if (b.action !== "login") human(req);
    const proof = await engine.auth.assertion(
      b.id,
      b.action,
      b.binding,
      b.response,
    );
    if (b.action === "login") {
      engine.auth.consumeProof(proof, "login", { action: "login" });
      reply.setCookie(
        "devflow_session",
        engine.auth.issue({ role: "human" }, 43200000),
        {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          maxAge: 43200,
          secure: origin.protocol === "https:",
        },
      );
    }
    return { proof };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies.devflow_session;
    if (token) {
      // Logout remains idempotent for missing or expired browser credentials.
      let valid = false;
      try {
        human(req);
        valid = true;
      } catch {}
      if (valid) engine.auth.revoke(token);
      for (const socket of sessionSockets.get(hash(token)) ?? [])
        socket.close(1008, "Logged out");
    }
    reply.clearCookie("devflow_session", { path: "/" });
    return { ok: true };
  });
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
    return engine.detail(Id.parse((req.params as any).id));
  });
  app.get("/api/workflows/:id/diff", async (req) => {
    human(req);
    const w = engine.get(Id.parse((req.params as any).id));
    return w.snapshot_id
      ? engine.git.diff(engine.store.must("snapshot", w.snapshot_id))
      : engine.git.liveDiff(w.id);
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
      const evidence = engine.store.must<{
        workflow_id: string;
        files: { path: string; hash: string }[];
      }>("evidence", a.evidence);
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
    const b = z.object({ proof: Id, binding: z.unknown() }).parse(req.body);
    const result = engine.approve(
      Id.parse((req.params as any).id),
      b.proof,
      b.binding,
    );
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/accept", async (req) => {
    human(req);
    const b = z.object({ proof: Id, binding: z.unknown() }).parse(req.body);
    const result = await engine.accept(
      Id.parse((req.params as any).id),
      b.proof,
      b.binding,
    );
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/feedback", async (req) => {
    human(req);
    const b = z
      .object({ text: z.string(), scope: z.enum(["within_plan", "new_scope"]) })
      .parse(req.body);
    const result = engine.feedback(
      Id.parse((req.params as any).id),
      b.text,
      b.scope,
    );
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/stop", async (req) => {
    human(req);
    return engine.stop(Id.parse((req.params as any).id));
  });
  app.post("/api/workflows/:id/recover", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    const result = resumeApproved(engine, key);
    void engine.dispatch();
    return result;
  });
  app.post("/api/workflows/:id/commit/retry", async (req) => {
    human(req);
    const key = Id.parse((req.params as any).id);
    reconcileProcesses(engine, key);
    return engine.retryCommit(key);
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
    if (!attachHumanSocket(socket, req)) return;
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
  app.get("/api/events", { websocket: true }, (socket, req) => {
    if (!attachHumanSocket(socket, req)) return;
    const query = z
      .object({
        workflow_id: Id,
        after: z.coerce.number().int().nonnegative().default(0),
      })
      .safeParse(req.query);
    if (!query.success) {
      socket.close(1008, "Invalid cursor");
      return;
    }
    let cursor = query.data.after;
    const workflow = query.data.workflow_id;
    const send = (event: any) => {
      if (event.workflow_id === workflow && event.event_seq > cursor) {
        if (socket.bufferedAmount > 4 * 1024 * 1024) {
          socket.close(1013, "Reconnect with cursor");
          return;
        }
        socket.send(JSON.stringify(event));
        cursor = event.event_seq;
      }
    };
    engine.store.on("event", send);
    while (socket.readyState === 1) {
      const batch = engine.store.events(workflow, cursor, 500);
      if (!batch.length) break;
      for (const event of batch) send(event);
      if (batch.length < 500 || socket.bufferedAmount > 4 * 1024 * 1024) break;
    }
    socket.on("close", () => engine.store.off("event", send));
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
