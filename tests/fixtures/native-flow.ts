import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { attestFixture } from "../native-fixture.js";
import { objectHash } from "../../packages/core/src/util.js";
import { NativeRunRecordReader } from "../../packages/evidence/src/native-run-records.js";
import {
  DeliveryManifestSchema,
  FlowError,
  type Run,
  type Workflow,
  type DeliveryRevision,
} from "../../packages/contracts/src/index.js";
import { PLAN_SELF_CHECK_STAGE } from "../../packages/core/src/plan-self-check.js";
import type { Runtime } from "../../packages/core/src/engine.js";

export async function fixture(
  configure?: (p: ReturnType<typeof project>) => void,
) {
  const s = setup(),
    ri = await repository(s.root),
    p = project(ri.repo);
  p.commands[0]!.args = [".reports/check.cjs"];
  configure?.(p);
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "需求-" + crypto.randomUUID(),
      request: "修改文本后复核",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "create",
  );
  s.engine.submitPlan(
    w.id,
    {
      ...plan(objectHash(p), ri.baseline),
      task_model: "native-v2",
      modules: [{ id: "M01", title: "Text" }],
    },
    w.version,
    "plan",
  );
  const approval = proof(s.engine, w.id, "approve");
  s.engine.approve(w.id, approval.proof, approval.binding);
  mkdirSync(join(ri.repo, ".reports"), { recursive: true });
  writeFileSync(
    join(ri.repo, ".reports/check.cjs"),
    `const fs=require("node:fs");require("node:assert/strict").equal(fs.readFileSync("app.txt","utf8"),"after\\n");fs.writeFileSync(".reports/unit.json",JSON.stringify({testResults:[{assertionResults:[{title:"updates content",status:"passed"}]}]}));`,
  );
  const stages: string[] = [];
  const result = { ...s, ...ri, p, w, stages };
  return result;
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export function report(s: Fixture, run: Run) {
  const request = s.engine.planSelfCheck.current(s.w.id)!;
  return {
    request_id: request.id,
    source_delivery_revision_id: request.source_delivery_revision_id,
    plan_revision: request.plan_revision,
    plan_hash: request.plan_hash,
    authority_hash: request.authority_hash,
    run_id: run.id,
    verdict: "passed" as const,
    checks: request.check_ids.map((check_id) => ({
      check_id,
      status: "passed" as const,
      evidence: [
        "main:app.txt 内容为 after；.reports/unit.json / updates content",
      ],
    })),
    findings: [],
  };
}
export async function deliver(
  s: Fixture,
  run: Run,
  edit?: (manifest: any) => void,
) {
  // Real child-process test and raw report; host receipt is explicitly supplied by the isolated fixture.
  execFileSync(process.execPath, [".reports/check.cjs"], { cwd: s.repo });
  s.store.put("run", run.id, s.w.id, {
    ...s.store.must<Run>("run", run.id),
    exit_code: 0,
  });
  const fact = {
    tool_call_id: "call-" + run.id,
    command: `"${process.execPath}" .reports/check.cjs`,
    cwd: s.repo,
    exit_code: 0,
  };
  const manifest = DeliveryManifestSchema.parse({
    implementations: [{ task_id: "T01", repo_id: "main", path: "app.txt" }],
    test_executions: [
      {
        ...fact,
        repo_id: "main",
        format: "vitest_json",
        report_paths: [".reports/unit.json"],
      },
    ],
    acceptance_mappings: [
      {
        requirement_id: "UT01",
        scene_id: "updates content",
        test_execution_id: fact.tool_call_id,
        report_path: ".reports/unit.json",
        case_id: "updates content",
      },
    ],
    ...(run.stage === PLAN_SELF_CHECK_STAGE
      ? { plan_self_check: report(s, run) }
      : {}),
  });
  const reader = attestFixture(
    s.engine,
    s.w.id,
    manifest,
    new NativeRunRecordReader([fact]),
    false,
  );
  manifest.submission_id = "submission-" + run.id + "-" + crypto.randomUUID();
  for (const f of reader.getAllFacts())
    s.store.put("native_execution", f.tool_call_id, run.id, f);
  edit?.(manifest);
  return s.engine.deliver(s.w.id, manifest);
}
export function passReview(w: Workflow) {
  return {
    schema_version: 1,
    review_request_id: w.review_request_id,
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    snapshot_id: w.snapshot_id,
    verdict: "pass",
    coverage: {
      all_changed_files_reviewed: true,
      all_requirements_checked: true,
      upstream_downstream_checked: true,
      security_checked: true,
      tests_validity_checked: true,
      files: ["main:app.txt"],
    },
    findings: [],
    unresolved_questions: [],
    repair_plan: null,
    commit_message: "fix: update fixture",
  };
}
export function runtime(
  s: Fixture,
  onCheck?: (run: Run) => Promise<void>,
): Runtime {
  return {
    async execute(w, run) {
      s.stages.push(run.stage);
      expect(s.engine.get(w.id).state).toBe("EXECUTING");
      if (run.stage === PLAN_SELF_CHECK_STAGE && onCheck) return onCheck(run);
      writeFileSync(join(s.repo, "app.txt"), "after\n");
      expect((await deliver(s, run)).status).toBe("accepted");
      expect(s.engine.get(w.id).state).toBe("VERIFYING");
      expect(() =>
        s.engine.quality.assertPassed(w.id, "before_human"),
      ).toThrow();
    },
    async review(w, run) {
      s.stages.push(run.stage);
      expect(s.engine.planSelfCheck.assertPassed(w).status).toBe("passed");
      return passReview(w);
    },
    async stop() {},
    async close() {},
    async check() {
      throw new Error("not used");
    },
  };
}
export async function until(s: Fixture, states: string[], timeout = 360000) {
  await s.engine.dispatch();
  await expect
    .poll(
      async () => {
        // Drive the same periodic dispatch as the production controller; queue wakeups can coalesce.
        await s.engine.dispatch();
        return s.engine.get(s.w.id).state;
      },
      { timeout, interval: 200 },
    )
    .toSatisfy((x) => states.includes(x));
  await s.engine.waitForIdle(s.w.id);
}
export async function cleanup(s: Fixture) {
  s.engine.runtime = undefined;
  if (
    ["EXECUTING", "VERIFYING", "REVIEWING", "QUEUED", "REVIEW_QUEUED"].includes(
      s.engine.get(s.w.id).state,
    )
  )
    await s.engine.stop(s.w.id);
  await s.engine.waitForIdle(s.w.id);
  s.store.close();
}
