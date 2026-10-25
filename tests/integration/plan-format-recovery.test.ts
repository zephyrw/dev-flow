import { expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { setup, project } from "../helpers.js";
import { FlowError, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import type { Runtime } from "../../packages/core/src/engine.js";
import { parsePlanInput } from "../../packages/contracts/src/plan-input.js";
import { NativePlanSchema } from "../../packages/contracts/src/native-plan.js";
import { validatePlan } from "../../packages/plans/src/validate.js";

it("normalizes the incident sample consistently in native planning and formal submission", () => {
  const value = { task_model: "native-v2", revision: 1, design_ref: { summary: "界面调整" },
    modules: [{ id: "m", title: "混剪", paths: ["src/views/homepage/material/ai-mix/"] }],
    work_items: [{ id: "w", module_id: "m", title: "优化界面", paths: ["src/"], acceptance_ids: ["a"] }],
    acceptance_items: [{ id: "a", work_item_ids: ["w"], layer: "e2e", scenario: "打开界面", expected_outcome: "正常显示" }],
    baselines: { main: "a".repeat(40) }, project_config_hash: "test" };
  const native = parsePlanInput(NativePlanSchema, value);
  const submitted = validatePlan(value).plan;
  expect(submitted.modules?.[0]?.paths).toEqual(native.modules[0]!.paths);
  expect(submitted.modules?.[0]?.paths).toEqual(["src/views/homepage/material/ai-mix"]);
});

it("returns one format correction to the original planner binding, then blocks precisely without approving", async () => {
  const s = setup();
  try {
    const p = project(s.root); s.store.put("project", p.id, "global", p);
    const created = s.engine.create({ project_id: p.id, title: "格式修正", request: "仅规划", complexity: "simple", workspace_mode: "existing_workspace" }, "fixture");
    s.engine.transition(created.id, [created.state], "PLANNING", "planning");
    const plan = vi.fn(async (_w: Workflow, run: Run) => {
      s.store.put("run", run.id, created.id, { ...s.store.must<Run>("run", run.id), conversation_id: "original-conversation" });
      throw new FlowError("PLAN_VALIDATION_FAILED", "modules.0.paths.0：必须是相对路径", 422, { fields: [{ path: "modules.0.paths.0", value: "../src", reason: "unsafe" }] });
    });
    s.engine.runtime = { plan } as unknown as Runtime;
    const engine = s.engine as unknown as { runPlanning(w: Workflow, id: string): Promise<void> };
    await engine.runPlanning(s.engine.get(created.id), "first");
    expect(s.engine.get(created.id).state).toBe("PLANNING");
    expect(s.store.get("pending_model_retry", created.id)).toMatchObject({ retry_run_id: "first" });
    await engine.runPlanning(s.engine.get(created.id), "second");
    expect(plan.mock.calls[1]![1].profile).toEqual(plan.mock.calls[0]![1].profile);
    expect(s.store.get("model_input_feedback", "second")).toMatchObject({ message: expect.stringContaining("../src") });
    expect(s.engine.get(created.id)).toMatchObject({ state: "BLOCKED", blocker: { code: "PLAN_VALIDATION_FAILED" } });
    expect(s.store.get("pending_model_retry", created.id)).toBeUndefined();
    expect(s.store.list("approval", created.id)).toHaveLength(0);
  } finally { s.store.close(); rmSync(s.root, { recursive: true, force: true }); }
});
