import { expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, plan, project } from "../helpers.js";
import { hash } from "../../packages/core/src/util.js";
import { buildServer } from "../../apps/api/src/server.js";

function fixture() {
  const s = setup();
  const w = {
    id: "wf-display",
    project_id: "p1",
    state: "REVIEWING",
    stage: "quality_before_human",
    plan_revision: 1,
    plan_hash: "plan-hash",
    snapshot_id: "snapshot",
    environment_revision: 0,
    version: 1,
    feedback: [],
  };
  const p = plan("a".repeat(64), "b".repeat(40));
  p.task_model = "native-v2";
  p.tests[0]!.expected_case_ids = ["scene-1", "scene-2"];
  s.store.put("project", "p1", "p1", project(s.root));
  s.store.put("workflow", w.id, w.id, w);
  s.store.put("plan", `${w.id}-1`, w.id, { id: `${w.id}-1`, plan: p });
  s.store.put("run", "run-execute", w.id, {
    id: "run-execute",
    status: "completed",
    exit_code: 0,
  });
  s.store.put("delivery_revision", "revision", w.id, {
    id: "revision",
    delivery_id: "delivery",
    run_id: "run-execute",
    plan_revision: 1,
    plan_hash: w.plan_hash,
    snapshot_id: w.snapshot_id,
    execution_finished: true,
  });
  const reports = join(
    s.config.storage_root,
    "deliveries",
    "delivery",
    "reports",
  );
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "test.json"), '{"passed":2}');
  s.store.put("delivery", "delivery", w.id, {
    id: "delivery",
    status: "passed",
    submitted_at: "2026-09-17T08:00:00Z",
    report_hashes: { "test.json": hash('{"passed":2}') },
    manifest: { implementations: [{ task_id: "T01", path: "app.txt" }] },
  });
  for (const n of [1, 2])
    s.store.put("acceptance_result", `result-${n}`, w.id, {
      id: `result-${n}`,
      delivery_id: "delivery",
      requirement_id: "UT01",
      scene_id: `scene-${n}`,
      case_id: `Runner suite case ${n}`,
      status: "passed",
    });
  return { ...s, w, p };
}

it("summary, detail and report downloads use native delivery results without changing review evidence or workflow", async () => {
  const s = fixture();
  const app = await buildServer(s.engine);
  const headers = { host: "localhost:14810" };
  try {
    expect(s.store.list("evidence", s.w.id)).toEqual([]);
    const before = s.engine.get(s.w.id);
    const summary = s.engine.summary(s.w.id);
    const detail = s.engine.detail(s.w.id, false);
    expect(summary.test_progress).toEqual(detail.test_progress);
    expect(detail.test_progress).toMatchObject({ total: 2, passed: 2 });
    expect(detail.test_progress.cases.map((c) => c.id)).toEqual([
      "scene-1",
      "scene-2",
    ]);
    expect(detail.human_accepted).toBe(false);
    expect(s.engine.getEvidence(s.w.id)[0]!.case_ids).toEqual([
      "Runner suite case 1",
      "Runner suite case 2",
    ]);
    const response = await app.inject({
      url: `/api/workflows/${s.w.id}/evidence/result-1/files/0`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"passed":2}');
    writeFileSync(
      join(s.config.storage_root, "deliveries/delivery/reports/test.json"),
      "changed",
    );
    expect(
      (
        await app.inject({
          url: `/api/workflows/${s.w.id}/evidence/result-1/files/0`,
          headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(s.engine.get(s.w.id)).toEqual(before);
    expect(s.store.list("evidence", s.w.id)).toEqual([]);
  } finally {
    await app.close();
    s.store.close();
  }
});

it("does not count invalidated or other-snapshot delivery results and only displays current human confirmation", () => {
  const s = fixture();
  try {
    s.store.put("acceptance", s.w.id, s.w.id, {
      snapshot_id: "snapshot",
      plan_revision: 1,
      environment_revision: 0,
    });
    expect(s.engine.summary(s.w.id).human_accepted).toBe(true);
    s.store.put("workflow", s.w.id, s.w.id, {
      ...s.w,
      snapshot_id: "new-snapshot",
    });
    expect(s.engine.summary(s.w.id)).toMatchObject({
      human_accepted: false,
      test_progress: { passed: 0 },
    });
    s.store.put("workflow", s.w.id, s.w.id, s.w);
    const rev = s.store.get<any>("delivery_revision", "revision");
    s.store.put("delivery_revision", "revision", s.w.id, {
      ...rev,
      invalidated: true,
    });
    expect(s.engine.detail(s.w.id, false).test_progress.passed).toBe(0);
  } finally {
    s.store.close();
  }
});

it("keeps legacy evidence and development progress working", () => {
  const s = fixture();
  try {
    s.p.task_model = "leaf-v1";
    s.p.tasks = [];
    s.store.put("plan", `${s.w.id}-1`, s.w.id, { plan: s.p });
    s.store.put("development_evidence", "legacy", s.w.id, {
      id: "legacy",
      test_id: "UT01",
      phase: "development",
      layer: "unit",
      status: "passed",
      snapshot_id: "development",
      plan_revision: 1,
      created_at: "2026-09-17T08:00:00Z",
      cases: [{ id: "scene-1", status: "passed" }],
      case_ids: ["scene-1"],
    });
    expect(s.engine.summary(s.w.id).test_progress.passed).toBe(1);
    expect(s.engine.detail(s.w.id, false).test_progress.passed).toBe(1);
  } finally {
    s.store.close();
  }
});
