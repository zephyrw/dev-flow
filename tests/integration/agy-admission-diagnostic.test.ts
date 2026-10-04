import { afterEach, expect, it, vi } from "vitest";
import { setup, project } from "../helpers.js";
import { AgyWorkflowBridge } from "../../packages/runtime/src/agy-workflow-bridge.js";
import { AccountServiceError, type AgyAccountService } from "../../packages/agy-accounts/src/service.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  { error: new AccountServiceError("permit_admission_changed"), code: "permit_admission_changed", errorClass: "AccountServiceError" },
  { error: Object.assign(new Error("private raw CLI output"), { code: "agy_model_probe_timeout" }),
    code: "agy_model_probe_timeout", errorClass: "Error" },
  { error: new AccountServiceError("target_model_unavailable"), code: "target_model_unavailable", errorClass: "AccountServiceError" },
  { error: new Error("probe_identity_busy"), code: "probe_identity_busy", errorClass: "Error" },
  { error: new Error("RPC failed with secret-token-123 and private credential data"), code: "unknown", errorClass: "Error" },
])("preserves safe admission diagnosis $code without exposing raw error text", async ({ error, code, errorClass }) => {
  const s = setup();
  let bridge: AgyWorkflowBridge | undefined;
  try {
    const p = project(s.root);
    s.store.put("project", p.id, p.id, p);
    const w = s.engine.create({ project_id: p.id, title: "admission", request: "isolated diagnostic",
      complexity: "simple", workspace_mode: "existing_workspace" }, "create");
    const service = {
      registerConsumer: () => () => {}, setWorkflowWaitValidator: () => {},
      isManaged: () => true, syncActiveAccountFromHost: async () => {},
      getRepository: () => ({ getPolicy: () => ({ revision: 1, allowed_account_ids: null }) }),
      resolveModelPools: () => ["global"], acquireUsagePermit: async () => { throw error; },
    } as unknown as AgyAccountService;
    vi.spyOn(ModelAccessService.prototype, "resolveNativeConfig").mockReturnValue({ accountFingerprint: "fixture" } as any);
    vi.spyOn(ModelAccessService.prototype, "assertFrozenAccess").mockReturnValue({} as any);
    bridge = new AgyWorkflowBridge(service, {} as ProcessManager, undefined, s.engine);
    const run = { id: "diagnostic-run", workflow_id: w.id, profile: { adapterId: "agy" },
      frozen_invocation: { adapterId: "agy", modelToken: "fixture-model", accountScope: "fixture" } } as Run;
    let caught: unknown;
    try { await bridge.prepareProfileRun(w.id, run, "fixture-model"); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(FlowError);
    expect(caught).toMatchObject({ code: code === "agy_model_probe_timeout" ? "AGY_MODEL_PROBE_TIMEOUT" : "AGY_ACCOUNT_UNAVAILABLE",
      details: { code, error_class: errorClass } });
    if (code === "agy_model_probe_timeout") expect((caught as Error).message).toContain("尚未确认模型不可用");
    if (code === "target_model_unavailable") expect((caught as Error).message).toContain("访问核验");
    const event = s.store.events(w.id).find((entry) => entry.type === "AgyAccountAdmissionFailed");
    expect(event?.run_id).toBe(run.id);
    expect(event?.payload).toEqual({ code, error_class: errorClass });
    expect(JSON.stringify(event)).not.toContain("secret-token-123");
    expect(JSON.stringify(event)).not.toContain("private raw CLI output");
  } finally { bridge?.dispose(); s.store.close(); }
});
