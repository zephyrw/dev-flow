import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgyAccountService } from "../../../packages/agy-accounts/src/service.js";
import {
  AgyAccountDtoSchema,
  AgyAccountSettingsPatchSchema,
  type AgyAccountOperation,
  type AgyAccountSettings,
} from "../../../packages/contracts/src/agy-account.js";
import { requireCondition, FlowError } from "../../../packages/contracts/src/index.js";
import type { Store } from "../../../packages/store/src/store.js";
import { AgyRecoveryCheckpointManager } from "../../../packages/runtime/src/agy-recovery-checkpoint.js";
import { AgyWorkflowRecoveryCoordinator } from "../../../packages/runtime/src/agy-workflow-recovery.js";
const realmId = "default-agy-realm";
const requestId = z.string().min(1).max(200);
const revision = z.number().int().nonnegative();
const ref = z.string().min(1).max(200);
const selection = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z.object({ mode: z.literal("explicit"), account_id: ref }).strict(),
]);
const settingsPatch = AgyAccountSettingsPatchSchema;
function publicSettings(value: AgyAccountSettings | null | undefined) {
  if (!value) return null;
  const { auth_host_executable: _privatePath, ...dto } = value;
  return dto;
}
export function publicAccountOperation(operation: AgyAccountOperation) {
  const {
    operation_id,
    revision,
    phase,
    kind,
    trigger,
    selection: target,
    target_account_id,
    before_account_id,
    attempted_account_ids,
    created_at,
    completed_at,
    error,
  } = operation;
  return {
    operation_id,
    revision,
    phase,
    kind,
    trigger,
    selection: target,
    target_account_id,
    before_account_id,
    attempted_account_ids,
    created_at,
    completed_at,
    error,
    result: operation.result
      ? {
          status: operation.result.status,
          message: operation.result.message,
          active_account_id: operation.result.active_account_id,
          outcome: operation.result.outcome,
        }
      : undefined,
    external_processes: operation.external_processes,
    deadline_at: operation.deadline_at,
  };
}
export function registerAgyAccountRoutes(
  app: FastifyInstance,
  service: AgyAccountService,
  human: (req: any) => void,
) {
  const repo = service.getRepository();
  app.get("/api/agy-accounts", async (req) => {
    human(req);
    const view = service.getPresentation(realmId);
    return {
      ...view,
      accounts: view.accounts.map((a) => AgyAccountDtoSchema.parse(a)),
      settings: publicSettings(view.settings),
    };
  });
  app.get("/api/agy-accounts/service", async (req) => {
    human(req);
    const view = service.getPresentation(realmId);
    const settings = repo.getSettings(realmId);
    const realm = view.realm && "realm_id" in view.realm ? view.realm : null;
    const serviceState = realm?.service_state ?? "stopped";
    const isAutomationEnabled = Boolean(
      serviceState === "running" ||
        (realm?.desired_enabled && settings?.workflow_auto_switch),
    );
    return {
      realm_id: realmId,
      service_state: "stopped",
      desired_enabled: false,
      auth_epoch: 0,
      revision: 0,
      control_generation: 0,
      ...view.realm,
      automation: {
        enabled: isAutomationEnabled,
        service_state: serviceState,
        can_toggle: true,
        actions_available: {
          enroll: true,
          switch: true,
        },
      },
      settings: publicSettings(view.settings),
      capability: view.capability,
      operations: repo
        .listOperations(realmId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 100)
        .map(publicAccountOperation),
    };
  });
  app.put("/api/agy-accounts/automation", async (req, reply) => {
    human(req);
    const body = z
      .object({
        request_id: requestId,
        enabled: z.boolean(),
        expected_revision: revision.optional(),
      })
      .strict()
      .parse(req.body);

    const view = service.getPresentation(realmId);
    const realm = view.realm && "realm_id" in view.realm ? view.realm : null;
    const currentlyRunning = realm?.service_state === "running";

    if (body.enabled) {
      service.updateSettings(
        realmId,
        { workflow_auto_switch: true },
        body.expected_revision ?? view.settings?.revision ?? 0,
        body.request_id,
      );
      if (!currentlyRunning) {
        await service.start({
          realmId,
          requestId: body.request_id,
          expectedRevision: realm?.revision,
        });
      }
    } else {
      service.updateSettings(
        realmId,
        { workflow_auto_switch: false },
        body.expected_revision ?? view.settings?.revision ?? 0,
        body.request_id,
      );
      if (currentlyRunning) {
        await service.stop({
          realmId,
          requestId: body.request_id,
          expectedControlGeneration: realm?.control_generation,
        });
      }
    }

    const updated = service.getPresentation(realmId);
    const updatedRealm =
      updated.realm && "realm_id" in updated.realm ? updated.realm : null;
    return reply.code(200).send({
      enabled: body.enabled,
      service_state: updatedRealm?.service_state ?? "stopped",
      revision: updatedRealm?.revision ?? 0,
    });
  });
  app.post("/api/agy-accounts/service/start", async (req, reply) => {
    human(req);
    const body = z
      .object({ request_id: requestId, expected_settings_revision: revision })
      .strict()
      .parse(req.body);
    const result = await service.start({
      realmId,
      requestId: body.request_id,
      expectedRevision: body.expected_settings_revision,
    });
    return reply.code(202).send(result);
  });
  app.post("/api/agy-accounts/service/stop", async (req, reply) => {
    human(req);
    const body = z
      .object({ request_id: requestId, expected_control_generation: revision })
      .strict()
      .parse(req.body);
    const result = await service.stop({
      realmId,
      requestId: body.request_id,
      expectedControlGeneration: body.expected_control_generation,
    });
    return reply.code(202).send(result);
  });
  app.get("/api/agy-accounts/settings", async (req) => {
    human(req);
    return publicSettings(repo.getSettings(realmId));
  });
  app.put("/api/agy-accounts/settings", async (req) => {
    human(req);
    const { request_id, expected_revision, ...patch } = settingsPatch
      .extend({ request_id: requestId, expected_revision: revision })
      .strict()
      .parse(req.body);
    return publicSettings(
      service.updateSettings(realmId, patch, expected_revision, request_id),
    );
  });
  app.post("/api/agy-accounts/switch", async (req, reply) => {
    human(req);
    const body = z
      .object({
        request_id: requestId,
        selection,
        model_id: z.string().min(1).max(200).optional(),
        expected_epoch: revision.optional(),
        expected_settings_revision: revision.optional(),
      })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "switch",
          ...body,
        }),
      );
  });
  app.post("/api/agy-accounts/enroll", async (req, reply) => {
    human(req);
    const body = z
      .object({
        request_id: requestId,
        expected_realm_revision: revision.optional(),
        alias: z.string().max(100).default(""),
        mode: z.enum(["login", "capture_current"]),
      })
      .strict()
      .parse(req.body);
    const { expected_realm_revision, ...rest } = body;
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "enroll",
          expected_revision: expected_realm_revision,
          ...rest,
        }),
      );
  });
  app.get("/api/agy-accounts/maintenance", async (req) => {
    human(req);
    return service.getMaintenanceService().generateLocalReport(realmId);
  });
  app.post("/api/agy-accounts/maintenance", async (req, reply) => {
    human(req);
    const body = z
      .object({
        request_id: requestId,
        expected_realm_revision: revision,
        selected_account_ids: z.array(ref).min(1).max(100),
      })
      .strict()
      .parse(req.body);
    const { expected_realm_revision, ...rest } = body;
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "maintenance",
          expected_revision: expected_realm_revision,
          ...rest,
        }),
      );
  });
  app.get("/api/agy-accounts/operations/:id", async (req) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const op = repo.getOperation(id);
    requireCondition(
      op && op.realm_id === realmId,
      "NOT_FOUND",
      "操作不存在",
      404,
    );
    return publicAccountOperation(op!);
  });
  app.post("/api/agy-accounts/operations/:id/cancel", async (req, reply) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const body = z
      .object({ request_id: requestId, expected_revision: revision })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "cancel",
          operation_id: id,
          ...body,
        }),
      );
  });
  app.get("/api/agy-accounts/:id/history", async (req) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const query = z
      .object({
        after: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query);
    requireCondition(repo.getAccount(realmId, id), "NOT_FOUND", "账号不存在", 404);
    const all = repo.listQuotaHistory(id, 1000);
    const offset = query.after
      ? all.findIndex((item) => item.id === query.after) + 1
      : 0;
    const items = all.slice(offset, offset + query.limit);
    return {
      items,
      next_cursor: offset + items.length < all.length ? items.at(-1)?.id : null,
    };
  });
  app.post("/api/agy-accounts/:id/reauth", async (req, reply) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const body = z
      .object({
        request_id: requestId,
        expected_account_revision: revision,
        expected_identity: z.string().email(),
      })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "reauth",
          account_id: id,
          ...body,
        }),
      );
  });
  app.post("/api/agy-accounts/:id/probe", async (req, reply) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const body = z
      .object({ request_id: requestId, expected_account_revision: revision })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "probe",
          account_id: id,
          ...body,
        }),
      );
  });
  app.patch("/api/agy-accounts/:id", async (req) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const { request_id, expected_revision, ...patch } = z
      .object({
        request_id: requestId,
        expected_revision: revision,
        alias: z.string().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    return AgyAccountDtoSchema.parse(
      service.updateAccount(realmId, id, patch, expected_revision, request_id),
    );
  });
  app.delete("/api/agy-accounts/:id", async (req, reply) => {
    human(req);
    const { id } = z.object({ id: ref }).parse(req.params);
    const body = z
      .object({ request_id: requestId, expected_revision: revision })
      .strict()
      .parse(req.body);
    return reply
      .code(202)
      .send(
        await service.requestOperation({
          realm_id: realmId,
          kind: "delete",
          account_id: id,
          expected_account_revision: body.expected_revision,
          request_id: body.request_id,
        }),
      );
  });

  // 只读能力投影 (R2-D10 / CR29: 仅读取本地快照，不每次调用Host，不硬编码quota=true)
  app.get("/api/agy-accounts/capabilities", async (req) => {
    human(req);
    const snapshot = service.getCapabilitySnapshot();
    const loginAvailable = service.getEnrollmentService().isLoginAvailable();
    return {
      supported: snapshot.supported,
      reason: snapshot.reason,
      cli_version: snapshot.cli_version ?? "unknown",
      cli_sha256: snapshot.cli_sha256 ?? null,
      adapter_revision: snapshot.adapter_revision ?? null,
      host_platform: snapshot.host_platform,
      host_version: snapshot.host_version,
      dpapi_available: snapshot.dpapi_available,
      cred_manager_available: snapshot.cred_manager_available,
      named_mutex_available: snapshot.named_mutex_available,
      capabilities: snapshot.capabilities,
      // 兼容事实
      native_login_supported: loginAvailable,
      quota_inspection_supported: snapshot.capabilities.dual_quota.status === "verified",
    };
  });
}

export { registerAgyWorkflowRecoveryRoutes } from "./agy-workflow-recovery-routes.js";
