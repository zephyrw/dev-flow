import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";
import { AgyAccountPolicyPatchSchema } from "../../../packages/contracts/src/agy-account.js";
const schema = AgyAccountPolicyPatchSchema
  .extend({
    request_id: z.string().min(1).max(200),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();
export function registerAgyAccountPolicyRoutes(
  app: FastifyInstance,
  service: AgyAccountService,
  human: (req: any) => void,
  assertWorkflow: (id: string) => void,
) {
  app.get("/api/workflows/:id/agy-account-policy", async (req) => {
    human(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    assertWorkflow(id);
    return (
      service.getRepository().getPolicy(id) ?? {
        workflow_id: id,
        revision: 0,
        auto_switch: null,
        allowed_account_ids: null,
        recreation_policy: "exact_only",
        night_pool: "normal",
      }
    );
  });
  app.put("/api/workflows/:id/agy-account-policy", async (req) => {
    human(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    assertWorkflow(id);
    const { request_id, expected_revision, ...patch } = schema.parse(req.body);
    return service.updatePolicy(id, patch, expected_revision, request_id);
  });
}
