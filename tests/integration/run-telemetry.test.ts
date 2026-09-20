import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { readableLogs } from "../../packages/presentation/src/activity.js";

it("the production planner-takeover runtime publishes native actions before process exit and retains them in HTTP detail", async () => {
  const s = await fixture();
  const cli = join(s.root, "telemetry-cli.mjs");
  writeFileSync(
    cli,
    `
    const emit = value => console.log(JSON.stringify(value));
    emit({type:'thread.started', thread_id:'isolated-telemetry-session'});
    emit({type:'item.started', item:{id:'tool-1',type:'command_execution',command:'node --version',cwd:process.cwd()}});
    setTimeout(() => {
      emit({type:'item.completed',item:{id:'tool-1',type:'command_execution',command:'node --version',exit_code:0}});
      emit({type:'item.completed',item:{id:'file-1',type:'file_change',changes:[{path:'src/example.ts'}]}});
      emit({type:'item.completed',item:{id:'message-1',type:'agent_message',text:'隔离进程正在整理结果'}});
    }, 1500);
    setTimeout(() => { emit({type:'error',message:'Please login to continue (unauthenticated)'}); process.exitCode=1; }, 3000);
  `,
  );
  const profile = {
    id: "telemetry-profile",
    revision: 1,
    adapterId: "codex",
    executableRef: process.execPath,
    modelSelection: "explicit",
    modelId: "fixture-model",
    options: { prefixArgs: [cli] },
  };
  s.store.put("execution_spec", "telemetry-spec", s.w.id, {
    id: "telemetry-spec",
    revision: 1,
    workflow_id: s.w.id,
    plannerProfile: profile,
    executorProfile: profile,
    created_at: new Date().toISOString(),
  });
  authorizePlannerTakeover(s);
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  try {
    await s.engine.dispatch();
    await expect
      .poll(
        () =>
          readableLogs(s.store.events(s.w.id, 0, 1000), s.w.id).find(
            (r) => r.command === "node --version",
          )?.status,
        { timeout: 15000 },
      )
      .toBe("active");
    expect(s.engine.get(s.w.id).state).toBe("EXECUTING");
    expect(s.engine.summary(s.w.id).runtime).toMatchObject({
      adapter: "codex",
      purpose: "planner_takeover",
      requested_model: "fixture-model",
      status: "working",
    });
    expect(s.engine.summary(s.w.id).runtime?.actual_model).toBeUndefined();
    await expect
      .poll(() => s.engine.get(s.w.id).state, { timeout: 15000 })
      .toBe("BLOCKED");
    const detail = s.engine.detail(s.w.id, false);
    const logs = readableLogs(detail.events, s.w.id);
    expect(logs.find((r) => r.command === "node --version")?.status).toBe(
      "done",
    );
    expect(logs.find((r) => r.text === "src/example.ts")?.title).toBe(
      "修改文件",
    );
    expect(logs.some((r) => r.text === "隔离进程正在整理结果")).toBe(true);
    expect(detail.runtime).toMatchObject({ status: "error", active_tools: 0 });
  } finally {
    await runtime.close();
    await cleanup(s);
  }
});

function authorizePlannerTakeover(s: Awaited<ReturnType<typeof fixture>>) {
  const w = s.engine.get(s.w.id);
  const phase = "before_human" as const;
  const reviewIds = ["review-a", "review-b", "review-c"];
  s.store.put("quality_gate", s.engine.quality.getGateKey(w.id, phase), w.id, {
    workflow_id: w.id,
    phase,
    cycle: 1,
    executor_rejections: 3,
    failed_repair_review_ids: reviewIds,
    current_review_id: reviewIds[2],
    takeover: true,
    status: "rejected",
    updated_at: new Date().toISOString(),
  });
  reviewIds.forEach((id, index) => {
    s.store.put("quality_review", id, w.id, {
      workflow_id: w.id,
      phase,
      verdict: "changes_required",
      executor_repair_run_id: "repair-" + index,
    });
  });
  s.store.put("repair_assignment", w.id, w.id, {
    planner: true,
    phase,
    source: "quality_review",
    source_review_id: reviewIds[2],
    plan_revision: w.plan_revision,
    plan_hash: w.plan_hash,
  });
}
