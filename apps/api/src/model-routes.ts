import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  FlowError,
  FunctionalIssueViewSchema,
  Id,
  MutationReceiptSchema,
  RepairBatchViewSchema,
  RepairSelectionSchema,
  RoleOverridesSchema,
  SupportedAdapters,
  ToolProfileSchema,
  parseStoredToolProfile,
  type FunctionalIssue,
  type ModelDefaults,
  type MutationReceipt,
  type RepairKind,
  type RepairModelAssignment,
  type RepairModelBatch,
  type Run,
  type ToolProfile,
} from "../../../packages/contracts/src/index.js";
import type { Engine } from "../../../packages/core/src/engine.js";
import type { Store } from "../../../packages/store/src/store.js";
import { ExecutionSpecService } from "../../../packages/core/src/execution-spec-service.js";
import { ModelDefaultsService } from "../../../packages/core/src/model-defaults-service.js";
import { ModelCatalogService } from "../../../packages/core/src/model-catalog-service.js";
import { ModelAccessService } from "../../../packages/core/src/model-access-service.js";
import { ModelSwitchService } from "../../../packages/core/src/model-switch-service.js";
import { RepairModelService } from "../../../packages/core/src/repair-model-service.js";
import { assertProfilesVerified } from "../../../packages/core/src/access-guard.js";
import {
  buildExecutionSpecResponse,
  HttpExecutionSpecGetResponseSchema,
  readResumeTarget,
  resolveSpecRoles,
} from "../../../packages/core/src/execution-spec-view.js";

export { HttpExecutionSpecGetResponseSchema, buildExecutionSpecResponse };

const RETRYABLE_CODES = new Set([
  "RUN_STILL_STOPPING",
  "DISCOVERY_ENVIRONMENT_UNAVAILABLE",
  "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
  "MODEL_PROBE_TIMEOUT",
]);

export function modelErrorRetryable(code: string): boolean {
  return RETRYABLE_CODES.has(code);
}

function hasOwn(body: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

function rejectAmbiguousVersion(body: object) {
  if (!hasOwn(body, "expected_version")) return;
  throw new FlowError(
    "AMBIGUOUS_VERSION_FIELD",
    "请使用 expected_spec_revision 或 expected_defaults_revision，不要再传 expected_version",
    422,
  );
}

function parseUuid(value: unknown): string {
  return z.string().uuid().parse(value);
}

function parseAdapterIds(
  value: unknown,
): Array<(typeof SupportedAdapters)[number]> {
  if (value === undefined) return [...SupportedAdapters];
  const items = z.array(z.enum(SupportedAdapters)).parse(value);
  return [...new Set(items)];
}

export function assertStopIdentity(
  engine: Engine,
  workflowId: string,
  body: Record<string, unknown>,
) {
  const workflow = engine.get(workflowId);
  if (hasOwn(body, "expected_workflow_version")) {
    const expected = z.number().int().parse(body.expected_workflow_version);
    if (expected !== workflow.version) {
      throw new FlowError("VERSION_CONFLICT", "工作流版本已变化", 409);
    }
  }
  if (!hasOwn(body, "expected_run_id")) return;
  const expected =
    body.expected_run_id === null
      ? null
      : z.string().min(1).parse(body.expected_run_id);
  const current = workflow.run_id ?? null;
  if (expected !== current) {
    throw new FlowError(
      "ACTIVE_RUN_CHANGED",
      "当前运行轮次已变化，不能停止新轮次",
      409,
    );
  }
}

export function assertResumeMode(
  engine: Engine,
  workflowId: string,
  body: Record<string, unknown>,
) {
  if (!hasOwn(body, "resume_mode")) return;
  const mode = z.string().min(1).parse(body.resume_mode);
  const target = readResumeTarget(engine, workflowId);
  if (!target) {
    throw new FlowError(
      "RESUME_TARGET_AMBIGUOUS",
      "当前状态无法按指定用途恢复，请选择继续规划或继续审查",
      422,
    );
  }
  if (mode !== target.purpose && mode !== target.stage) {
    throw new FlowError(
      "RESUME_TARGET_AMBIGUOUS",
      "恢复用途与暂停记录不一致",
      422,
    );
  }
}

function parseSpecWriteBody(body: Record<string, unknown>) {
  rejectAmbiguousVersion(body);
  return {
    request_id: parseUuid(body.request_id),
    expected_spec_revision: z
      .number()
      .int()
      .nonnegative()
      .parse(body.expected_spec_revision),
    planner_profile: ToolProfileSchema.parse(body.planner_profile),
    executor_profile: ToolProfileSchema.parse(body.executor_profile),
    role_overrides: RoleOverridesSchema.parse(body.role_overrides),
  };
}

function parseDefaultsWriteBody(body: Record<string, unknown>) {
  rejectAmbiguousVersion(body);
  if (hasOwn(body, "role_overrides") || hasOwn(body, "roleOverrides")) {
    throw new FlowError("INVALID_REQUEST", "系统默认不接受角色覆盖", 422);
  }
  return {
    request_id: parseUuid(body.request_id),
    expected_defaults_revision: z
      .number()
      .int()
      .nonnegative()
      .parse(body.expected_defaults_revision),
    plannerProfile: ToolProfileSchema.parse(body.planner_profile),
    executorProfile: ToolProfileSchema.parse(body.executor_profile),
  };
}

function defaultsReadiness(
  access: ModelAccessService,
  defaults: ModelDefaults,
) {
  return {
    planner: { status: access.readiness(defaults.plannerProfile) },
    executor: { status: access.readiness(defaults.executorProfile) },
  };
}

function replyReceipt(receipt: MutationReceipt, created: boolean) {
  const parsed = MutationReceiptSchema.parse(receipt);
  return { statusCode: created ? 201 : 200, body: parsed };
}

export function registerModelRoutes(
  app: FastifyInstance,
  engine: Engine,
  human: (request: unknown) => void,
  modelAccess?: ModelAccessService,
) {
  const specs = new ExecutionSpecService(engine.store, engine.config);
  const defaults = new ModelDefaultsService(engine.store);
  const catalog = new ModelCatalogService(engine.store);
  const access = modelAccess ?? new ModelAccessService(engine.store, { catalog });
  const switches = new ModelSwitchService(engine.store, specs);
  const repairs = new RepairModelService(engine.store, specs);

  app.get("/api/model-tools", async (req) => {
    human(req);
    return catalog.listTools();
  });

  app.post("/api/model-tools/discover", async (req, reply) => {
    human(req);
    const body = (req.body || {}) as Record<string, unknown>;
    const result = catalog.discoverTools({
      request_id: parseUuid(body.request_id),
      adapter_ids: parseAdapterIds(body.adapter_ids),
    });
    return reply.code(result.created ? 202 : 200).send(result.operation);
  });

  app.get("/api/model-tools/:adapter/models", async (req) => {
    human(req);
    const adapter = z
      .string()
      .parse((req.params as { adapter: string }).adapter);
    const scopeId = (req.query as { scope_id?: string }).scope_id;
    return catalog.getModels(adapter, scopeId);
  });

  app.post("/api/model-tools/:adapter/models/refresh", async (req, reply) => {
    human(req);
    const adapter = z
      .string()
      .parse((req.params as { adapter: string }).adapter);
    const body = (req.body || {}) as Record<string, unknown>;
    const result = catalog.refreshModels({
      adapter,
      request_id: parseUuid(body.request_id),
      scope_id: typeof body.scope_id === "string" ? body.scope_id : undefined,
    });
    return reply.code(result.created ? 202 : 200).send(result.operation);
  });

  app.get("/api/settings/model-defaults", async (req) => {
    human(req);
    const current = defaults.getOrImport(engine.config);
    const draft = z
      .object({
        schema_version: z.literal(1),
        expected_defaults_revision: z.number().int().nonnegative(),
        plannerProfile: ToolProfileSchema,
        executorProfile: ToolProfileSchema,
        updated_at: z.string(),
      })
      .safeParse(engine.store.get("model_defaults_draft", "global"));
    return {
      defaults: current,
      readiness: defaultsReadiness(access, current),
      pending_draft:
        draft.success &&
        draft.data.expected_defaults_revision === current.revision
          ? draft.data
          : null,
    };
  });

  app.put("/api/settings/model-defaults", async (req, reply) => {
    human(req);
    const body = (req.body || {}) as Record<string, unknown>;
    const parsed = parseDefaultsWriteBody(body);
    // save() checks a committed receipt first, then validates access for every
    // new write inside its transaction. A receipt replay publishes nothing.
    const receipt = defaults.save(parsed);
    const created = parsed.expected_defaults_revision === 0 && receipt.changed;
    const result = replyReceipt(receipt, created);
    return reply.code(result.statusCode).send(result.body);
  });

  app.post("/api/model-access/verify", async (req, reply) => {
    human(req);
    const body = (req.body || {}) as Record<string, unknown>;
    const result = access.verifyAccess({
      request_id: parseUuid(body.request_id),
      profile: body.profile,
      force: body.force === true,
    });
    return reply.code(result.cached ? 200 : 202).send(result.job);
  });

  app.get("/api/model-access/verifications/:id", async (req) => {
    human(req);
    const jobId = z.string().parse((req.params as { id: string }).id);
    return access.getVerification(jobId);
  });

  app.post("/api/model-access/verifications/:id/cancel", async (req) => {
    human(req);
    const jobId = z.string().parse((req.params as { id: string }).id);
    const body = (req.body || {}) as Record<string, unknown>;
    return await access.cancelVerification(jobId, parseUuid(body.request_id));
  });

  app.get("/api/workflows/:id/execution-spec", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as { id: string }).id);
    return buildExecutionSpecResponse(engine, workflowId, specs);
  });

  app.post("/api/workflows/:id/execution-spec", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as { id: string }).id);
    const body = (req.body || {}) as Record<string, unknown>;
    const parsed = parseSpecWriteBody(body);
    // The service replays committed requests before its mandatory access guard.
    return specs.updateExecutionSpec({
      ...parsed,
      workflow_id: workflowId,
    });
  });

  app.post("/api/workflows/:id/model-switch", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as { id: string }).id);
    const body = (req.body || {}) as Record<string, unknown>;
    const parsed = switches.parseRequest(body, workflowId);
    // continueSwitch validates every profile before stopping a new target;
    // applyAfterPause may return an already committed receipt without mutation.
    return switches.applyAfterPause(engine, workflowId, parsed);
  });

  app.post("/api/workflows/:id/repair-model-assignment", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as { id: string }).id);
    const body = (req.body || {}) as Record<string, unknown>;
    const selection = RepairSelectionSchema.parse(body.selection);
    // assignOnce checks access for all selections (including task-default)
    // inside the transaction, after assign has handled committed receipts.
    return repairs.assign({
      workflow_id: workflowId,
      request_id: parseUuid(body.request_id),
      batch_id: z.string().min(1).parse(body.batch_id),
      expected_assignment_revision: z
        .number()
        .int()
        .nonnegative()
        .parse(body.expected_assignment_revision),
      expected_spec_revision: z
        .number()
        .int()
        .nonnegative()
        .parse(body.expected_spec_revision),
      selection,
      remember_for_task: body.remember_for_task === true,
    });
  });

  app.get("/api/workflows/:id/repair-batches", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as { id: string }).id);
    engine.get(workflowId);
    return listRepairBatchViews(engine, specs, workflowId);
  });

  app.get("/api/workflows/:id/functional-issue-views", async (req) => {
    human(req);
    const workflowId = Id.parse((req.params as { id: string }).id);
    engine.get(workflowId);
    return listFunctionalIssueViews(engine, specs, workflowId);
  });

  app.get("/api/model-operations/:id", async (req) => {
    human(req);
    const operationId = z
      .string()
      .min(1)
      .parse((req.params as { id: string }).id);
    return catalog.getOperation(operationId);
  });

  return { specs, defaults, catalog, access, switches, repairs };
}

export function attachIssueRepairOptions(
  repairs: RepairModelService,
  input: {
    workflow_id: string;
    request_id: string;
    issue: Parameters<RepairModelService["attachIssueRepair"]>[0]["issue"];
    body: Record<string, unknown>;
    store?: Store;
    specs?: ExecutionSpecService;
  },
) {
  if (
    !hasOwn(input.body, "repair_model") &&
    input.body.remember_for_task !== true
  ) {
    return;
  }
  const selection = RepairSelectionSchema.parse(
    input.body.repair_model ?? { mode: "task-default" },
  );
  if (
    input.store &&
    input.specs &&
    (selection.mode !== "task-default" || input.body.remember_for_task === true)
  ) {
    assertRepairSelectionVerified(
      input.store,
      input.specs,
      input.workflow_id,
      selection,
    );
  }
  repairs.attachIssueRepair({
    workflow_id: input.workflow_id,
    request_id: input.request_id,
    issue: input.issue,
    repair_model: input.body.repair_model,
    remember_for_task: input.body.remember_for_task === true,
    expected_spec_revision: input.body.expected_spec_revision,
  });
}

function assertRepairSelectionVerified(
  store: Store,
  specs: ExecutionSpecService,
  workflowId: string,
  selection: ReturnType<typeof RepairSelectionSchema.parse>,
) {
  if (selection.mode === "task-default") {
    const spec = specs.getLatestSpec(workflowId);
    const inherited =
      spec.roleOverrides.functional_fixer.mode === "explicit"
        ? spec.roleOverrides.functional_fixer.profile
        : spec.executorProfile;
    assertProfilesVerified(store, [inherited]);
    return;
  }
  if (selection.mode === "custom") {
    assertProfilesVerified(store, [selection.profile]);
    return;
  }
  const spec = specs.getLatestSpec(workflowId);
  const profile =
    selection.mode === "planner" ? spec.plannerProfile : spec.executorProfile;
  assertProfilesVerified(store, [profile]);
}

const BATCH_KIND = "repair_model_batch";
const ASSIGNMENT_KIND = "repair_model_assignment";

function listStoredBatches(store: Store, workflowId: string) {
  return store.list<RepairModelBatch>(BATCH_KIND, workflowId);
}

function listStoredAssignments(store: Store, workflowId: string) {
  return store.list<RepairModelAssignment>(ASSIGNMENT_KIND, workflowId);
}

function currentBatchAssignment(
  assignments: RepairModelAssignment[],
  batch: RepairModelBatch,
): RepairModelAssignment | null {
  const matched = assignments.filter(
    (item) =>
      item.batch_id === batch.id &&
      (item.status === "pending" || item.status === "active"),
  );
  matched.sort((a, b) => b.revision - a.revision);
  if (batch.current_assignment_id) {
    return (
      matched.find((item) => item.id === batch.current_assignment_id) ??
      matched[0] ??
      null
    );
  }
  return matched[0] ?? null;
}

function inheritedProfileForKind(
  specs: ExecutionSpecService,
  workflowId: string,
  kind: RepairKind,
): ToolProfile {
  const view = specs.readView(workflowId);
  const roles = resolveSpecRoles(view.spec, view.persisted);
  if (kind === "quality") return roles.review_fixer.profile;
  return roles.functional_fixer.profile;
}

function lastFixerForBatch(
  store: Store,
  workflowId: string,
  batchId: string,
): ToolProfile | null {
  const runs = store.list<Run>("run", workflowId).filter((run) => {
    return run.model_binding?.repair_batch_id === batchId;
  });
  runs.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const last = runs.at(-1);
  if (!last?.profile) return null;
  try {
    return parseStoredToolProfile(last.profile);
  } catch {
    return null;
  }
}

function canEditWorkflow(engine: Engine, workflowId: string): boolean {
  const state = engine.get(workflowId).state;
  return ![
    "COMMITTED",
    "COMPLETED",
    "COMMIT_PARTIAL",
    "CLEANUP_PENDING",
  ].includes(state);
}

function batchForIssue(
  batches: RepairModelBatch[],
  issueId: string,
): RepairModelBatch | undefined {
  const open = batches.find(
    (batch) =>
      batch.status === "open" &&
      batch.kind === "functional" &&
      batch.issue_ids.includes(issueId),
  );
  if (open) return open;
  return batches.find(
    (batch) => batch.kind === "functional" && batch.issue_ids.includes(issueId),
  );
}

export function listRepairBatchViews(
  engine: Engine,
  specs: ExecutionSpecService,
  workflowId: string,
) {
  const store = engine.store;
  const assignments = listStoredAssignments(store, workflowId);
  const canEdit = canEditWorkflow(engine, workflowId);
  return listStoredBatches(store, workflowId)
    .filter((batch) => batch.status === "open")
    .map((batch) => {
      const assignment = currentBatchAssignment(assignments, batch);
      return RepairBatchViewSchema.parse({
        batch,
        assignment,
        inherited_profile: inheritedProfileForKind(
          specs,
          workflowId,
          batch.kind,
        ),
        last_fixer_profile: lastFixerForBatch(store, workflowId, batch.id),
        can_edit: canEdit,
      });
    });
}

export function listFunctionalIssueViews(
  engine: Engine,
  specs: ExecutionSpecService,
  workflowId: string,
) {
  const store = engine.store;
  const batches = listStoredBatches(store, workflowId);
  const assignments = listStoredAssignments(store, workflowId);
  const issues = store.list<FunctionalIssue>("functional_issue", workflowId);
  return issues.map((issue) => {
    const batch = batchForIssue(batches, issue.issue_id);
    const assignment = batch
      ? currentBatchAssignment(assignments, batch)
      : null;
    const kind = batch?.kind ?? "functional";
    return FunctionalIssueViewSchema.parse({
      issue: {
        issue_id: issue.issue_id,
        workflow_id: issue.workflow_id,
        created_seq: issue.created_seq,
        description: issue.description,
        status: issue.status,
        created_at: issue.created_at,
      },
      batch_id: batch?.id ?? null,
      assignment_revision: assignment?.revision ?? 0,
      assignment_id: assignment?.id ?? null,
      inherited_profile: inheritedProfileForKind(specs, workflowId, kind),
      explicit_profile: assignment?.profile ?? null,
      last_fixer_profile: batch
        ? lastFixerForBatch(store, workflowId, batch.id)
        : null,
    });
  });
}
