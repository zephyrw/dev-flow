import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  requireCondition,
  FlowError,
} from "../../../packages/contracts/src/index.js";
import { AccountServiceError } from "../../../packages/agy-accounts/src/service.js";
import { hash } from "../../../packages/core/src/util.js";
export interface BaseServerOptions {
  port: number;
  humanOrigin: string;
  developmentFrontendOrigin?: string;
  mode: "accounts" | "full";
  features?: { workflows: boolean; agy_accounts: boolean };
  webRoot?: string;
  storageInstance?: string;
  registerStatic?: boolean;
  errorRetryable?: (code: string) => boolean;
  writeContentTypeAllowed?: (method: string, url: string, contentType: string | undefined) => boolean;
}
export function createBaseServer(options: BaseServerOptions) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  const origin = new URL(options.humanOrigin);
  const isDev =
    process.env.NODE_ENV !== "production" &&
    process.env.DEVFLOW_LOCAL_DEV === "1";
  let devFrontendUrl: URL | undefined;
  if (isDev && options.developmentFrontendOrigin) {
    try {
      const parsed = new URL(options.developmentFrontendOrigin);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
        !parsed.username &&
        !parsed.password &&
        (parsed.pathname === "/" || parsed.pathname === "") &&
        !parsed.search &&
        !parsed.hash &&
        parsed.port
      ) {
        devFrontendUrl = parsed;
      }
    } catch {
      devFrontendUrl = undefined;
    }
  }

  const allowedOrigins = new Set<string>([origin.origin]);
  if (devFrontendUrl) {
    allowedOrigins.add(devFrontendUrl.origin);
  }

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
    const isAllowedHost =
      host === origin.host ||
      host === `127.0.0.1:${options.port}` ||
      (devFrontendUrl && host === devFrontendUrl.host);
    requireCondition(isAllowedHost, "HOST_DENIED", "Host 不匹配", 403);
    if (req.headers.origin)
      requireCondition(
        allowedOrigins.has(req.headers.origin),
        "ORIGIN_DENIED",
        "Origin 不匹配",
        403,
      );
    if (req.url.startsWith("/api/")) {
      const site = req.headers["sec-fetch-site"];
      const reqOrigin = req.headers.origin;
      const isAllowedDevOrigin = Boolean(
        devFrontendUrl && reqOrigin && reqOrigin === devFrontendUrl.origin,
      );
      requireCondition(
        !site ||
          site === "same-origin" ||
          site === "none" ||
          (isAllowedDevOrigin && (site === "same-site" || site === "cross-site")),
        "FETCH_SITE_DENIED",
        "控制台接口只接受本机同源访问",
        403,
      );
    }
    if (req.headers.upgrade?.toLowerCase() === "websocket")
      requireCondition(
        allowedOrigins.has(req.headers.origin ?? ""),
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
        allowedOrigins.has(req.headers.origin ?? "") &&
          (options.writeContentTypeAllowed
            ? options.writeContentTypeAllowed(req.method, req.url, req.headers["content-type"])
            : req.headers["content-type"]?.startsWith("application/json")),
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
    const accountError = error instanceof AccountServiceError;
    const known = error instanceof FlowError;
    const status = accountError
      ? error.statusCode
      : known
        ? error.status
        : error instanceof z.ZodError
          ? 422
          : 500;
    const requestId =
      (req.body as any)?.request_id ||
      (req.headers["x-request-id"] as string) ||
      null;
    reply.code(status).send({
      error: {
        code: accountError
          ? error.code
          : known
            ? error.code
            : status === 422
              ? "VALIDATION_ERROR"
              : "INTERNAL_ERROR",
        message:
          known || accountError || error instanceof z.ZodError
            ? error.message
            : "操作失败，请检查本机服务日志",
        retryable: known
          ? (options.errorRetryable?.(error.code) ?? false)
          : false,
        request_id: requestId,
        details: known
          ? (error as any).details
          : error instanceof z.ZodError
            ? error.issues
            : undefined,
      },
      request_id: requestId,
    });
    if (status === 500) console.error(error);
  });
  app.get("/api/health", async () => ({
    ok: true,
    version: "0.2.0",
    runtime_backend: "node-v1",
    runtime_root: fileURLToPath(new URL("../../../../", import.meta.url)),
    mode: options.mode,
    features: { workflows: options.mode === "full", agy_accounts: true },
    service: "devflow",
    instance: hash(
      resolve(options.storageInstance ?? ".devflow").toLowerCase(),
    ),
  }));
  if (options.registerStatic !== false) {
    const webRoot = resolve(options.webRoot ?? "dist/web");
    if (existsSync(webRoot)) {
      app.register(staticPlugin, { root: webRoot });
      app.setNotFoundHandler(async (req, reply) => {
        if (req.url.startsWith("/api/") || req.url === "/mcp")
          return reply
            .code(404)
            .send({ error: { code: "NOT_FOUND", message: "接口不存在" } });
        return reply.sendFile("index.html");
      });
    }
  }
  return { app, humanCheck: human };
}
