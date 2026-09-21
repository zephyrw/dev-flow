import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/store/src/store.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import type { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import { classifyAgyFailure } from "../../packages/adapters/agy/src/failure-fact.js";
import type { Engine } from "../../packages/core/src/engine.js";
import { type ToolProfile } from "../../packages/contracts/src/index.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { frozenInvocationFromProfile } from "../../packages/core/src/run-profile.js";

describe("AGY workflow account boundary", () => {
  let directory: string;
  let store: Store;
  let fixture: ReturnType<typeof accountFixture>;
  let bridge: AgyWorkflowBridge;
  const stop = vi.fn(async () => {});
  const confirm = vi.fn(async () => true);
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "agy-bridge-"));
    store = new Store(join(directory, "devflow.sqlite"));
    fixture = accountFixture(store);
    fixture.seedAccounts();
    fixture.repository.savePolicy({
      workflow_id: "wf-1",
      revision: 1,
      auto_switch: true,
      allowed_account_ids: null,
      recreation_policy: "exact_only",
      night_pool: "normal",
      created_at: new Date().toISOString(),
    });
    await fixture.service.start({
      realmId: "default-agy-realm",
      requestId: "start",
    });
    stop.mockClear();
    confirm.mockClear();
    confirm.mockResolvedValue(true);
    bridge = new AgyWorkflowBridge(
      fixture.service,
      { stop, get: () => undefined } as unknown as ProcessManager,
      undefined,
      undefined,
      { confirmJobsStopped: confirm } as unknown as AgyAccountProcessHost,
    );
  });
  afterEach(async () => {
    bridge.dispose();
    for (const permit of fixture.repository.listPermits("default-agy-realm"))
      await fixture.service.releaseUsagePermit(permit.permit_id, {
        permit_id: permit.permit_id,
        success: false,
      });
    await fixture.service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = () => ({
    workflow_id: "wf-1",
    run_id: "run-1",
    effective_model_id: "fixture-model",
    account_policy_revision: 1,
    required_pool_ids: ["fixture-pool"],
  });
  it("binds the real credential/settings revision and releases its permit", async () => {
    const binding = await bridge.prepareRun(request());
    expect(binding.credential_revision_at_start).toBe(
      fixture.repository.getAccount(binding.realm_id, binding.account_id)!
        .credential_revision,
    );
    expect(binding.account_settings_revision_at_start).toBe(
      fixture.repository.getSettings(binding.realm_id)!.revision,
    );
    await bridge.releaseRun("run-1", true);
    expect(fixture.repository.getPermit(binding.permit_id)?.status).toBe(
      "released",
    );
  });
  it("rejects stale identity facts and never treats textual quota as a switch command", async () => {
    const binding = await bridge.prepareRun(request());
    const base = {
      realmId: binding.realm_id,
      accountId: binding.account_id,
      authEpoch: binding.auth_epoch,
      runId: "run-1",
    };
    expect(
      await bridge.observeFailure(
        binding,
        classifyAgyFailure({ ...base, errorMessage: "quota_exhausted 429" }),
      ),
    ).toBe(false);
    expect(
      await bridge.observeFailure(
        binding,
        classifyAgyFailure({
          ...base,
          authEpoch: binding.auth_epoch + 1,
          event: { type: "error", code: "quota_exhausted" },
          currentTurn: true,
          eventOffset: 3,
        }),
      ),
    ).toBe(false);
    expect(fixture.probeCalls()).toBe(0);
  });
  it("stops by run id and requires the actual Job to be empty", async () => {
    await bridge.prepareRun(request());
    await bridge.prepareSwitch("op-1");
    await bridge.quiesce("op-1");
    expect(stop).toHaveBeenCalledWith("run-1", "account_switch");
    confirm.mockResolvedValue(false);
    expect(await bridge.confirmStopped("op-1")).toBe(false);
    expect(await bridge.confirmStopped("unknown-op")).toBe(false);
  });
  it("enqueues a verified current failure once without claiming an immediate switch", async () => {
    const binding = await bridge.prepareRun(request());
    const fact = classifyAgyFailure({
      realmId: binding.realm_id,
      accountId: binding.account_id,
      authEpoch: binding.auth_epoch,
      runId: "run-1",
      currentTurn: true,
      eventOffset: 2,
      event: { type: "error", code: "quota_exhausted" },
    });
    expect(await bridge.observeFailure(binding, fact)).toBe(true);
    expect(await bridge.observeFailure(binding, fact)).toBe(true);
    expect(fixture.active()).toBe("a");
    expect(
      fixture.repository
        .listOperations(binding.realm_id)
        .filter((op) => op.kind === "switch"),
    ).toHaveLength(1);
  });
  it.each([
    { version: 3, resumes: 1 },
    { version: 4, resumes: 0 },
  ])(
    "resumes only the unchanged account wait (version $version)",
    async ({ version, resumes }) => {
      bridge.dispose();
      const workflow = {
        id: "wf-1",
        version: 2,
        state: "EXECUTING",
        run_id: "run-1",
        plan_revision: 1,
        plan_hash: "plan",
      };
      const profile: ToolProfile = {
        id: "profile", revision: 1, adapterId: "agy", executableRef: process.execPath,
        modelSelection: "explicit", modelId: "fixture-model", selectionKind: "fixed",
        reasoning: { mode: "native-default" }, options: {},
      };
      const access = new ModelAccessService(store);
      const native = access.resolveNativeConfig(profile);
      access.seedVerified(profile);
      store.put("run", "run-1", "wf-1", {
        id: "run-1",
        workflow_id: "wf-1",
        purpose: "implement",
        profile,
        conversation_id: "conv-1",
        frozen_invocation: {
          ...frozenInvocationFromProfile(profile, "profile-native"),
          accountScope: native.accountFingerprint,
          providerScope: native.providerEndpointFingerprint,
          identityConfidence: native.identityConfidence,
        },
      });
      const restore = vi.fn(() => true);
      const engine = {
        store,
        get: () => workflow,
        waitForIdle: async () => {},
        restoreFailedRole: restore,
        dispatch: async () => {},
        block: vi.fn(),
      } as unknown as Engine;
      bridge = new AgyWorkflowBridge(
        fixture.service,
        { stop, get: () => undefined } as unknown as ProcessManager,
        undefined,
        engine,
        { confirmJobsStopped: confirm } as unknown as AgyAccountProcessHost,
      );
      const binding = await bridge.prepareRun(request());
      await bridge.prepareSwitch("recovery-op");
      Object.assign(workflow, {
        state: "BLOCKED",
        version,
        blocker: { code: "AGY_ACCOUNT_WAIT" },
      });
      await bridge.onAccountCommitted({
        realm_id: binding.realm_id,
        operation_id: "recovery-op",
        account_id: binding.account_id,
        auth_epoch: binding.auth_epoch,
      });
      expect(restore).toHaveBeenCalledTimes(resumes);
      expect(
        store.get("agy_recovery_checkpoint", "recovery-op:run-1"),
      ).toBeDefined();
    },
  );
});
