import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixture,
  cleanup,
  seedPlannerTakeover,
} from "../fixtures/native-flow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { readableLogs } from "../../packages/presentation/src/activity.js";
import { RunModelBindingSchema, type Run } from "../../packages/contracts/src/index.js";

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
  seedPlannerTakeover(s);
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
    const activeRun = s.store.get<Run>("run", s.engine.get(s.w.id).run_id!)!;
    expect(activeRun.protocol).toBe("lightweight");
    expect(activeRun.execution_spec_revision).toBe(1);
    expect(activeRun.model_binding?.effective_invocation).toMatchObject({
      adapterId: "codex",
      executable: process.execPath,
      modelId: "fixture-model",
    });
    expect(activeRun.frozen_invocation).toMatchObject({
      adapterId: "codex",
      executable: process.execPath,
      modelToken: "fixture-model",
    });
    const frozen = activeRun.frozen_invocation!;
    expect(RunModelBindingSchema.parse(activeRun.model_binding)).toEqual({
      routing_role: activeRun.routing_role,
      routing_source: activeRun.routing_source,
      execution_spec_revision: activeRun.execution_spec_revision,
      logical_round_id: activeRun.logical_round_id,
      ...(activeRun.repair_batch_id ? { repair_batch_id: activeRun.repair_batch_id } : {}),
      ...(activeRun.assignment_id ? { assignment_id: activeRun.assignment_id } : {}),
      effective_invocation: {
        adapterId: frozen.adapterId,
        executable: frozen.executable,
        modelId: frozen.modelToken,
        reasoning: frozen.reasoning,
        ...(frozen.nativeConfigProfile ? { nativeConfigProfile: frozen.nativeConfigProfile } : {}),
        providerScope: frozen.providerScope,
        accountScope: frozen.accountScope,
        capabilityRevision: frozen.capabilityRevision,
        runtimeFlavor: frozen.runtimeFlavor,
      },
      frozen_invocation: frozen,
      invocation_fingerprint: activeRun.invocation_fingerprint,
    });
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
