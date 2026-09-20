import { it, expect } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "../helpers.js";
import { RunTelemetry } from "../../packages/runtime/src/run-telemetry.js";
import { CodexSessionObserver } from "../../packages/runtime/src/codex-session-observer.js";
import { quotaBuckets } from "../../packages/runtime/src/native-activity.js";
import { storedNativeRecord } from "../../packages/runtime/src/stored-native-record.js";
import {
  readableLogs,
  mergeEvents,
} from "../../packages/presentation/src/activity.js";
import { visibleRunObservation } from "../../packages/presentation/src/run-observation.js";
import { currentRunObservation } from "../../packages/core/src/run-observation.js";
import { formatPathSummary } from "../../apps/web/src/execution-panel.js";
import type { Workflow, Run } from "../../packages/contracts/src/index.js";

function fixture(adapter: "codex" | "agy" = "codex") {
  const s = setup();
  const w = {
    id: "w",
    project_id: "p",
    run_id: "r",
    state: "EXECUTING",
  } as Workflow;
  const run = {
    id: "r",
    workflow_id: "w",
    adapter,
    purpose: "planner_takeover",
    status: "running",
    started_at: new Date().toISOString(),
    profile: {
      id: "profile",
      revision: 1,
      adapterId: adapter,
      modelSelection: "explicit",
      modelId: "requested-model",
      options: {},
    },
  } as Run;
  s.store.put("run", run.id, w.id, run);
  return { ...s, w, run, telemetry: new RunTelemetry(s.store, w, run) };
}

it("a corrupted legacy command output cannot hide later tools or keep a completed tool active", () => {
  const s = fixture();
  try {
    s.telemetry.accept({type:"item.started",item:{id:"item_1",type:"command_execution",command:"pnpm test"}});
    const raw = storedNativeRecord('{"type":"item.completed","item":{"id":"item_1","type":"command_execution","aggregated_output":"broken "redaction","exit_code":0,"status":"completed"}}');
    s.telemetry.accept(raw);
    s.telemetry.accept(storedNativeRecord('{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/next.ts"}]}}'));
    s.telemetry.flush();
    const logs=readableLogs(s.store.events("w",0,1000),"w");
    expect(logs[0]).toMatchObject({command:"pnpm test",status:"done"});
    expect(logs[1]?.text).toBe("src/next.ts");
    expect(s.telemetry.observation.active_tools).toBe(0);
    expect(storedNativeRecord('private reasoning')).toBeUndefined();
  } finally { s.telemetry.finish(); s.store.close(); }
});

it("streams distinct native tools and file rows, coalesces updates, replays independently and redacts secrets", () => {
  const s = fixture();
  try {
    s.telemetry.accept({ type: "thread.started", thread_id: "session" });
    s.telemetry.accept({
      type: "item.started",
      item: {
        id: "cmd1",
        type: "command_execution",
        command: "pnpm test\nnext",
        cwd: "C:/task",
      },
    });
    s.telemetry.flush();
    expect(
      s.store.get<any>("run_observation", "r").current_activity.command,
    ).toBe("pnpm test\nnext");
    for (let i = 0; i < 1000; i++)
      s.telemetry.accept({
        type: "item.updated",
        item: {
          id: "cmd1",
          type: "command_execution",
          command: "pnpm test\nnext",
        },
      });
    s.telemetry.accept({
      type: "item.completed",
      item: {
        id: "cmd1",
        type: "command_execution",
        exit_code: 2,
        aggregated_output:
          "Tests  1 failed | 2 passed\nprivate arbitrary output",
      },
    });
    s.telemetry.accept({
      type: "item.completed",
      item: {
        id: "files",
        type: "file_change",
        changes: [
          { path: "C:/very/long/" + "directory/".repeat(10) + "first.ts" },
          { path: "second.ts" },
        ],
      },
    });
    s.telemetry.accept({
      type: "item.completed",
      item: {
        id: "message",
        type: "agent_message",
        text: "api_key=secret-value 正在修复",
      },
    });
    s.telemetry.accept({
      type: "item.completed",
      item: { id: "reasoning", type: "reasoning", text: "private reasoning" },
    });
    s.telemetry.flush();
    const events = s.store.events("w", 0, 1000);
    const logs = readableLogs(mergeEvents("w", events, events), "w");
    expect(logs).toHaveLength(4);
    expect(logs[0]).toMatchObject({
      kind: "tool",
      command: "pnpm test\nnext",
      status: "error",
      resultText: "测试输出：2 项通过，1 项失败，0 项跳过。",
    });
    expect(logs[1]!.text).toContain("first.ts");
    expect(formatPathSummary(logs[1]!.text)).toMatch(/\.\.\..*first.ts$/);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("private arbitrary output");
    expect(s.store.get<any>("run_observation", "r").active_tools).toBe(0);
    // Loading only the final snapshot must retain its command and status.
    const lastCmd = events
      .filter(
        (e) => e.type === "NativeActivity" && (e.payload as any).id === "cmd1",
      )
      .at(-1)!;
    expect(readableLogs([lastCmd], "w")[0]?.command).toBe("pnpm test\nnext");
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("AGY reuses its existing timeline without duplicating tools or losing batched text deltas", () => {
  const s = fixture("agy");
  try {
    s.telemetry.accept({
      event: "init",
      init: { model: "actual-agy" },
      conversation_id: "a",
    });
    s.telemetry.accept({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "pnpm test" } },
      },
    });
    s.telemetry.accept({
      event: "step_update",
      step_update: {
        step_index: 1,
        step_type: "tool",
        state: "DONE",
        tool_info: { output: "Tests  3 passed" },
      },
    });
    for (const text_delta of ["中文", "进展"])
      s.telemetry.accept({
        event: "step_update",
        step_update: {
          step_index: 2,
          step_type: "agent_response",
          state: "DONE",
          text_delta,
        },
      });
    s.telemetry.finish();
    const logs = readableLogs(s.store.events("w", 0, 1000), "w");
    expect(logs.filter((r) => r.command === "pnpm test")).toHaveLength(1);
    expect(logs.find((r) => r.kind === "message")?.text).toBe("中文进展");
    expect(s.store.get<any>("run_observation", "r").actual_model).toBe(
      "actual-agy",
    );
    expect(logs.some((r) => r.title.includes("Gemini"))).toBe(false);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("quota preserves provider windows including zero remaining and never manufactures a missing window", () => {
  expect(
    quotaBuckets({
      rateLimitsByLimitId: {
        codex: {
          primary: {
            usedPercent: 100,
            windowDurationMins: 10080,
            resetsAt: 1900000000,
          },
          secondary: null,
        },
        other: { primary: { usedPercent: 0, windowDurationMins: 300 } },
      },
    }),
  ).toEqual([
    {
      id: "codex",
      label: undefined,
      windows: [
        { used_percent: 100, window_minutes: 10080, resets_at: 1900000000 },
      ],
    },
    {
      id: "other",
      label: undefined,
      windows: [{ used_percent: 0, window_minutes: 300, resets_at: undefined }],
    },
  ]);
  expect(
    quotaBuckets({ primary: { used_percent: null, window_minutes: 10080 } }),
  ).toEqual([]);
  expect(
    quotaBuckets({ primary: { used_percent: -1, window_minutes: 10080 } }),
  ).toEqual([]);
});

it("snapshots and live observations are scoped to the current run and ignore late previous-run events", () => {
  const s = fixture();
  try {
    s.telemetry.metadata({
      actual_model: "actual",
      effort: "xhigh",
      model_source: "native_session",
    });
    s.telemetry.quota(
      { primary: { used_percent: 73, window_minutes: 10080 } },
      new Date().toISOString(),
      "native_session",
    );
    s.telemetry.flush();
    const runtime = currentRunObservation(s.store, s.w);
    const events = s.store.events("w", 0, 1000);
    expect(
      visibleRunObservation({ workflow: s.w, runtime, events })?.actual_model,
    ).toBe("actual");
    const next = { ...s.w, run_id: "next" };
    expect(
      visibleRunObservation({ workflow: next, runtime, events }),
    ).toBeNull();
    expect(currentRunObservation(s.store, next)).toBeNull();
    s.telemetry.finish(true);
    s.telemetry.metadata({ actual_model: "late" });
    expect(currentRunObservation(s.store, s.w)?.actual_model).toBe("actual");
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it.each([true, false])(
  "session metadata and quota require matching session id, workspace and current run time (valid=%s)",
  async (valid) => {
    const s = fixture();
    const id = "019947a2-8a00-7000-8000-000000000001";
    const home = join(s.root, "codex");
    const date = new Date(s.run.started_at)
      .toISOString()
      .slice(0, 10)
      .split("-");
    const dir = join(home, "sessions", ...date);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "rollout-test-" + id + ".jsonl");
    const line = (
      type: string,
      payload: any,
      timestamp = new Date().toISOString(),
    ) => JSON.stringify({ type, timestamp, payload }) + "\n";
    writeFileSync(
      file,
      line("session_meta", { id, cwd: valid ? s.root : home }) +
        line("turn_context", { model: "old-model" }, "2000-01-01T00:00:00Z") +
        line("turn_context", { model: "actual-model", effort: "xhigh" }),
    );
    const observer = new CodexSessionObserver({
      home,
      cwd: s.root,
      startedAt: s.run.started_at,
      telemetry: s.telemetry,
    });
    try {
      observer.bind(id);
      await observer.poll();
      const quota = line("event_msg", {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 73, window_minutes: 10080 },
        },
      });
      appendFileSync(file, quota.slice(0, -4));
      await observer.poll();
      expect(s.telemetry.observation.quota).toBeUndefined();
      appendFileSync(file, quota.slice(-4));
      await observer.poll();
      s.telemetry.flush();
      const observation = currentRunObservation(s.store, s.w)!;
      expect(observation.actual_model).toBe(valid ? "actual-model" : undefined);
      expect(observation.quota?.buckets[0]?.windows[0]?.used_percent).toBe(
        valid ? 73 : undefined,
      );
      const count = s.store.eventCursor("w");
      await observer.poll();
      s.telemetry.flush();
      expect(s.store.eventCursor("w")).toBe(count);
    } finally {
      await observer.close();
      s.telemetry.finish();
      s.store.close();
    }
  },
);
