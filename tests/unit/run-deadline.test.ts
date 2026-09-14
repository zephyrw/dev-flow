import { it, expect } from "vitest";
import { setup, project, repository, plan, proof, prepared } from "../helpers.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";

it("DF-STAGE-U02 one deadline includes preparation time", async () => {
  const s = await prepared();
  const runtime = new LocalRuntime(s.engine);
  const now = Date.now();
  const run = {
    id: "run-test",
    workflow_id: s.workflow.id,
    plan_revision: s.workflow.plan_revision,
    adapter: "agy" as const,
    stage: "execute",
    status: "running",
    started_at: new Date(now - 10000).toISOString(),
    deadline_at: now - 1000,
    package_hash: "hash",
  };
  s.engine.store.put("run", run.id, s.workflow.id, run);

  await expect(runtime.execute(s.workflow, run, "token")).rejects.toThrowError(
    expect.objectContaining({ code: "TIMEOUT" }),
  );
});

it("DF-STAGE-U03 credential grace never authorizes expired run", async () => {
  const s = await prepared();
  const now = Date.now();
  const run = {
    id: "run-test",
    workflow_id: s.workflow.id,
    plan_revision: s.workflow.plan_revision,
    adapter: "agy" as const,
    stage: "execute",
    status: "running",
    started_at: new Date(now - 5000).toISOString(),
    deadline_at: now + 500,
    package_hash: "hash",
  };
  s.engine.store.put("run", run.id, s.workflow.id, run);

  const principal = {
    role: "worker" as const,
    workflow_id: s.workflow.id,
    run_id: run.id,
    expires: now + 10000,
  };

  const w1 = s.engine.worker(principal, s.workflow.id);
  expect(w1.id).toBe(s.workflow.id);

  const originalNow = Date.now;
  try {
    Date.now = () => now + 1000;
    expect(() => s.engine.worker(principal, s.workflow.id)).toThrowError(
      expect.objectContaining({ code: "TIMEOUT" }),
    );
  } finally {
    Date.now = originalNow;
  }
});

it("DF-STAGE-U04 first termination reason wins", async () => {
  const pm = new ProcessManager("", false);

  const proc1 = pm.start({
    id: "proc-timeout",
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 10000)"],
    cwd: process.cwd(),
    env: {},
    timeout_ms: 50,
  });
  const res1 = await proc1.completion;
  expect(res1.termination_reason).toBe("timeout");
  await proc1.stop();
  expect(res1.termination_reason).toBe("timeout");

  const proc2 = pm.start({
    id: "proc-manual",
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 10000)"],
    cwd: process.cwd(),
    env: {},
    timeout_ms: 10000,
  });
  await new Promise((r) => setTimeout(r, 20));
  await proc2.stop();
  const res2 = await proc2.completion;
  expect(res2.termination_reason).toBe("manual");
});
