import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, until, cleanup } from "../fixtures/native-flow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { workflowAttention } from "../../packages/core/src/attention.js";
import { FlowError } from "../../packages/contracts/src/index.js";
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
    "console.error('Please run agy login to continue (unauthenticated)');",
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
      revision: 1,
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
      expect(s.store.list("native_conversation", s.w.id)).toHaveLength(1);
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
