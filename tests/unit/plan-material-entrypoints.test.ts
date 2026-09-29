import { describe, expect, it, vi } from "vitest";
import { PlanApprovalService } from "../../packages/core/src/plan-approval-service.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";

describe("F01 material authority at approval and dispatch", () => {
  it.each(["pending", "conflict", "platform_legacy"])("rejects %s without consuming proof or enqueueing", (status) => {
    const plan = { revision: 1, material_id: status === "platform_legacy" ? undefined : "mat", plan: { markdown: "# plan" } };
    const material = { id: "mat", workflow_id: "wf", kind: "plan", revision: 1, status, path: "docs/plan/plan.md" };
    const store = {
      get: (entity: string) => entity === "project_material" && status !== "platform_legacy" ? material : undefined,
      list: (entity: string) => entity === "plan" ? [plan] : [],
      transaction: (work: () => unknown) => work(),
      put: vi.fn(), enqueue: vi.fn(),
    };
    const rejection = status === "conflict" ? /发生内容冲突/ : /只可查看/;
    const workflow = { id: "wf", state: "PLAN_PENDING", version: 1, plan_revision: 1 };
    const engine = { store, get: () => workflow, auth: { consumeProof: vi.fn() }, scheduler: { enqueue: vi.fn() } };
    expect(() => new PlanApprovalService(engine as any).approveSync({ workflowId: "wf", requestId: "request", binding: {}, callerProof: "proof" })).toThrow(rejection);
    expect(engine.auth.consumeProof).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(store.enqueue).not.toHaveBeenCalled();
    expect(engine.scheduler.enqueue).not.toHaveBeenCalled();
    expect(() => (ProfileRuntime.prototype as any).executeMaterials.call({ engine }, workflow, {})).toThrow(rejection);
  });
});
