import { afterEach, expect, it } from "vitest";
import { appendFileSync, existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setup, project, plan, proof, testConsoleHeaders } from "../helpers.js";
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
it("stores one original and hands models its path and current text after appended progress", () => {
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
  expect(materials.markdown).toBe(current.markdown);
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
    const response = await app.inject({ method: "GET", url: `/api/workflows/${s.w.id}/documents/plan?revision=99`, headers: { host: testConsoleHeaders().host } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().document.content).toBe(readFileSync(material.path!, "utf8"));
    const download = await app.inject({ method: "GET", url: `/api/workflows/${s.w.id}/documents/plan?format=markdown`, headers: { host: testConsoleHeaders().host } });
    expect(download.body).toBe(response.json().document.content);
  } finally { await app.close(); }
});
it("does not reject free-form progress or unresolved issues in the document", () => {
  const input = plan("project-config", "a".repeat(40));
  input.markdown = "# 工作计划\nTODO: 等待接口方确认\n";
  input.unresolved_decisions = ["外部接口尚未恢复"];
  expect(() => validatePlan(input)).not.toThrow();
});

it.each(["relative", "repo-qualified"])("keeps the approved %s original after an execution worktree is registered", (mode) => {
  const s = fixture();
  const original = readPlanMaterial(s.store, s.w.id, s.w.plan_revision);
  const record = s.engine.plan(s.w.id);
  const ref = `docs/plan/${s.w.id}/plan.md`;
  // The default original has this path; both copies may later exist and differ.
  expect(original.path).toBe(join(s.root, ref));
  s.store.put("plan", record.id, s.w.id, { ...record,
    plan: { ...record.plan, design_ref: { summary: "原件", file_ref: mode === "repo-qualified" ? `main:${ref}` : ref } } });
  const authorization = proof(s.engine, s.w.id, "approve");
  s.engine.approve(s.w.id, authorization.proof, authorization.binding);
  const workspaceRoot = join(s.root, ".worktrees", s.w.id, "main");
  s.store.put("workspace", "execution-ws", s.w.id, { id: "execution-ws", workflow_id: s.w.id,
    repo_id: "main", root: workspaceRoot, source_root: s.root });
  mkdirSync(dirname(join(workspaceRoot, ref)), { recursive: true });
  writeFileSync(join(workspaceRoot, ref), "# 工作树中的其他副本\n");
  const after = assertPlanMaterialReady(s.store, s.w.id, s.w.plan_revision);
  expect(after.path).toBe(original.path);
  expect(after.markdown).toBe(original.markdown);
  const runtime = new ProfileRuntime(s.engine, {} as any) as any;
  expect(runtime.planReference(s.engine.get(s.w.id)).path).toBe(original.path);
  s.engine.exportDocuments(s.w.id);
  expect(s.store.get<any>("project_document", `doc_${s.w.id}_plan`).path).toBe(original.path);
});

it("still rejects a changed relative reference instead of silently reading another original", () => {
  const s = fixture();
  const record = s.engine.plan(s.w.id);
  s.store.put("plan", record.id, s.w.id, { ...record,
    plan: { ...record.plan, design_ref: { summary: "其他计划", file_ref: "docs/plan/other.md" } } });
  expect(() => readPlanMaterial(s.store, s.w.id, s.w.plan_revision)).toThrow("计划原件引用与登记路径不一致");
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


it.each(["approved", "missing-approval", "other-plan"] as const)("registered external original preserves exact plan authorization: %s", (mode) => {
  const s = fixture();
  const externalRoot = mkdtempSync(join(realpathSync(tmpdir()), "devflow-approved-original-"));
  const path = join(externalRoot, "original.md");
  const body = "# 已批准的原始计划\n";
  writeFileSync(path, body);
  try {
    const record = s.engine.plan(s.w.id);
    s.store.put("plan", record.id, s.w.id, { ...record, material_path: path,
      plan: { ...record.plan, design_ref: { file_ref: path, content_hash: "legacy", summary: "original" } } });
    const doc = s.store.get<any>("project_document", `doc_${s.w.id}_plan`)!;
    s.store.put("project_document", doc.id, s.w.id, { ...doc, path });
    if (mode !== "missing-approval") s.store.put("approval", `${s.w.id}-${s.w.plan_revision}`, s.w.id,
      { plan_hash: mode === "approved" ? record.hash : "different-plan" });
    if (mode !== "approved") {
      expect(() => assertPlanMaterialReady(s.store, s.w.id)).toThrow("计划原件必须属于项目或任务工作区");
      return;
    }
    expect(assertPlanMaterialReady(s.store, s.w.id)).toMatchObject({ path, markdown: body, authority_ready: true });
    appendFileSync(path, "\n进度：已完成第一项\n");
    expect(readPlanMaterial(s.store, s.w.id, s.w.plan_revision).markdown).toContain("已完成第一项");
    rmSync(path);
    expect(() => readPlanMaterial(s.store, s.w.id, s.w.plan_revision)).toThrow("已登记的项目计划原件已丢失");
  } finally { rmSync(externalRoot, { recursive: true, force: true }); }
});
