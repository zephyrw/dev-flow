import { it, expect } from "vitest";
import { writeFileSync, readFileSync, linkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { prepared, proof } from "../helpers.js";
import { hash, now } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";

it("IT-12 repair plan requires new approval and cannot reuse evidence even when source snapshot is identical", async () => {
  const s = await prepared();
  const key = s.workflow.id;
  try {
    writeFileSync(join(s.repo, "app.txt"), "after\n");
    s.engine.claimTask(
      s.principal,
      key,
      "T01",
      "测试夹具已修改内容并记录当前实现声明",
    );
    const snapshot = await s.engine.freeze(key, s.principal);
    const file = join(s.root, "explicit-fixture-evidence.json");
    writeFileSync(file, JSON.stringify({ fixture: true }));
    s.store.put("evidence", "old-evidence", key, {
      id: "old-evidence",
      workflow_id: key,
      run_id: "run-test",
      snapshot_id: snapshot.id,
      environment_revision: 0,
      test_id: "UT01",
      layer: "unit",
      status: "passed",
      case_ids: ["updates content"],
      passed: 1,
      failed: 0,
      skipped: 0,
      discovered: 1,
      exit_code: 0,
      files: [{ path: file, hash: hash(readFileSync(file)) }],
      created_at: now(),
    });
    s.engine.transition(key, ["VERIFYING"], "HUMAN_PENDING", "accept");
    const acceptance = proof(s.engine, key, "accept");
    await s.engine.accept(key, acceptance.proof, acceptance.binding);
    s.engine.transition(key, ["REVIEW_QUEUED"], "REVIEWING", "review", {
      review_request_id: "repair-review",
    });
    const oldToken = s.engine.auth.issue({
      role: "worker",
      workflow_id: key,
      run_id: "run-test",
    });
    const oldApproval = proof(s.engine, key, "approve");
    const repair = structuredClone(s.engine.plan(key).plan);
    repair.markdown +=
      "\n修复计划：重新核实原测试断言，保持现有代码和批准范围。\n";
    await s.engine.receiveReview(key, {
      schema_version: 1,
      review_request_id: "repair-review",
      workflow_id: key,
      plan_revision: 1,
      snapshot_id: snapshot.id,
      verdict: "changes_required",
      findings: [
        {
          id: "F1",
          title: "需要修复",
          disposition: "confirmed",
          relation_to_change: "in_scope",
          evidence: "夹具",
          impact: "行为偏差",
          cause: "实现遗漏",
        },
      ],
      unresolved_questions: [],
      repair_plan: repair,
      commit_message: "fix: 修复验证证据",
    });
    expect(s.engine.get(key).state).toBe("REPAIR_PLAN_PENDING");
    expect(s.engine.get(key).plan_revision).toBe(2);
    expect(await git(s.repo, ["rev-parse", "HEAD"])).toBe(s.baseline);
    expect(s.store.get("acceptance", key)).toBeUndefined();
    expect(s.store.must<any>("review", "repair-review").stale).toBe(true);
    expect(s.store.must<any>("evidence", "old-evidence").status).toBe("stale");
    expect(() => s.engine.auth.verify(oldToken)).toThrow();
    expect(() =>
      s.engine.approve(key, oldApproval.proof, oldApproval.binding),
    ).toThrow();
    const approval = proof(s.engine, key, "approve");
    s.engine.approve(key, approval.proof, approval.binding);
    s.engine.transition(key, ["QUEUED"], "EXECUTING", "execute", {
      run_id: "run-repair",
    });
    const worker = { ...s.principal, run_id: "run-repair" };
    s.engine.claimTask(
      worker,
      key,
      "T01",
      "重新核实当前代码，必须重新运行本轮批准的测试",
    );
    const refrozen = await s.engine.freeze(key, worker);
    expect(refrozen.id).toBe(snapshot.id);
    expect(s.engine.taskStatus(key)[0]?.status).toBe("claimed");
  } finally {
    s.store.close();
  }
}, 120000);

it("IT-04 approved filename cannot write through a hardlink into another directory", async () => {
  const s = await prepared();
  try {
    const outside = join(s.root, "outside.txt");
    writeFileSync(outside, "private");
    unlinkSync(join(s.repo, "app.txt"));
    linkSync(outside, join(s.repo, "app.txt"));
    const files = s.engine.files(s.principal, s.workflow.id, "main", true);
    expect(() =>
      files.broker.apply(files.root, s.engine.plan(s.workflow.id).plan.scope, [
        { path: "app.txt", expected_hash: hash("private"), content: "changed" },
      ]),
    ).toThrow(/链接/);
    expect(readFileSync(outside, "utf8")).toBe("private");
  } finally {
    s.store.close();
  }
}, 120000);
