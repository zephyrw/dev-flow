import { createReadStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CONVERSATION_FILE_LIMITS,
  FlowError,
  Id,
  requireCondition,
} from "../../../../packages/contracts/src/index.js";
import type { ConversationFileService } from "../../../../packages/core/src/conversation-files.js";

export interface ConversationFilePluginOptions {
  files: ConversationFileService;
  human: (request: FastifyRequest) => void;
}

const Params = z
  .object({
    id: Id,
    fileId: Id.optional(),
  })
  .strict();

export const conversationFilePlugin: FastifyPluginAsync<
  ConversationFilePluginOptions
> = async (app, opts) => {
  const { files, human } = opts;
  app.addContentTypeParser(
    "application/octet-stream",
    (request, payload, done) => {
      done(null, payload);
    },
  );
  app.setErrorHandler((error, req, reply) => {
    sendRouteError(error, req, reply);
  });
  app.addHook("onReady", async () => {
    files.failLeftoverParts();
  });

  app.post("/api/workflows/:id/conversation-files", async (req) => {
    human(req);
    const workflowId = parseWorkflowId(req);
    return files.createMetadata(workflowId, req.body as never);
  });

  app.put(
    "/api/workflows/:id/conversation-files/:fileId/content",
    { bodyLimit: CONVERSATION_FILE_LIMITS.maxFileBytes },
    async (req) => {
      human(req);
      const { workflowId, fileId } = parseFileParams(req);
      requireOctetStream(req);
      const contentLength = parseContentLength(req.headers["content-length"]);
      return files.writeContent(
        workflowId,
        fileId,
        req.body as IncomingMessage,
        contentLength,
      );
    },
  );

  app.get("/api/workflows/:id/conversation-files/:fileId", async (req) => {
    human(req);
    const { workflowId, fileId } = parseFileParams(req);
    return files.getMetadata(workflowId, fileId);
  });

  app.get(
    "/api/workflows/:id/conversation-files/:fileId/content",
    async (req, reply) => {
      human(req);
      const { workflowId, fileId } = parseFileParams(req);
      const opened = files.openContent(workflowId, fileId);
      return reply
        .type(opened.headers.contentType)
        .header("Content-Disposition", opened.headers.contentDisposition)
        .header("X-Content-Type-Options", "nosniff")
        .send(createReadStream(opened.absolutePath));
    },
  );

  app.delete("/api/workflows/:id/conversation-files/:fileId", async (req) => {
    human(req);
    const { workflowId, fileId } = parseFileParams(req);
    return files.deleteDraft(workflowId, fileId);
  });
};

export default conversationFilePlugin;

function parseWorkflowId(req: FastifyRequest): string {
  return Params.parse(req.params).id;
}

function parseFileParams(req: FastifyRequest): { workflowId: string; fileId: string } {
  const params = Params.parse(req.params);
  requireCondition(params.fileId, "NOT_FOUND", "缺少文件 ID", 404);
  return { workflowId: params.id, fileId: params.fileId };
}

function requireOctetStream(req: FastifyRequest) {
  const type = String(req.headers["content-type"] ?? "");
  requireCondition(
    type.startsWith("application/octet-stream"),
    "VALIDATION_ERROR",
    "需要 application/octet-stream",
    415,
  );
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sendRouteError(error: unknown, req: FastifyRequest, reply: FastifyReply) {
  const known = error instanceof FlowError;
  const fastifyStatus = (error as { statusCode?: number }).statusCode;
  const status = known
    ? error.status
    : error instanceof z.ZodError
      ? 422
      : typeof fastifyStatus === "number" && fastifyStatus >= 400
        ? fastifyStatus
        : 500;
  const requestId =
    (req.body as { request_id?: string } | undefined)?.request_id ||
    (req.headers["x-request-id"] as string) ||
    null;
  reply.code(status).send({
    error: {
      code: known
        ? error.code
        : status === 422
          ? "VALIDATION_ERROR"
          : "INTERNAL_ERROR",
      message:
        known || error instanceof z.ZodError
          ? (error as Error).message
          : "操作失败，请检查本机服务日志",
      details: known
        ? error.details
        : error instanceof z.ZodError
          ? error.issues
          : undefined,
    },
    request_id: requestId,
  });
}

export function consoleHumanGuard(request: FastifyRequest) {
  requireCondition(
    !request.headers.authorization,
    "FORBIDDEN",
    "模型令牌不能调用控制台操作",
    403,
  );
}
