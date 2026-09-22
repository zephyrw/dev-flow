import { it, expect } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepared, proof } from "../helpers.js";
import { hash, now } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";

it("UT-16/17 independent commit gates reject missing approval, stale acceptance", async () => {
  const s = await prepared(),
    key = s.workflow.id;
  try {
    writeFileSync(join(s.repo, "app.txt"), "after\n");
    s.engine.claimTask(
      s.principal,
      key,
      "T01",
      "测试夹具实际修改并验证本轮声明",
    );
    const snapshot = await s.engine.freeze(key, s.principal);
    const file = join(s.root, "explicit-fixture.json");
    writeFileSync(file, JSON.stringify({ fixture: true }));
    const evidence = {
      id: "e1",
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
    };
    s.store.put("evidence", "e1", key, evidence);
    s.engine.transition(key, ["VERIFYING"], "HUMAN_PENDING", "accept");
    const p = proof(s.engine, key, "accept");
    await s.engine.accept(key, p.proof, p.binding);
    const workflow = s.engine.transition(
      key,
      ["REVIEW_QUEUED"],
      "REVIEWING",
      "review",
      { review_request_id: "gates" },
    );
    const acceptance = s.store.must<any>("acceptance", key),
      approval = s.store.must<any>("approval", key + "-1");
    const review = {
      schema_version: 1,
      review_request_id: "gates",
      workflow_id: key,
      plan_revision: 1,
      snapshot_id: snapshot.id,
      verdict: "pass",
      findings: [],
      unresolved_questions: [],
      repair_plan: null,
      commit_message: "fix: gate fixture",
      coverage: {
        all_changed_files_reviewed: true,
        all_requirements_checked: true,
        upstream_downstream_checked: true,
        security_checked: true,
        tests_validity_checked: true,
        files: ["main:app.txt"],
      },
    };
    const attempts = [
      {
        name: "missing approval",
        mutate: () => s.store.remove("approval", key + "-1"),
        input: review,
      },
      {
        name: "changed approval",
        mutate: () =>
          s.store.put("approval", key + "-1", key, {
            ...approval,
            plan_hash: "old",
          }),
        input: review,
      },
      {
        name: "missing acceptance",
        mutate: () => s.store.remove("acceptance", key),
        input: review,
      },
    ];
    for (const attempt of attempts) {
      s.store.put("workflow", key, s.project.id, workflow);
      s.store.put("approval", key + "-1", key, approval);
      s.store.put("acceptance", key, key, acceptance);
      s.store.put("evidence", "e1", key, evidence);
      s.store.put("project", s.project.id, s.project.id, s.project);
      attempt.mutate();
      await expect(
        s.engine.receiveReview(key, attempt.input),
        attempt.name,
      ).rejects.toThrow();
      expect(s.engine.get(key).state, attempt.name).toBe("REVIEWING");
    }
    await s.engine.receiveReview(key, {
      ...review,
      unresolved_questions: ["未核实调用链"],
    });
    expect(s.engine.get(key).state).toBe("WAITING_INPUT");
    s.store.put("workflow", key, s.project.id, workflow);
    await s.engine.receiveReview(key, {
      ...review,
      findings: [
        {
          id: "F1",
          severity: "P1",
          repo_id: "main",
          path: "app.txt",
          line: 1,
          trigger: "测试夹具条件",
          evidence: "明确测试证据",
          consequence: "功能错误",
          relation_to_change: "introduced",
          disposition: "confirmed",
          reason: "必须修复",
        },
      ],
    });
    expect(s.engine.get(key).state).toBe("REPAIR_RESEARCH_REQUIRED");
    expect(await git(s.repo, ["rev-parse", "HEAD"])).toBe(s.baseline);
  } finally {
    s.store.close();
  }
}, 120000);
