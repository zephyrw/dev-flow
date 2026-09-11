import { it, expect } from "vitest";
import { setup, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
it("UT-03 transaction rollback removes events and idempotency prevents duplicate transitions", () => {
  const { store } = setup();
  expect(() =>
    store.transaction(() => {
      store.put("x", "x", "x", { a: 1 });
      store.event("wf", "p", "Created", {});
      throw Error("failure");
    }),
  ).toThrow();
  expect(store.get("x", "x")).toBeUndefined();
  expect(store.events("wf")).toEqual([]);
  let calls = 0;
  expect(store.deduplicate("key", { a: 1 }, () => ++calls)).toBe(1);
  expect(store.deduplicate("key", { a: 1 }, () => ++calls)).toBe(1);
  expect(() => store.deduplicate("key", { a: 2 }, () => ++calls)).toThrow();
  store.close();
});
it("UT-04 human proofs cannot approve a different plan revision", () => {
  const { engine, store } = setup();
  const p = project(".");
  store.put("project", p.id, p.id, p);
  const w = engine.create(
    {
      project_id: p.id,
      title: "t",
      request: "r",
      complexity: "simple",
      workspace_mode: "new_worktree",
    },
    "key",
  );
  engine.submitPlan(w.id, plan(objectHash(p), "a".repeat(40)), w.version, "p1");
  const a = proof(engine, w.id, "approve");
  engine.submitPlan(
    w.id,
    plan(objectHash(p), "a".repeat(40)),
    engine.get(w.id).version,
    "p2",
  );
  expect(() => engine.approve(w.id, a.proof, a.binding)).toThrow(/变化/);
  expect(engine.get(w.id).state).toBe("REPAIR_PLAN_PENDING");
  store.close();
});
it("UT-05 revoked and foreign worker credentials are rejected", () => {
  const { engine, store } = setup();
  const token = engine.auth.issue({
    role: "worker",
    workflow_id: "w1",
    run_id: "r1",
  });
  expect(() => engine.auth.verify(token, "worker", "w2")).toThrow();
  engine.auth.revokeRun("r1");
  expect(() => engine.auth.verify(token)).toThrow();
  store.close();
});
it("UT-08 resource acquisition is atomic, fenced and cannot steal expired leases", () => {
  const { engine, store } = setup();
  const a = engine.scheduler.acquire("w1", "r1", ["b", "a"])!;
  expect(a.map((l) => l.id)).toEqual(["a", "b"]);
  expect(engine.scheduler.acquire("w2", "r2", ["a", "c"])).toBeNull();
  expect(store.get("lease", "c")).toBeUndefined();
  engine.scheduler.suspectExpired(-1);
  expect(engine.scheduler.acquire("w2", "r2", ["a"])).toBeNull();
  expect(() => engine.scheduler.release("w1", "r1", ["a"], false)).toThrow();
  engine.scheduler.release("w1", "r1", ["a"], true);
  expect(engine.scheduler.acquire("w2", "r2", ["a"])![0]!.fence).toBe(2);
  store.close();
});
it("UT-08 scheduler rotates projects and retains per-project order", () => {
  const { engine, store } = setup();
  engine.scheduler.enqueue("a", "p1");
  engine.scheduler.enqueue("b", "p1");
  engine.scheduler.enqueue("c", "p2");
  expect(engine.scheduler.next("p1")?.id).toBe("c");
  store.close();
});
it("UT-18 restart revokes live runs without marking stale leases free", () => {
  const { engine, store } = setup();
  const p = project(".");
  store.put("project", p.id, p.id, p);
  const w = engine.create(
    {
      project_id: p.id,
      title: "t",
      request: "r",
      complexity: "simple",
      workspace_mode: "new_worktree",
    },
    "key",
  );
  engine.transition(w.id, ["RESEARCHING"], "EXECUTING", "execute", {
    run_id: "r1",
  });
  const token = engine.auth.issue({
    role: "worker",
    workflow_id: w.id,
    run_id: "r1",
  });
  engine.scheduler.acquire(w.id, "r1", ["executor:0"]);
  engine.recover();
  expect(engine.get(w.id).state).toBe("RECOVERY_REQUIRED");
  expect(() => engine.auth.verify(token)).toThrow();
  expect(store.get("lease", "executor:0")).toBeTruthy();
  store.close();
});
