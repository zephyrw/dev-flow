import { it, expect } from "vitest";
import { prepared } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { FlowError } from "../../packages/contracts/src/index.js";

it("DF-STAGE-I01 policy rejects at shared deadline before token expiry", async () => {
  const s = await prepared();
  const now = Date.now();
  const run = {
    id: "run-test",
    workflow_id: s.workflow.id,
    plan_revision: s.workflow.plan_revision,
    adapter: "agy" as const,
    stage: "execute",
    status: "running",
    started_at: new Date(now).toISOString(),
    deadline_at: now + 60000,
    package_hash: "hash",
  };
  s.engine.store.put("run", run.id, s.workflow.id, run);

  const token = s.engine.auth.issue(
    { role: "worker", workflow_id: s.workflow.id, run_id: run.id },
    120000,
  );

  s.config.server.port = 14820;
  s.config.server.human_origin = "http://localhost:14820";
  const app = await buildServer(s.engine);
  await app.ready();
  try {
    const resBefore = await app.inject({
      method: "POST",
      url: "/api/worker/policy",
      headers: { host: "localhost:14820", authorization: `Bearer ${token}` },
      payload: { tool: "devflow_execute_context" },
    });
    expect(resBefore.statusCode).toBe(200);
    expect(resBefore.json().allowed).toBe(true);

    const originalNow = Date.now;
    try {
      Date.now = () => now + 60001;
      const resAfter = await app.inject({
        method: "POST",
        url: "/api/worker/policy",
        headers: { host: "localhost:14820", authorization: `Bearer ${token}` },
        payload: { tool: "devflow_execute_context" },
      });
      expect(resAfter.statusCode).toBe(403);
      expect(resAfter.json().error.code).toBe("TIMEOUT");
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await app.close();
    s.store.close();
  }
});

it("DF-STAGE-I02 process timeout and manual stop remain distinct", async () => {
  const pm = new ProcessManager("", false);

  const pTimeout = pm.start({
    id: "i02-timeout",
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 10000)"],
    cwd: process.cwd(),
    env: {},
    timeout_ms: 100,
  });
  const resTimeout = await pTimeout.completion;
  expect(resTimeout.termination_reason).toBe("timeout");

  const pManual = pm.start({
    id: "i02-manual",
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{}, 10000)"],
    cwd: process.cwd(),
    env: {},
    timeout_ms: 15000,
  });
  await new Promise((r) => setTimeout(r, 50));
  await pManual.stop();
  const resManual = await pManual.completion;
  expect(resManual.termination_reason).toBe("manual");
});

it("DF-STAGE-I03 resumed run rejects old worker", async () => {
  const s = await prepared();
  const oldRunId = s.principal.run_id!;
  const oldToken = s.engine.auth.issue(
    { role: "worker", workflow_id: s.workflow.id, run_id: oldRunId },
    60000,
  );

  s.engine.block(s.workflow.id, new FlowError("TIMEOUT", "轮次超时"));
  expect(s.engine.get(s.workflow.id).state).toBe("BLOCKED");

  expect(() => {
    const p = s.engine.auth.verify(oldToken, "worker", s.workflow.id);
    s.engine.worker(p, s.workflow.id);
  }).toThrowError(expect.objectContaining({ code: "RUN_REVOKED" }));

  const nextWorkflow = s.engine.feedback(
    s.workflow.id,
    "继续执行",
    "within_plan",
  );
  expect(nextWorkflow.state).toBe("QUEUED");

  const newRunId = "run-new-1";
  s.engine.transition(
    s.workflow.id,
    ["QUEUED"],
    "EXECUTING",
    "execute",
    { run_id: newRunId },
  );

  const newToken = s.engine.auth.issue(
    { role: "worker", workflow_id: s.workflow.id, run_id: newRunId },
    60000,
  );

  const newP = s.engine.auth.verify(newToken, "worker", s.workflow.id);
  const currentW = s.engine.worker(newP, s.workflow.id);
  expect(currentW.run_id).toBe(newRunId);

  expect(() => {
    const oldP = s.engine.auth.verify(oldToken, "worker", s.workflow.id);
    s.engine.worker(oldP, s.workflow.id);
  }).toThrowError(expect.objectContaining({ code: "RUN_REVOKED" }));
});
