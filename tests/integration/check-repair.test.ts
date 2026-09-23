import { it, expect } from "vitest";
import { resolve } from "node:path";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { hash, objectHash } from "../../packages/core/src/util.js";
it("IT-10 failed real test reopens scoped repair and invalidates all old evidence before retest", async () => {
  const s = setup(),
    r = await repository(s.root),
    p = project(r.repo);
  p.commands[0]!.args = [
    "--test-reporter=junit",
    "--test-reporter-destination=${DEVFLOW_REPORT_PATH}",
    "-e",
    "require('node:test')('updates content',()=>require('node:assert/strict').equal(require('node:fs').readFileSync('app.txt','utf8'),'after\\n'))",
  ];
  p.commands[0]!.parser = "junit";
  await s.engine.registerProject(p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "真实失败后修复",
      request: "验证测试失效与重新冻结",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "repair-check",
  );
  const contract = plan(objectHash(p), r.baseline);
  contract.tests[0]!.expected_case_ids = ["test updates content"];
  s.engine.submitPlan(w.id, contract, w.version, "p1");
  const a = proof(s.engine, w.id, "approve");
  s.engine.approve(w.id, a.proof, a.binding);
  await s.engine.git.prepare(p, w.id, "existing_workspace", {
    main: r.baseline,
  });
  s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
    run_id: "repair-run",
  });
  const principal = {
    role: "worker" as const,
    workflow_id: w.id,
    run_id: "repair-run",
    expires: Date.now() + 120000,
  };
  const runtime = new LocalRuntime(s.engine);
  try {
    s.engine.claimTask(
      principal,
      w.id,
      "T01",
      "先记录失败行为并验证真实回归测试能捕获错误",
    );
    await s.engine.freeze(w.id, principal);
    const failed = await runtime.check(s.engine.get(w.id), "UT01", principal);
    expect(failed.status).toBe("failed");
    expect(s.engine.get(w.id).state).toBe("EXECUTING");
    expect(s.engine.get(w.id).snapshot_id).toBeUndefined();
    const f = s.engine.files(principal, w.id, "main", true);
    f.broker.apply(f.root, contract.scope, [
      { path: "app.txt", expected_hash: hash("before\n"), content: "after\n" },
    ]);
    s.engine.claimTask(
      principal,
      w.id,
      "T01",
      "已实施正确局部修复并准备全量重新测试",
    );
    await s.engine.freeze(w.id, principal);
    expect(
      (await runtime.check(s.engine.get(w.id), "UT01", principal)).status,
    ).toBe("passed");
    expect(s.store.must<any>("evidence", failed.id).status).toBe("stale");
    expect((await s.engine.finish(w.id, principal)).status).toBe("ready");
  } finally {
    await runtime.close();
    s.store.close();
  }
}, 60000);
