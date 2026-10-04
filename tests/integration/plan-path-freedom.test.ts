import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, project, plan, repository, proof } from "../helpers.js";
import { validatePlan } from "../../packages/plans/src/validate.js";
import { FileBroker } from "../../packages/workspace/src/files.js";
import { ScopeSchema, FlowError } from "../../packages/contracts/src/index.js";
import { objectHash, hash } from "../../packages/core/src/util.js";
import { repairFailure } from "../../packages/core/src/repair.js";

const stores: ReturnType<typeof setup>["store"][] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

async function executingFixture() {
  const s = setup(); stores.push(s.store);
  const r = await repository(s.root);
  const p = project(r.repo);
  await s.engine.registerProject(p);
  const w = s.engine.create({ project_id: p.id, title: "关联接线", request: "完成相关开发",
    complexity: "simple", workspace_mode: "existing_workspace" }, "fixture");
  await s.engine.git.prepare(p, w.id, w.workspace_mode, { main: r.baseline });
  s.engine.submitPlan(w.id, plan(objectHash(p), r.baseline), w.version, "plan");
  const authorization = proof(s.engine, w.id, "approve");
  s.engine.approve(w.id, authorization.proof, authorization.binding);
  const workflow = s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", { run_id: "run-test" });
  const principal = { role: "worker" as const, workflow_id: w.id, run_id: "run-test", expires: Date.now() + 100000 };
  return { ...s, workflow, principal };
}

it("accepts a multi-repository plan with optional location hints and no file authorization lists", () => {
  const s = setup(); stores.push(s.store);
  const p = project(s.root);
  p.repositories.push({ id: "backend", path: join(s.root, "backend") });
  p.primary_repo_id = "main";
  s.store.put("project", p.id, "global", p);
  const w = s.engine.create({ project_id: p.id, title: "关联代码", request: "完成相关开发", complexity: "simple",
    workspace_mode: "existing_workspace" }, "freedom");
  const input: any = plan(objectHash(p), "a".repeat(40));
  delete input.scope;
  input.baselines.backend = "b".repeat(40);
  input.tasks[0].repo_id = "main";
  delete input.tasks[0].paths;
  const normalized = validatePlan(input).plan;
  expect(normalized.scope.allowed_paths).toEqual([]);
  expect(normalized.tasks[0]!.paths).toEqual([]);
  expect(() => s.engine.submitPlan(w.id, input, w.version, "submit-freedom")).not.toThrow();
});

it("writes and freezes a required related file missing from the legacy plan paths", async () => {
  const s = await executingFixture();
  const { broker, root } = s.engine.files(s.principal, s.workflow.id, "main", true);
  broker.apply(root, s.engine.plan(s.workflow.id).plan.scope, [
    { path: "related.txt", expected_hash: null, content: "required wiring\n" },
    { path: "app.txt", expected_hash: hash("before\n"), content: "after\n" },
  ]);
  expect(readFileSync(join(root, "related.txt"), "utf8")).toBe("required wiring\n");
  s.engine.claimTask(s.principal, s.workflow.id, "T01", "完成原需求及必要关联接线");
  const snapshot = await s.engine.freeze(s.workflow.id, s.principal);
  expect(snapshot.repositories[0]!.changed_paths).toContain("related.txt");
});

it("retains filesystem and stale-content protection without requiring a file whitelist", () => {
  const s = setup(); stores.push(s.store);
  const broker = new FileBroker();
  expect(() => broker.apply(s.root, ScopeSchema.parse({}), [
    { path: "../outside.txt", expected_hash: null, content: "bad" },
  ])).toThrow();
  expect(() => broker.apply(s.root, ScopeSchema.parse({}), [
    { path: ".git/config", expected_hash: null, content: "bad" },
  ])).toThrow();
});

it("does not count a pre-model plan read failure as an executor repair attempt", async () => {
  const s = await executingFixture();
  const result = await repairFailure(s.engine, s.workflow.id,
    new FlowError("PLAN_MATERIAL_CONFLICT", "计划原件引用与登记路径不一致"), s.workflow.run_id!);
  expect(result).toBeNull();
  expect(s.store.get("repair_state", s.workflow.id)).toBeUndefined();
});
