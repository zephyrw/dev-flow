import { afterEach, expect, it } from "vitest";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setup, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { assertPlanMaterialReady, readPlanMaterial } from "../../packages/core/src/plan-review.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { buildServer } from "../../apps/api/src/server.js";
import { validatePlan } from "../../packages/plans/src/validate.js";

const stores: ReturnType<typeof setup>[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.store.close(); });
function fixture() {
  const s = setup(); stores.push(s);
  const p = project(s.root); s.store.put("project", p.id, "global", p);
  const w = s.engine.create({ project_id: p.id, title: "原件计划", request: "继续已有任务", complexity: "simple", workspace_mode: "new_worktree" }, "original");
  const input = plan(objectHash(p), "a".repeat(40));
  input.markdown = "# 原计划\n\n待解决问题：等待用户提供凭据。\n";
  s.engine.submitPlan(w.id, input, w.version, "plan");
  return { ...s, w: s.engine.get(w.id) };
}
it("stores one original, accepts appended progress and hands models only its path", () => {
  const s = fixture();
  const material = readPlanMaterial(s.store, s.w.id, s.w.plan_revision);
  expect(material.path).toBeTruthy();
  expect(material.authority_ready).toBe(true);
  expect(s.engine.plan(s.w.id).plan.markdown).toBeUndefined();
  expect(s.store.list<any>("project_document", s.w.id).every(d => !d.content)).toBe(true);
  appendFileSync(material.path!, "\n执行进度：已完成开发；尚有接口问题待解决。\n");
  const current = readPlanMaterial(s.store, s.w.id, s.w.plan_revision);
  expect(current.markdown).toContain("已完成开发");
  expect(s.engine.detail(s.w.id, false).plan?.plan.markdown).toEqual(current.markdown);
  const runtime = new ProfileRuntime(s.engine, {} as any) as any;
  const materials = runtime.planReference(s.w);
  expect(materials.path).toBe(material.path);
  expect(JSON.stringify(materials)).not.toContain("已完成开发");
  expect(materials.plan.markdown).toBeUndefined();
  s.engine.exportDocuments(s.w.id);
  expect(existsSync(join(s.config.storage_root, "documents"))).toBe(false);
  const authorization = proof(s.engine, s.w.id, "approve");
  expect(() => s.engine.approve(s.w.id, authorization.proof, authorization.binding)).not.toThrow();
});
it("detail and download read the same current original instead of old cached text", async () => {
  const s = fixture(); const app = await buildServer(s.engine);
  try {
    const material = readPlanMaterial(s.store, s.w.id, s.w.plan_revision);
    appendFileSync(material.path!, "\n后续进度：继续处理未解决项。\n");
    const response = await app.inject({ method: "GET", url: `/api/workflows/${s.w.id}/documents/plan?revision=99`, headers: { host: "localhost:14810" } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().document.content).toBe(readFileSync(material.path!, "utf8"));
    const download = await app.inject({ method: "GET", url: `/api/workflows/${s.w.id}/documents/plan?format=markdown`, headers: { host: "localhost:14810" } });
    expect(download.body).toBe(response.json().document.content);
  } finally { await app.close(); }
});
it("does not reject free-form progress or unresolved issues in the document", () => {
  const input = plan("project-config", "a".repeat(40));
  input.markdown = "# 工作计划\nTODO: 等待接口方确认\n";
  input.unresolved_decisions = ["外部接口尚未恢复"];
  expect(() => validatePlan(input)).not.toThrow();
});

it("never rescues a missing registered original from stale plan prose", () => {
  const s = fixture();
  const current = readPlanMaterial(s.store, s.w.id, s.w.plan_revision);
  const record = s.engine.plan(s.w.id);
  s.store.put("plan", record.id, s.w.id, { ...record, plan: { ...record.plan, markdown: "# stale rescue" } });
  rmSync(current.path!);
  expect(() => readPlanMaterial(s.store, s.w.id, s.w.plan_revision)).toThrow("已登记的项目计划原件已丢失");
});

it("does not authorize a path without its original registration", () => {
  const s = fixture();
  s.store.remove("project_document", `doc_${s.w.id}_plan`);
  expect(() => assertPlanMaterialReady(s.store, s.w.id, s.w.plan_revision)).toThrow();
});

it.each(["pending", "conflict"] as const)("an explicit %s material cannot be hidden by an original registration", (status) => {
  const s = fixture();
  const record = s.engine.plan(s.w.id);
  const id = `mat_${s.w.id}_explicit`;
  s.store.put("project_material", id, s.w.id, {
    id, workflow_id: s.w.id, workspace_id: "missing-workspace", kind: "plan",
    revision: s.w.plan_revision, path: "docs/plan/original.md", status,
    source_hash: "legacy", created_at: "2026-09-29T00:00:00.000Z", updated_at: "2026-09-29T00:00:00.000Z",
  });
  s.store.put("plan", record.id, s.w.id, { ...record, material_id: id,
    plan: { ...record.plan, markdown: "# pending result" } });
  if (status === "pending") {
    const result = readPlanMaterial(s.store, s.w.id, s.w.plan_revision);
    expect(result.source_type).toBe("result_pending");
    expect(result.authority_ready).toBe(false);
  }
  expect(() => assertPlanMaterialReady(s.store, s.w.id, s.w.plan_revision)).toThrow();
});
