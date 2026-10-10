import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/store/src/store.js";
import { DocumentService } from "../../packages/core/src/document-service.js";
import { originalPlanPath, resolveMaterialLocator, publishProjectMaterialSafely, readProjectMaterialByLocator,
  reconcileMaterialOutbox } from "../../packages/core/src/project-materials.js";
import { readPlanMaterial } from "../../packages/core/src/plan-review.js";
import { PlanSelfCheckCoordinator } from "../../packages/core/src/plan-self-check.js";

let store: Store;
let root: string;
let docs: DocumentService;
const wid = "single-original";
beforeEach(() => {
  store = new Store(":memory:");
  root = mkdtempSync(join(realpathSync(tmpdir()), "devflow-single-document-"));
  docs = new DocumentService(store, join(root, ".devflow"));
  store.put("project", "project", "project", { id: "project", primary_repo_id: "main", repositories: [{ id: "main", path: root }] });
  store.put("workflow", wid, "project", { id: wid, project_id: "project", plan_revision: 1, plan_hash: "contract-hash" });
  store.put("plan", `${wid}-1`, wid, { id: `${wid}-1`, revision: 1, hash: "contract-hash", plan: {
    markdown: "legacy cached prose", design_ref: { content_hash: "stale-prose-hash" }, tasks: [], tests: [],
  } });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
function planRef(path: string) {
  const p = store.must<any>("plan", `${wid}-1`);
  store.put("plan", p.id, wid, { ...p, plan: { ...p.plan, design_ref: { ...p.plan.design_ref, file_ref: path } } });
}

it("creates one project original without requiring a workspace and stores references only", () => {
  const a = docs.publishDocument(wid, "plan", "# First plan", 1);
  const b = docs.publishDocument(wid, "plan", "# Old returned text", 2);
  expect(a.path).toBe(join(root, "docs", "plan", wid, "plan.md"));
  expect(b.path).toBe(a.path);
  expect(b.content).toBe("# First plan");
  expect(store.list("project_document", wid)).toHaveLength(1);
  expect(store.must<any>("project_document", a.id).content).toBeUndefined();
  expect(existsSync(join(root, ".devflow", "documents"))).toBe(false);
  expect(existsSync(join(root, "docs", "plan", wid, "plan-r2.md"))).toBe(false);
});

it("updates the same original only for explicit current-Run publication", () => {
  const doc = docs.publishDocument(wid, "plan", "# Initial", 1);
  writeFileSync(doc.path!, "# Initial\n\nProgress: completed A", "utf8");
  docs.publishDocument(wid, "plan", "# stale cache", 2, doc.path);
  expect(readFileSync(doc.path!, "utf8")).toContain("Progress");
  const updated = docs.publishDocument(wid, "plan", "# Revised\n\nProgress: completed A", 2, doc.path, true);
  expect(updated.path).toBe(doc.path);
  expect(updated.content).toContain("# Revised");
  expect(store.list("project_document", wid)).toHaveLength(1);
});

it("reads external progress edits live and does not approve against stale prose hashes", () => {
  const doc = docs.publishDocument(wid, "plan", "# Plan", 1);
  writeFileSync(doc.path!, "# Plan\n\n## Issue\nInvestigating", "utf8");
  const material = readPlanMaterial(store, wid, 1);
  expect(material.markdown).toContain("Investigating");
  expect(material.path).toBe(doc.path);
  const approved = docs.approveDocument(wid, doc.id, { request_id: "approval", expected_version: 1,
    document_revision: 99, document_hash: "old-content", feedback_cursor: 0 });
  expect(approved.content).toContain("Investigating");
  expect(store.must<any>("project_document", doc.id).content).toBeUndefined();
});

it("prefers the explicit design original over stale revision materials and document caches", () => {
  const original = join(root, "existing-plan.md");
  writeFileSync(original, "# User original\nProgress", "utf8");
  planRef(original);
  store.put("project_material", "old-copy", wid, { id: "old-copy", workflow_id: wid, kind: "plan", revision: 1,
    workspace_id: "workspace", path: "wrong.md", source_hash: "old", status: "conflict" });
  const doc = docs.publishDocument(wid, "plan", "# cached replacement", 1, join(root, "new-copy.md"));
  expect(doc.path).toBe(original);
  expect(readPlanMaterial(store, wid, 1).markdown).toContain("User original");
  expect(existsSync(join(root, "new-copy.md"))).toBe(false);
});

it("supports relative file references and prioritizes explicit material_path over an unrelated revision record", () => {
  const original = join(root, "original.md"); writeFileSync(original, "original");
  planRef("main:original.md");
  expect(originalPlanPath(store, wid)).toBe(original);
  const p = store.must<any>("plan", `${wid}-1`);
  delete p.plan.design_ref.file_ref;
  store.put("plan", p.id, wid, { ...p, material_path: original });
  store.put("workspace", "workspace", wid, { id: "workspace", workflow_id: wid, repo_id: "main", root });
  store.put("project_material", "wrong", wid, { id: "wrong", kind: "plan", revision: 1, workspace_id: "workspace", path: "wrong.md" });
  expect(originalPlanPath(store, wid)).toBe(original);
});

it("does not mask a missing referenced original with cached prose", () => {
  const missing = join(root, "missing.md");
  planRef(missing);
  docs.publishDocument(wid, "plan", "# Registered original", 1, missing);
  unlinkSync(missing);
  expect(() => readPlanMaterial(store, wid, 1)).toThrow("已登记的项目计划原件已丢失");
  expect(existsSync(join(root, "missing.md"))).toBe(false);
});

it("does not mistake legacy platform documents inside the project for the project original", () => {
  const legacy = join(root, ".devflow", "documents", wid, "r1", "plan.md");
  mkdirSync(join(legacy, ".."), { recursive: true }); writeFileSync(legacy, "legacy");
  store.put("project_document", "old", wid, { id: "old", workflow_id: wid, document_type: "plan", revision: 1, path: legacy, content: "legacy" });
  expect(originalPlanPath(store, wid)).toBeUndefined();
  const doc = docs.publishDocument(wid, "plan", "# New original", 1);
  expect(doc.path).toBe(join(root, "docs", "plan", wid, "plan.md"));
  expect(readFileSync(legacy, "utf8")).toBe("legacy");
});

it("immutable material objects reject appended prose and pending legacy outbox never writes a cache back", () => {
  store.put("workspace", "ws", wid, { id: "ws", workflow_id: wid, repo_id: "main", root });
  const locator = resolveMaterialLocator({ store, workflowId: wid, kind: "plan", revision: 1, run_id: "first" });
  const published = publishProjectMaterialSafely({ store, locator, content: "# Original" });
  expect(published.writtenToDisk).toBe(true);
  expect(readProjectMaterialByLocator({ store, locator })).toMatchObject({ content: "# Original", exists: true });
  writeFileSync(join(root, published.material.path), "# Original\nProgress", "utf8");
  expect(readProjectMaterialByLocator({ store, locator })).toMatchObject({ exists: false, is_conflict: true });
  const cache = join(root, "cache.md"); writeFileSync(cache, "old cache");
  store.put("project_material", "pending", wid, { id: "pending", workflow_id: wid, kind: "plan", revision: 2,
    workspace_id: "ws", path: "must-not-write.md", source_hash: "stale", cache_path: cache, status: "pending" });
  expect(reconcileMaterialOutbox(store, wid)).toBe(0);
  expect(existsSync(join(root, "must-not-write.md"))).toBe(false);
});

it("authority materials carry only a current path and structural plan, not copied prose", () => {
  const doc = docs.publishDocument(wid, "plan", "# Current", 1);
  store.put("approval", `${wid}-1`, wid, { plan_hash: "contract-hash" });
  const authority = new PlanSelfCheckCoordinator(store).authorities(store.must<any>("workflow", wid))[0] as any;
  expect(authority.document_path).toBe(doc.path);
  expect(authority.plan.markdown).toBeUndefined();
  writeFileSync(doc.path!, "# Current\nProgress", "utf8");
  expect(new PlanSelfCheckCoordinator(store).authorities(store.must<any>("workflow", wid))).toEqual([authority]);
});
