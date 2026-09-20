import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { setup, project } from "../helpers.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { stageModelRunRetry } from "../../packages/core/src/model-retry.js";
import { bindProfile, buildDispatchContext, frozenInvocationFromProfile, invocationFingerprintFromFrozen } from "../../packages/core/src/run-profile.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import { classifyAgyFailure } from "../../packages/adapters/agy/src/failure-fact.js";
import { inheritRoleOverrides, type Run, type ToolProfile, type Workflow } from "../../packages/contracts/src/index.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import type { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";

const realmId = "default-agy-realm";
const workflowId = "wf-account-model";
const selected: ToolProfile = {
  id: "old-profile", revision: 1, adapterId: "agy", executableRef: process.execPath,
  modelSelection: "explicit", modelId: "display-alias", selectionKind: "fixed",
  reasoning: { mode: "explicit", value: "high" }, options: {},
};

describe("managed account recovery retains frozen model routing", () => {
  let s: ReturnType<typeof setup>;
  let accounts: ReturnType<typeof accountFixture>;
  let access: ModelAccessService;
  let bridge: AgyWorkflowBridge;
  beforeEach(async () => {
    s = setup();
    accounts = accountFixture(s.store);
    accounts.seedAccounts();
    accounts.repository.savePolicy({ workflow_id: workflowId, revision: 1,
      auto_switch: true, allowed_account_ids: null, recreation_policy: "exact_only",
      night_pool: "normal", created_at: new Date().toISOString() });
    await accounts.service.start({ realmId, requestId: "start-model-fixture" });
    access = new ModelAccessService(s.store);
    bridge = new AgyWorkflowBridge(accounts.service,
      { get: () => undefined, stop: vi.fn(async () => {}) } as unknown as ProcessManager,
      undefined, s.engine,
      { confirmJobsStopped: async () => true } as unknown as AgyAccountProcessHost);
    s.store.put("project", "p1", "p1", project(s.root));
    vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  });
  afterEach(async () => {
    bridge.dispose();
    for (const permit of accounts.repository.listPermits(realmId))
      await accounts.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: false });
    await accounts.service.close();
    vi.restoreAllMocks();
    s.store.close();
    rmSync(s.root, { recursive: true, force: true });
  });
  function seedAccess() {
    return access.seedVerified({ ...selected, modelId: "fixture-model" });
  }
  function source(purpose: Run["purpose"] = "quality_review", role: Run["routing_role"] = "reviewer") {
    const native = access.resolveNativeConfig(selected);
    const frozen = { ...frozenInvocationFromProfile(selected, "profile-native"),
      modelToken: "fixture-model", accessModelKey: "fixture-model", catalogEntryId: "original-entry",
      capabilityRevision: "original-capability", accountScope: native.accountFingerprint,
      providerScope: native.providerEndpointFingerprint ?? "default", identityConfidence: native.identityConfidence };
    const run: Run = { id: "source-run", workflow_id: workflowId, plan_revision: 1,
      adapter: "agy", purpose, stage: purpose === "planning" ? "planning" : purpose === "quality_review" ? "review" : "execute",
      profile: selected, frozen_invocation: frozen, runtime_flavor: "profile-native", protocol: "lightweight",
      invocation_fingerprint: invocationFingerprintFromFrozen(frozen, "workspace", "write"),
      routing_role: role, routing_source: "user-repair", execution_spec_id: "old-spec", execution_spec_revision: 1,
      logical_round_id: "original-round", repair_batch_id: "original-batch", assignment_id: "original-assignment",
      status: "failed", started_at: new Date().toISOString(), package_hash: "fixture" };
    const workflow: Workflow = { id: workflowId, project_id: "p1", title: "account recovery", request: "recover",
      complexity: "simple", workspace_mode: "existing_workspace",
      state: purpose === "planning" ? "PLANNING" : purpose === "quality_review" ? "REVIEWING" : "EXECUTING",
      stage: run.stage, version: 2, run_id: run.id, plan_revision: 1, plan_hash: "approved-plan",
      environment_revision: 0, feedback: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    s.store.put("run", run.id, workflowId, run);
    s.store.put("workflow", workflowId, "p1", workflow);
    s.store.put("execution_spec", "new-spec", workflowId, { schema_version: 2, id: "new-spec", workflow_id: workflowId,
      revision: 2, plannerProfile: { ...selected, id: "new-planner", modelId: "new-model", reasoning: { mode: "explicit", value: "low" } },
      executorProfile: { ...selected, id: "new-executor", modelId: "new-model", reasoning: { mode: "explicit", value: "low" } },
      roleOverrides: inheritRoleOverrides(), template_id: "native-development", template_revision: 3,
      mode: "composite", created_at: new Date().toISOString() });
    return run;
  }
  function switchIdentity(accountId = "b") {
    const realm = accounts.repository.getRealm(realmId)!;
    accounts.repository.saveRealm({ ...realm, active_account_id: accountId, auth_epoch: realm.auth_epoch + 1, revision: realm.revision + 1 });
  }
  async function stageSwitch(run: Run) {
    await bridge.prepareRun({ workflow_id: workflowId, run_id: run.id, effective_model_id: "fixture-model",
      account_policy_revision: 1, required_pool_ids: ["fixture-pool"] });
    await bridge.prepareSwitch("operation-model");
    const workflow = s.engine.get(workflowId);
    s.store.put("workflow", workflowId, "p1", { ...workflow, version: 3, state: "BLOCKED", stage: "blocked",
      blocker: { code: "AGY_ACCOUNT_WAIT", message: "switching" } });
    switchIdentity();
  }
  async function commitAccount() {
    const realm = accounts.repository.getRealm(realmId)!;
    await bridge.onAccountCommitted({ realm_id: realmId, operation_id: "operation-model",
      account_id: realm.active_account_id!, auth_epoch: realm.auth_epoch });
  }

  it.each([
    { purpose: "quality_review" as const, role: "reviewer" as const },
    { purpose: "implement" as const, role: "review_fixer" as const },
    { purpose: "functional_fix" as const, role: "functional_fixer" as const },
    { purpose: "planning" as const, role: "planner" as const },
  ])("keeps $role model/effort/batch when the next-run spec changed", async ({ purpose, role }) => {
    const run = source(purpose, role);
    seedAccess();
    await stageSwitch(run);
    seedAccess();
    const restored = vi.spyOn(s.engine, "restoreFailedRole").mockImplementation(() => s.engine.get(workflowId));
    await commitAccount();
    expect(restored).toHaveBeenCalledOnce();
    const binding = bindProfile(s.store, s.config, workflowId, purpose, buildDispatchContext(s.store, workflowId, purpose));
    expect(binding).toMatchObject({ profile: selected, routing_role: role, routing_source: "retry",
      execution_spec_revision: 1, logical_round_id: "original-round", repair_batch_id: "original-batch", assignment_id: "original-assignment" });
    const native = access.resolveNativeConfig(selected);
    expect(binding.frozen_invocation).toEqual({ ...run.frozen_invocation,
      accountScope: native.accountFingerprint, providerScope: native.providerEndpointFingerprint ?? "default", identityConfidence: native.identityConfidence });
    expect(binding.frozen_invocation.accountScope).not.toBe(run.frozen_invocation!.accountScope);
    expect(binding.model_binding.frozen_invocation).toEqual(binding.frozen_invocation);
    expect(binding.model_binding.invocation_fingerprint).toBe(binding.invocation_fingerprint);
    expect(s.store.must<Run>("run", run.id)).toEqual(run);
    expect(s.store.get<any>("agy_recovery_checkpoint", "operation-model:source-run")?.effective_model_id).toBe("fixture-model");
    expect(s.engine.dispatch).toHaveBeenCalledOnce();
  });

  it("blocks an unverified new account and resumes the original planning choice after explicit verification", async () => {
    const run = source("planning", "planner");
    const originalAccess = seedAccess();
    await stageSwitch(run);
    const probe = vi.spyOn(accounts.probe, "probeModelAccess");
    await commitAccount();
    expect(s.engine.get(workflowId).blocker?.code).toBe("MODEL_ACCESS_REQUIRED");
    expect(s.engine.dispatch).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(s.store.get<any>("pending_model_retry", workflowId)?.retry_run_id).toBe(run.id);
    expect(() => resumeApproved(s.engine, workflowId)).toThrowError(expect.objectContaining({ code: "MODEL_ACCESS_REQUIRED" }));
    expect(access.getAccess(originalAccess.key)?.status).toBe("verified");
    seedAccess();
    expect(resumeApproved(s.engine, workflowId).state).toBe("PLANNING");
    const binding = bindProfile(s.store, s.config, workflowId, "planning", buildDispatchContext(s.store, workflowId, "planning"));
    expect(binding.profile.modelId).toBe("display-alias");
    expect(binding.frozen_invocation.modelToken).toBe("fixture-model");
    expect(binding.frozen_invocation.effortArgs).toEqual(["--effort", "high"]);
    expect(binding.logical_round_id).toBe(run.logical_round_id);
    expect(s.store.must<Run>("run", run.id)).toEqual(run);
  });

  it("ordinary network retry keeps the failed account scope", () => {
    const run = source();
    switchIdentity();
    stageModelRunRetry(s.store, workflowId, run.id);
    const binding = bindProfile(s.store, s.config, workflowId, "quality_review", buildDispatchContext(s.store, workflowId, "quality_review"));
    expect(binding.frozen_invocation).toEqual(run.frozen_invocation);
  });

  it("rejects a pre-permit account mismatch without asking for a permit", async () => {
    const run = source(); seedAccess(); switchIdentity(); seedAccess();
    const acquire = vi.spyOn(accounts.service, "acquireUsagePermit");
    await expect(bridge.prepareProfileRun(workflowId, run, "fixture-model")).rejects.toMatchObject({ code: "MODEL_IDENTITY_CHANGED" });
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each(["account", "authorization"])("releases the permit when %s changes during acquisition", async (change) => {
    const run = source(); seedAccess();
    const acquire = accounts.service.acquireUsagePermit.bind(accounts.service);
    vi.spyOn(accounts.service, "acquireUsagePermit").mockImplementation(async (request) => {
      const permit = await acquire(request);
      if (change === "account") switchIdentity();
      else access.invalidate(run.frozen_invocation!, "MODEL_LOGIN_REQUIRED");
      return permit;
    });
    await expect(bridge.prepareProfileRun(workflowId, run, "fixture-model")).rejects.toMatchObject({
      code: change === "account" ? "AGY_ACCOUNT_BINDING_STALE" : "MODEL_LOGIN_REQUIRED" });
    expect(accounts.repository.listPermits(realmId).every((permit) => permit.status === "released")).toBe(true);
    expect(await bridge.listOccupancy()).toEqual([]);
    expect(s.store.must<Run>("run", run.id).agy_account).toBeUndefined();
  });

  it("attaches a same-identity permit without changing the frozen command", async () => {
    const run = source(); seedAccess();
    const binding = await bridge.prepareProfileRun(workflowId, run, "fixture-model");
    expect(binding?.account_id).toBe("a");
    expect(s.store.must<Run>("run", run.id).frozen_invocation).toEqual(run.frozen_invocation);
    expect(s.store.must<Run>("run", run.id).agy_account).toEqual(binding);
  });

  it("invalidates the source account auth cache before an auth failure becomes account-wait", async () => {
    const run = source(); const record = seedAccess();
    const binding = await bridge.prepareRun({ workflow_id: workflowId, run_id: run.id,
      effective_model_id: "fixture-model", account_policy_revision: 1, required_pool_ids: ["fixture-pool"] });
    const fact = classifyAgyFailure({ realmId, accountId: "a", authEpoch: binding.auth_epoch,
      runId: run.id, currentTurn: true, eventOffset: 2, event: { type: "error", code: "auth_invalid" } });
    expect(await bridge.observeFailure(binding, fact)).toBe(true);
    expect(access.getAccess(record.key)?.status).toBe("login_required");
  });
});
