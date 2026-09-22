import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FlowError,
  Id,
  requireCondition,
} from "../../../../packages/contracts/src/index.js";
import type { ConversationControlService } from "../../../../packages/core/src/conversation-control.js";

export interface ConversationControlPluginOptions {
  controls: ConversationControlService;
  human: (request: FastifyRequest) => void;
}

const Params = z
  .object({
    id: Id,
    controlId: Id.optional(),
  })
  .strict();

export const conversationControlPlugin: FastifyPluginAsync<
  ConversationControlPluginOptions
> = async (app, opts) => {
  const { controls, human } = opts;
  app.setErrorHandler((error, req, reply) => {
    sendRouteError(error, req, reply);
  });

  app.post("/api/workflows/:id/conversation-controls", async (req, reply) => {
    human(req);
    const workflowId = parseWorkflowId(req);
    const result = await controls.submit(workflowId, req.body);
    return reply.code(202).send(result);
  });

  app.get(
    "/api/workflows/:id/conversation-controls/:controlId",
    async (req) => {
      human(req);
      const { workflowId, controlId } = parseControlParams(req);
      return controls.reconcile(workflowId, controlId);
    },
  );
};

export default conversationControlPlugin;

export function consoleHumanGuard(request: FastifyRequest) {
  requireCondition(
    !request.headers.authorization,
    "FORBIDDEN",
    "模型令牌不能调用控制台操作",
    403,
  );
}

function parseWorkflowId(req: FastifyRequest): string {
  return Params.parse(req.params).id;
}

function parseControlParams(
  req: FastifyRequest,
): { workflowId: string; controlId: string } {
  const params = Params.parse(req.params);
  requireCondition(params.controlId, "NOT_FOUND", "缺少控制 ID", 404);
  return { workflowId: params.id, controlId: params.controlId };
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
