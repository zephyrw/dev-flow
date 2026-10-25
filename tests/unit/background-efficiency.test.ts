import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { Scheduler } from "../../packages/scheduler/src/scheduler.js";
import { WorkspaceObserver } from "../../packages/runtime/src/workspace-observer.js";
import { setup, project, plan } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

it("invalidates cached views after another database connection commits", () => {
  const s = setup(); cleanups.push(() => s.store.close());
  const writer = new Store(s.store.file); cleanups.push(() => writer.close());
  const before = s.store.revision("workflow-a");
  writer.put("run", "external", "workflow-a", { status: "completed" });
  expect(s.store.revision("workflow-a")).not.toBe(before);
  expect(s.store.get("run", "external")).toEqual({ status: "completed" });
});

it("invalidates only committed owners and reports a transaction after all rows become visible", () => {
  const store = new Store(":memory:"); cleanups.push(() => store.close());
  const a = store.revision("a"), b = store.revision("b"), seen: unknown[] = [];
  store.on("change", () => seen.push(store.get("run", "second")));
  store.transaction(() => {
    store.put("run", "first", "a", { value: 1 });
    store.put("run", "second", "a", { value: 2 });
    expect(seen).toEqual([]);
  });
  expect(seen).toEqual([{ value: 2 }, { value: 2 }]);
  expect(store.revision("a")).not.toBe(a); expect(store.revision("b")).toBe(b);
  const committed = store.revision("a"); seen.length = 0;
  expect(() => store.transaction(() => { store.put("run", "second", "a", { value: 3 }); throw new Error("rollback"); })).toThrow("rollback");
  expect(store.revision("a")).toBe(committed); expect(seen).toEqual([]);
  expect(store.get("run", "second")).toEqual({ value: 2 });
});

it("reads bounded owner history in stable descending pages", () => {
  const store = new Store(":memory:"); cleanups.push(() => store.close());
  for (let i = 0; i < 150; i++) store.put("operation", String(i), "a", { id: i, created_at: "2026-10-25" });
  store.put("operation", "foreign", "b", { id: 999, created_at: "2027" });
  expect(store.listRecent<{ id: number }>("operation", "a", "created_at", 3).map(x => x.id)).toEqual([149, 148, 147]);
  expect(store.listRecent<{ id: number }>("operation", "a", "created_at", 3, 3).map(x => x.id)).toEqual([146, 145, 144]);
});

it("reuses a queue snapshot while retaining project fairness, priority aging and fresh lease exclusion", () => {
  const store = new Store(":memory:"); cleanups.push(() => store.close()); const scheduler = new Scheduler(store);
  store.put("queue", "old", "a", { id: "old", project: "a", priority: 0, created_at: "2020-01-01" });
  scheduler.enqueue("high", "a", 20); scheduler.enqueue("other", "b", 0);
  const entries = scheduler.candidates();
  expect(scheduler.next(undefined, 10, undefined, entries)?.id).toBe("old");
  expect(scheduler.next("a", 10, new Set(["old"]), entries)?.id).toBe("other");
  expect(scheduler.next("b", 10, new Set(["old", "other"]), entries)?.id).toBe("high");
  expect(scheduler.acquire("first", "run", ["write:shared"])).toHaveLength(1);
  expect(scheduler.acquire("second", "run2", ["read:shared::main", "write:shared"])).toBeNull();
  expect(store.list("lease")).toHaveLength(1);
  scheduler.release("first", "run", ["write:shared"], true);
  expect(scheduler.acquire("second", "run2", ["write:shared"])).toHaveLength(1);
});

it("shares a workspace watcher until its last task completes and can attach it again", async () => {
  const s = setup(); cleanups.push(() => s.store.close());
  const p = project(s.root); s.store.put("project", p.id, "global", p);
  const workflows = ["first", "second"].map(key => {
    const w = s.engine.create({ project_id: p.id, title: key, request: "watch workspace", complexity: "simple", workspace_mode: "existing_workspace" }, key);
    s.engine.submitPlan(w.id, plan(objectHash(p), "a".repeat(40)), w.version, "plan");
    s.store.put("workspace", key, w.id, { id: key, workflow_id: w.id, repo_id: "main", root: s.root }); return w.id;
  });
  const observer = new WorkspaceObserver(s.engine); cleanups.push(() => observer.close());
  // Native handle count is intentionally inspected to catch leaked duplicate subscriptions.
  const watches = (observer as any).watches as Map<string, { watcher: { close(): void }; workspaces: unknown[] }>;
  expect(watches.size).toBe(1); expect([...watches.values()][0]!.workspaces).toHaveLength(2);
  const closing = vi.spyOn([...watches.values()][0]!.watcher, "close");
  for (const id of workflows) {
    s.store.put("workflow", id, p.id, { ...s.engine.get(id), state: "COMMITTED" });
    s.store.event(id, p.id, "StateChanged", { to: "COMMITTED" });
    if (id === workflows[0]) expect(closing).not.toHaveBeenCalled();
  }
  expect(closing).toHaveBeenCalledOnce(); expect(watches.size).toBe(0);
  const id = workflows[0]!;
  s.store.put("workflow", id, p.id, { ...s.engine.get(id), state: "EXECUTING" });
  s.store.event(id, p.id, "StateChanged", { to: "EXECUTING" });
  expect(watches.size).toBe(1);
});
