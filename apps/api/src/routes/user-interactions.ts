import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  Id,
  requireCondition,
  UserInteractionResponseInputSchema,
} from "../../../../packages/contracts/src/index.js";
import type { UserInteractionService } from "../../../../packages/core/src/user-interaction-service.js";
import type { Engine } from "../../../../packages/core/src/engine.js";

export interface UserInteractionPluginOptions {
  interactionService: UserInteractionService;
  engine: Engine;
  human: (request: FastifyRequest) => void;
}

const WorkflowParamSchema = z
  .object({
    workflowId: Id,
  })
  .strict();

const RespondParamSchema = z
  .object({
    workflowId: Id,
    interactionId: z.string().min(1),
  })
  .strict();

export const userInteractionPlugin: FastifyPluginAsync<
  UserInteractionPluginOptions
> = async (app, opts) => {
  const { interactionService, engine, human } = opts;

  app.get(
    "/api/workflows/:workflowId/user-interactions/current",
    async (req, reply) => {
      human(req);
      const { workflowId } = WorkflowParamSchema.parse(req.params);
      const current = interactionService.getCurrentInteraction(workflowId);
      if (!current) {
        return reply.code(200).send({ interaction: null });
      }
      return reply.code(200).send({ interaction: current });
    },
  );

  app.post(
    "/api/workflows/:workflowId/user-interactions/:interactionId/respond",
    async (req, reply) => {
      human(req);
      const { workflowId, interactionId } = RespondParamSchema.parse(req.params);
      const payload = UserInteractionResponseInputSchema.parse(req.body);

      const result = await interactionService.respondInteraction(
        workflowId,
        interactionId,
        payload,
        engine,
      );

      return reply.code(200).send(result);
    },
  );
};

export default userInteractionPlugin;
