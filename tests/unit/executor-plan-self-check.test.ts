import { describe, it, expect } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { PlanSelfCheckCoordinator } from "../../packages/core/src/plan-self-check.js";
import { plan } from "../helpers.js";
import type {
  Workflow,
  Run,
  DeliveryManifest,
} from "../../packages/contracts/src/index.js";
import { objectHash } from "../../packages/core/src/util.js";

describe("计划自查不再作为交接门禁", () => {
  it("普通执行携带或不携带自查字段都不阻断，authorities 只提供历史正文", () => {
    const store = new Store(":memory:");
    const gate = new PlanSelfCheckCoordinator(store);
    const p = plan("project", "a".repeat(40));
    store.put("plan", "w-1", "w", { revision: 1, hash: objectHash(p), plan: p });
    store.put("approval", "w-1", "w", {
      revision: 1,
      plan_hash: objectHash(p),
    });
    const w: Workflow = {
      id: "w",
      project_id: "p",
      title: "t",
      request: "r",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "EXECUTING",
      stage: "execute",
      version: 1,
      plan_revision: 1,
      plan_hash: objectHash(p),
      environment_revision: 0,
      feedback: [],
      created_at: "now",
      updated_at: "now",
    };
    const run: Run = {
      id: "ordinary",
      workflow_id: "w",
      plan_revision: 1,
      adapter: "agy",
      stage: "execute",
      status: "running",
      started_at: "now",
      package_hash: "pkg",
    };
    const manifest: DeliveryManifest = {
      implementations: [],
      test_executions: [],
      acceptance_mappings: [],
      unfinished_items: [],
      plan_conflicts: [],
      plan_self_check: {
        request_id: "fake",
        source_delivery_revision_id: "fake",
        plan_revision: 1,
        plan_hash: w.plan_hash!,
        authority_hash: "fake",
        run_id: run.id,
        verdict: "passed",
        checks: [],
        findings: [],
      },
    };
    expect(() => gate.validateDelivery(w, run, manifest)).not.toThrow();
    expect(() => gate.validateDelivery(w, run, { ...manifest, plan_self_check: undefined })).not.toThrow();
    expect(gate.authorities(w).map((a) => a.revision)).toEqual([1]);
    expect(gate.assertPassed(w)).toBeUndefined();
    store.close();
  });
});
