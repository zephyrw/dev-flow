import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  requireCondition,
  FlowError,
} from "../../../packages/contracts/src/index.js";
import { AccountServiceError } from "../../../packages/agy-accounts/src/service.js";
import { hash } from "../../../packages/core/src/util.js";
import {
  isMaintenanceMarkerExpired,
  readMaintenanceMarker,
} from "../../../packages/installer/src/transaction.js";
import { registerMaintenanceRoutes } from "./routes/maintenance-routes.js";

export interface BuildIdentity {
  application_version: string;
  build_revision: string;
  service_protocol_version: string;
}

export interface BaseServerOptions {
  port: number;
  humanOrigin: string;
  mode: "accounts" | "full";
  features?: { workflows: boolean; agy_accounts: boolean };
  webRoot?: string;
  storageInstance?: string;
  storageRoot?: string;
  registerStatic?: boolean;
  errorRetryable?: (code: string) => boolean;
  writeContentTypeAllowed?: (method: string, url: string, contentType: string | undefined) => boolean;
  /** Override for tests; otherwise build-info.json then package.json. */
  buildIdentity?: Partial<BuildIdentity>;
  onMaintenancePrepare?: (body: {
    transaction_id?: string;
    target_version?: string;
  }) => Promise<void> | void;
  onMaintenanceQuiesce?: (mode: "wait" | "pause-and-update") => Promise<void>;
}

/**
 * 协调约定第 5 条: stop hardcoding version "0.2.0".
 * Prefer package-root build-info.json, then package.json real version.
 */
export function loadBuildIdentity(runtimeRoot: string): BuildIdentity {
  const fallback: BuildIdentity = {
    application_version: "0.0.0-unknown",
    build_revision: "source",
    service_protocol_version: "1",
  };
  try {
    const buildInfoPath = join(runtimeRoot, "build-info.json");
    if (existsSync(buildInfoPath)) {
      const info = JSON.parse(readFileSync(buildInfoPath, "utf8")) as {
        application_version?: string;
        build_revision?: string;
        service_protocol_version?: string;
      };
      return {
        application_version:
          info.application_version ?? fallback.application_version,
        build_revision: info.build_revision ?? fallback.build_revision,
        service_protocol_version:
          info.service_protocol_version ?? fallback.service_protocol_version,
      };
    }
    const pkgPath = join(runtimeRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        version?: string;
      };
      return {
        application_version: pkg.version ?? fallback.application_version,
        build_revision: fallback.build_revision,
        service_protocol_version: fallback.service_protocol_version,
      };
    }
  } catch {
    /* unreadable build identity must not take the service down */
  }
  return fallback;
}

export function createBaseServer(options: BaseServerOptions) {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body: string, done) => {
      if (!body || body.trim().length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(body));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  const origin = new URL(options.humanOrigin);
  const runtimeRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const buildIdentity: BuildIdentity = {
    ...loadBuildIdentity(runtimeRoot),
    ...options.buildIdentity,
  };
  const maintenanceStorageRoot =
    options.storageRoot ?? resolve(options.storageInstance ?? ".devflow");
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
      host === origin.host || host === `127.0.0.1:${options.port}`,
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
    // §7.2 禁止新派发：maintenance marker blocks mutating API calls except
    // maintenance and worker routes (pause/quiesce must stay reachable).
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.url.startsWith("/api/maintenance") &&
      !req.url.startsWith("/api/worker/")
    ) {
      const marker = readMaintenanceMarker(maintenanceStorageRoot);
      if (marker && marker.block_new_dispatch && !isMaintenanceMarkerExpired(marker))
        requireCondition(
          false,
          "MAINTENANCE_ACTIVE",
          "DevFlow 正在更新或维护中，暂不接受新派发",
          503,
        );
    }
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.url !== "/mcp" &&
      !req.url.startsWith("/api/worker/")
    )
      requireCondition(
        req.headers.origin === origin.origin &&
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
    // Real build identity (协调约定第 5 条) — no hardcoded "0.2.0".
    version: buildIdentity.application_version,
    application_version: buildIdentity.application_version,
    build_revision: buildIdentity.build_revision,
    service_protocol_version: buildIdentity.service_protocol_version,
    runtime_backend: "node-v1",
    runtime_root: runtimeRoot,
    mode: options.mode,
    features: { workflows: options.mode === "full", agy_accounts: true },
    service: "devflow",
    instance: hash(
      resolve(options.storageInstance ?? ".devflow").toLowerCase(),
    ),
    maintenance: (() => {
      const marker = readMaintenanceMarker(maintenanceStorageRoot);
      return {
        active: !!marker && !isMaintenanceMarkerExpired(marker),
        block_new_dispatch:
          !!marker &&
          marker.block_new_dispatch &&
          !isMaintenanceMarkerExpired(marker),
      };
    })(),
  }));
  registerMaintenanceRoutes(app, {
    human,
    storageRoot: maintenanceStorageRoot,
    storageInstance: options.storageInstance,
    onPrepare: options.onMaintenancePrepare,
    onQuiesce: options.onMaintenanceQuiesce,
  });
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
