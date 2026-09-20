import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import {
  attachmentArchiveKey,
  createArchiveJobFromManifest,
  drainArchiveOutbox,
  listAttachmentRecords,
} from "../../packages/evidence/src/archive-consumer.js";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "devflow-archive-refresh-"));
  const store = new Store(join(root, "state", "devflow.sqlite"));
  stores.push(store);
  return { root, store };
}

it("archives from the owning workflow even when another task has the same repository id", async () => {
  const { root, store } = fixture();
  const workspaces = ["other", "owner"].map((workflow) => {
    const workspaceRoot = join(root, workflow);
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, "report.json"), workflow);
    const ws = { id: "ws-" + workflow, workflow_id: workflow, repo_id: "main", root: workspaceRoot };
    store.put("workspace", ws.id, workflow, ws);
    return ws as any;
  });
  const workflow = { id: "owner", project_id: "p", state: "HUMAN_PENDING" };
  store.put("workflow", workflow.id, "p", workflow);
  createArchiveJobFromManifest(store, {
    deliveryId: "del-owner", workflowId: "owner", runId: "run-owner",
    manifest: { artifacts: ["report.json", { repo_id: "unknown", path: "report.json" }, "missing.json"] } as any,
  });
  await drainArchiveOutbox(store, { storageRoot: join(root, "state"), workspaces });
  const records = listAttachmentRecords(store, "owner", "del-owner");
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ repo_id: "main", path: "report.json", state: "archived" }),
    expect.objectContaining({ repo_id: "unknown", path: "report.json", state: "skipped" }),
    expect.objectContaining({ repo_id: "main", path: "missing.json", state: "missing" }),
  ]));
  const reportDir = join(root, "state", "deliveries", "del-owner", "reports");
  expect(readdirSync(reportDir)).toHaveLength(1);
  expect(readFileSync(join(reportDir, readdirSync(reportDir)[0]!), "utf8")).toBe("owner");
  expect(store.get("workflow", "owner")).toEqual(workflow);
  const events = store.events("owner").filter((event) => event.type === "AttachmentArchiveUpdated");
  expect(events.map((event) => (event.payload as any).state).sort()).toEqual(["archived", "missing", "skipped"]);
  expect(events.every((event) => event.run_id === "run-owner" && event.project_id === "p")).toBe(true);
  expect(store.events("other")).toEqual([]);
  await drainArchiveOutbox(store, { storageRoot: join(root, "state"), workspaces });
  expect(store.events("owner")).toEqual(events);
});

it("skips malformed historical records and publishes a later successful archive without replacing the delivery", async () => {
  const { root, store } = fixture();
  const ws = { id: "ws", workflow_id: "wf", repo_id: "main", root };
  store.put("workspace", ws.id, "wf", ws);
  store.put("workflow", "wf", "p", { id: "wf", project_id: "p", state: "HUMAN_PENDING" });
  const delivery = {
    id: "del", workflow_id: "wf", run_id: "run",
    attachment_status: [{ delivery_id: "del", repo_id: "main", path: {}, state: "pending" }, null],
    manifest: { artifacts: [{ path: {} }, { path: "later.json" }] },
  };
  store.put("delivery", "del", "wf", delivery);
  store.put("attachment_archive", "malformed-key", "wf", { delivery_id: "del", repo_id: "main", path: {}, state: "pending" });
  createArchiveJobFromManifest(store, { deliveryId: "del", workflowId: "wf", runId: "run", manifest: delivery.manifest as any });
  await drainArchiveOutbox(store, { storageRoot: join(root, "state") });
  expect(listAttachmentRecords(store, "wf", "del")).toEqual([
    expect.objectContaining({ path: "later.json", state: "missing" }),
  ]);
  writeFileSync(join(root, "later.json"), "available");
  await drainArchiveOutbox(store, { storageRoot: join(root, "state") });
  expect(store.get<any>("attachment_archive", attachmentArchiveKey("del", "main", "later.json"))?.state).toBe("archived");
  expect(store.events("wf").map((event) => (event.payload as any).state)).toEqual(["missing", "archived"]);
  expect(store.get("delivery", "del")).toEqual(delivery);
});
