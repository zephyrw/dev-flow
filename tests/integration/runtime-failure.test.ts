import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, runtime, until, cleanup } from "../fixtures/native-flow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { workflowAttention } from "../../packages/core/src/attention.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";
import { repairFailure } from "../../packages/core/src/repair.js";

const versionError =
  "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";

it.each([
  [
    "json",
    "CLI_VERSION_UNSUPPORTED",
    `console.log(JSON.stringify({type:'error',message:JSON.stringify({type:'error',status:400,error:{message:${JSON.stringify(versionError)}}})}));`,
  ],
  [
    "turn-failed",
    "CLI_VERSION_UNSUPPORTED",
    `console.log(JSON.stringify({type:'turn.failed',error:{message:${JSON.stringify(versionError)}}}));`,
  ],
  [
    "stderr",
    "MODEL_AUTH",
    "process.stderr.write('Please run agy '); setTimeout(() => console.error('login to continue (unauthenticated) token=fixture-secret'), 10);",
  ],
  [
    "unknown",
    "NATIVE_RUN_FAILED",
    "console.error('unexpected process exit 17');",
  ],
])(
  "production native runtime blocks %s once without consuming planner repairs",
  async (_mode, code, output) => {
    const s = await fixture();
    const cli = join(s.root, "failing-cli.mjs");
    writeFileSync(
      cli,
      `console.log(JSON.stringify({type:'thread.started',thread_id:'isolated-session'})); ${output} process.exitCode=1;`,
    );
    const profile = {
      id: "isolated-codex",
      revision: 1,
      adapterId: "codex",
      executableRef: process.execPath,
      modelSelection: "explicit",
      modelId: "fixture-model",
      options: { prefixArgs: [cli] },
    };
    s.store.put("execution_spec", "isolated-spec", s.w.id, {
      id: "isolated-spec",
      workflow_id: s.w.id,
      // Creation now persists revision 1; this fixture deliberately overrides it.
      revision: 2,
      plannerProfile: profile,
      executorProfile: profile,
      created_at: new Date().toISOString(),
    });
    s.store.put("repair_assignment", s.w.id, s.w.id, {
      planner: true,
      source: "execution_failure",
    });
    const prior = {
      plan_revision: 1,
      phase: "implementation",
      executor_failures: 3,
      planner_failures: 2,
      failed_runs: [
        { run_id: "prior-1", planner: true },
        { run_id: "prior-2", planner: true },
      ],
    };
    s.store.put("repair_state", s.w.id, s.w.id, prior);
    const runtime = new LocalRuntime(s.engine);
    s.engine.runtime = runtime;
    try {
      await until(s, ["BLOCKED"], 30000);
      const w = s.engine.get(s.w.id);
      expect(w.blocker?.code).toBe(code);
      expect(w.stage).toBe("blocked");
      expect(s.store.get("repair_state", s.w.id)).toEqual(prior);
      expect(s.store.list("run", s.w.id)).toHaveLength(1);
      expect(s.store.list("delivery", s.w.id)).toHaveLength(0);
      expect(s.store.get("conversation", s.w.id)).toMatchObject({
        id: "isolated-session",
      });
      expect(new Set(s.store.list<{ id: string }>("native_conversation", s.w.id).map(record => record.id)))
        .toEqual(new Set(["isolated-session"]));
      expect(
        s.store
          .events(s.w.id)
          .filter((e) =>
            /^(PlannerRepairScheduled|RepairScheduled)$/.test(e.type),
          ),
      ).toHaveLength(0);
      const attention = workflowAttention(s.engine, s.w.id) as any;
      expect(attention.resolution.code).toBe(code);
      expect(attention.runtime_context).toMatchObject({
        exit_code: 1,
        model: "fixture-model",
        executable: process.execPath,
      });
      expect(attention.runtime_context.diagnostic).toBeTruthy();
      expect(JSON.stringify(attention)).not.toContain("fixture-secret");
      // A later explicit resume retains the plan/workspace, but not a legacy
      // planner assignment which was based only on execution failures.
      const workspaces = s.store.list("workspace", s.w.id);
      s.engine.runtime = undefined;
      s.engine.feedback(s.w.id, "已处理环境问题，继续原任务", "within_plan");
      expect(s.engine.get(s.w.id)).toMatchObject({
        state: "QUEUED",
        plan_revision: 1,
        plan_hash: w.plan_hash,
      });
      expect(s.store.list("workspace", s.w.id)).toEqual(workspaces);
      expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
      expect(s.store.get("repair_state", s.w.id)).toEqual(prior);
      expect(s.store.get("conversation", s.w.id)).toMatchObject({
        id: "isolated-session",
      });
    } finally {
      await runtime.close();
      await cleanup(s);
    }
  },
);

it.each([
  "HOST_REQUIRED",
  "DISK_FULL",
  "MODEL_CONNECTION_FAILED",
  "NATIVE_PERMISSION_DENIED",
  "TIMEOUT",
  "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
])("%s does not create a repair counter", async (code) => {
  const s = await fixture();
  try {
    s.engine.transition(s.w.id, ["QUEUED"], "EXECUTING", "execute", {
      run_id: "isolated-run",
    });
    expect(
      await repairFailure(
        s.engine,
        s.w.id,
        new FlowError(code, "runtime unavailable"),
        "isolated-run",
      ),
    ).toBeNull();
    expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
    expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("verification environment failure blocks once and explicit recovery keeps the approved task", async () => {
  const s = await fixture();
  try {
    const approved = s.engine.get(s.w.id);
    const plan = s.engine.plan(s.w.id);
    const workspaces = s.store.list("workspace", s.w.id);
    const executionSpecs = s.store.list("execution_spec", s.w.id);
    s.engine.runtime = {
      ...runtime(s),
      async execute() {
        throw new FlowError(
          "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
          "本机无法完成模型连接核验，请恢复核验环境后继续",
        );
      },
    };

    await until(s, ["BLOCKED"]);
    // Periodic dispatch must not retry this infrastructure failure as code repair.
    for (let attempt = 0; attempt < 3; attempt++) {
      await s.engine.dispatch();
      await s.engine.waitForIdle(s.w.id);
    }
    expect(s.engine.get(s.w.id)).toMatchObject({
      state: "BLOCKED",
      stage: "blocked",
      blocker: { code: "VERIFICATION_ENVIRONMENT_UNAVAILABLE" },
      plan_revision: approved.plan_revision,
      plan_hash: approved.plan_hash,
    });
    const runs = s.store.list<Run>("run", s.w.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", purpose: "implement" });
    expect(runs[0]!.profile).toBeDefined();
    expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
    expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
    expect(s.store.events(s.w.id).filter((event) =>
      /^(PlannerRepairScheduled|RepairScheduled)$/.test(event.type),
    )).toHaveLength(0);
    expect(workflowAttention(s.engine, s.w.id)).toMatchObject({
      category: "error",
      resolution: { code: "VERIFICATION_ENVIRONMENT_UNAVAILABLE" },
    });

    s.engine.runtime = runtime(s);
    s.engine.feedback(s.w.id, "核验环境已恢复，按原计划继续", "within_plan");
    await until(s, ["HUMAN_PENDING", "BLOCKED"]);
    expect(s.engine.get(s.w.id)).toMatchObject({
      state: "HUMAN_PENDING",
      plan_revision: approved.plan_revision,
      plan_hash: approved.plan_hash,
    });
    expect(s.engine.get(s.w.id).blocker).toBeUndefined();
    expect(s.engine.plan(s.w.id)).toEqual(plan);
    expect(s.store.list("workspace", s.w.id)).toEqual(workspaces);
    expect(s.store.list("execution_spec", s.w.id)).toEqual(executionSpecs);
    const resumed = s.store.list<Run>("run", s.w.id)
      .find((run) => run.purpose === "implement" && run.id !== runs[0]!.id);
    expect(resumed).toMatchObject({
      status: "completed",
      profile: runs[0]!.profile,
      execution_spec_revision: runs[0]!.execution_spec_revision,
    });
    expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
    expect(s.store.get("repair_assignment", s.w.id)).toBeUndefined();
  } finally {
    await cleanup(s);
  }
});

it("a provider reset time still schedules automatic quota recovery without code repair", async () => {
  const s = await fixture();
  try {
    s.engine.block(
      s.w.id,
      new FlowError("NATIVE_RUN_FAILED", "quota exceeded; resets in 1m"),
    );
    expect(s.engine.get(s.w.id).blocker?.code).toBe("MODEL_QUOTA");
    expect(s.store.get<any>("model_retry", s.w.id)?.retry_at).toBeGreaterThan(
      Date.now() + 60000,
    );
    expect(s.store.get("repair_state", s.w.id)).toBeUndefined();
    expect(workflowAttention(s.engine, s.w.id)).toMatchObject({
      category: "queue",
    });
  } finally {
    await cleanup(s);
  }
});
