import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FlowError,
  Id,
  requireCondition,
} from "../../../../packages/contracts/src/index.js";
import {
  ConversationMessageService,
  publicConversationMessageResponse,
} from "../../../../packages/core/src/conversation-message-service.js";

export interface ConversationMessagePluginOptions {
  messages: ConversationMessageService;
  human: (request: FastifyRequest) => void;
}

const Params = z
  .object({
    id: Id,
  })
  .strict();

export const conversationMessagePlugin: FastifyPluginAsync<
  ConversationMessagePluginOptions
> = async (app, opts) => {
  const { messages, human } = opts;
  app.setErrorHandler((error, req, reply) => {
    sendRouteError(error, req, reply);
  });

  app.post("/api/workflows/:id/conversation-messages", async (req) => {
    human(req);
    const workflowId = Params.parse(req.params).id;
    const result = await messages.submit(workflowId, req.body);
    return publicConversationMessageResponse(result);
  });
};

export default conversationMessagePlugin;

export function consoleHumanGuard(request: FastifyRequest) {
  requireCondition(
    !request.headers.authorization,
    "FORBIDDEN",
    "模型令牌不能调用控制台操作",
    403,
  );
}

function sendRouteError(
  error: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
) {
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
