import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { BufferedEventSink } from "../../packages/core/src/buffered-sink.js";
import {
  NativeExecutionObserver,
  captureInputs,
  reportSourceKey,
} from "../../packages/evidence/src/native-execution-observer.js";
import {
  NativeRunRecordReader,
  type HostToolExecutionFact,
} from "../../packages/evidence/src/native-run-records.js";
import { matchesCommand } from "../../packages/evidence/src/command-match.js";
import { AgentTelemetry } from "../../packages/runtime/src/agent-telemetry.js";
import { Store } from "../../packages/store/src/store.js";
import { publicEvent } from "../../packages/core/src/util.js";
import type { Workspace } from "../../packages/contracts/src/index.js";
const tick = () => new Promise<void>((r) => setImmediate(r));
const delay = (n: number) => new Promise<void>((r) => setTimeout(r, n));

describe("native evidence boundaries and bounded telemetry", () => {
  it("backpressure waits without overlapping writes or calling external callbacks", async () => {
    let release!: () => void;
    let active = 0,
      max = 0;
    const written: string[] = [];
    const sink = new BufferedEventSink({
      maxBytes: 1,
      maxMemoryBytes: 2,
      onFlush: async (chunk) => {
        active++;
        max = Math.max(max, active);
        if (chunk === "a") await new Promise<void>((r) => (release = r));
        written.push(chunk);
        active--;
      },
    });
    sink.write("a");
    sink.write("b");
    await tick();
    expect(() => sink.write("c")).toThrow("BACKPRESSURE");
    let admitted = false;
    const writing = sink.writeAsync("c").then(() => (admitted = true));
    await tick();
    expect(admitted).toBe(false);
    expect(sink.bufferedBytes).toBe(2);
    release();
    await writing;
    await sink.close();
    expect(written.join("")).toBe("abc");
    expect(max).toBe(1);
    expect(sink.bufferedBytes).toBe(0);
  });
  it("write rejection is sticky, propagated, and never produces unhandled rejection", async () => {
    const sink = new BufferedEventSink({
      maxBytes: 1,
      onFlush: async () => {
        throw new Error("disk unavailable");
      },
    });
    sink.write("a");
    await tick();
    await expect(sink.close()).rejects.toThrow("disk unavailable");
    await expect(sink.close()).rejects.toThrow("disk unavailable");
    expect(() => sink.write("b")).toThrow("disk unavailable");
  });
  it("keeps split UTF8 intact and close waits for physical completion", async () => {
    let output = "";
    const sink = new BufferedEventSink({
      maxBytes: 1,
      onFlush: async (chunk) => {
        await delay(5);
        output += chunk;
      },
    });
    const bytes = Buffer.from("中文");
    for (const byte of bytes) sink.write(Buffer.from([byte]));
    await sink.close();
    expect(output).toBe("中文");
  });
  it("does not invent an end time or trust a duplicate call ID", () => {
    const raw = {
      tool_call_id: "x",
      command: "test",
      cwd: "root",
      exit_code: 0,
    };
    expect(
      new NativeRunRecordReader([raw]).getFact("x")!.ended_at,
    ).toBeUndefined();
    expect(new NativeRunRecordReader([raw, raw]).verify(raw).valid).toBe(false);
    expect(
      new NativeRunRecordReader([{ ...raw, run_id: "old" }]).readRecords("new"),
    ).toEqual([]);
  });
  it("required command matching rejects echo, compositions and extra arguments", () => {
    expect(matchesCommand("echo pnpm build", "pnpm", ["build"])).toBe(false);
    expect(matchesCommand("pnpm build || echo ok", "pnpm", ["build"])).toBe(
      false,
    );
    expect(matchesCommand("pnpm build --skip-checks", "pnpm", ["build"])).toBe(
      false,
    );
    expect(matchesCommand('pnpm "build"', "pnpm", ["build"])).toBe(true);
    expect(
      matchesCommand("node -e \"print('a  b')\"", "node", [
        "-e",
        "print('a b')",
      ]),
    ).toBe(false);
  });
  function observation() {
    const root = mkdtempSync(join(tmpdir(), "native-receipt-"));
    writeFileSync(join(root, "input.txt"), "correct");
    mkdirSync(join(root, ".reports"));
    const workspaces = [{ repo_id: "main", root } as Workspace];
    const facts: HostToolExecutionFact[] = [];
    const observer = new NativeExecutionObserver({
      workflow_id: "w",
      run_id: "r",
      plan_hash: "p",
      workspaces,
      save: (f) => facts.push(f),
    });
    observer.accept({ event: "init", conversation_id: "conv" });
    observer.accept({
      event: "step_update",
      step_update: {
        conversation_id: "conv",
        step_index: 1,
        step_type: "user_input",
        state: "DONE",
      },
    });
    const tool = (state: string, extra: Record<string, unknown> = {}) =>
      observer.accept({
        event: "step_update",
        step_update: {
          conversation_id: "conv",
          step_index: 2,
          step_type: "tool",
          state,
          tool_name: "run_command",
          tool_info: {
            parameters: { CommandLine: "node test.cjs", Cwd: root },
            ...extra,
          },
        },
      });
    return { root, workspaces, facts, observer, tool };
  }
  it("records a real node test result against observed start/end inputs, never reruns it", () => {
    const s = observation();
    writeFileSync(
      join(s.root, "test.cjs"),
      "const fs=require('fs');require('assert').strictEqual(fs.readFileSync('input.txt','utf8'),'correct');fs.writeFileSync('.reports/unit.json',JSON.stringify({testResults:[{assertionResults:[{title:'real assertion',status:'passed'}]}]}));",
    );
    s.tool("RUNNING");
    execFileSync(process.execPath, ["test.cjs"], {
      cwd: s.root,
      windowsHide: true,
    });
    s.tool("DONE", { exit_code: 0 });
    expect(s.facts).toHaveLength(1);
    const f = s.facts[0]!;
    expect(f.evidence_error).toBeUndefined();
    expect(f.input_fingerprints).toEqual(captureInputs(s.workspaces));
    expect(
      f.report_hashes?.[reportSourceKey("main", ".reports/unit.json")],
    ).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(s.root, "input.txt"), "untested");
    expect(f.input_fingerprints).not.toEqual(captureInputs(s.workspaces));
    const previous = readFileSync(join(s.root, ".reports/unit.json"));
    writeFileSync(join(s.root, ".reports/unit.json"), previous);
    expect(f.input_fingerprints).not.toEqual(captureInputs(s.workspaces));
  });
  it("DONE-only history cannot certify current inputs", () => {
    const s = observation();
    s.tool("DONE", { exit_code: 0 });
    expect(s.facts).toHaveLength(0);
  });
  it("does not attach a preexisting unchanged report to a later unrelated command", () => {
    const s = observation();
    writeFileSync(join(s.root, ".reports/unit.json"), '{"old":true}');
    s.tool("RUNNING");
    s.tool("DONE", { exit_code: 0 });
    expect(s.facts[0]!.report_hashes).toEqual({});
  });
  it("a code change during a command invalidates its receipt", () => {
    const s = observation();
    s.tool("RUNNING");
    writeFileSync(join(s.root, "input.txt"), "changed");
    s.tool("DONE", { exit_code: 0 });
    expect(s.facts[0]!.evidence_error).toContain("Inputs changed");
  });
  it("async terminal completion remains bound to its original command", () => {
    const s = observation();
    s.tool("RUNNING");
    s.tool("DONE", { output: "Process still running. Command ID: bg-1" });
    expect(s.facts).toHaveLength(0);
    s.observer.accept({
      event: "step_update",
      step_update: {
        conversation_id: "conv",
        step_index: 3,
        step_type: "tool",
        state: "DONE",
        tool_name: "command_status",
        tool_info: {
          parameters: { CommandId: "bg-1" },
          output: "Command completed. Exit code: 0",
        },
      },
    });
    expect(s.facts[0]!.tool_call_id).toBe("step-2");
  });
  it("coalesces 1000 streamed updates while preserving actual usage and redacting credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "native-telemetry-"));
    const store = new Store(join(root, "state.db"));
    try {
      const telemetry = new AgentTelemetry(store, "w", "p", "r");
      for (let i = 0; i < 1000; i++)
        telemetry.accept({
          event: "step_update",
          step_update: { step_index: 1, text: "update " + i },
        });
      telemetry.accept({
        event: "result",
        result: {
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cached_tokens: 30,
            reasoning_tokens: 5,
          },
        },
      });
      expect(store.recentEvents("w")).toHaveLength(2);
      expect(store.get<any>("run_usage", "r")).toMatchObject({
        available: true,
        input_tokens: 100,
        output_tokens: 20,
        reasoning_tokens: 5,
      });
      expect(
        publicEvent({
          api_key: "private",
          input_tokens: 100,
          reasoning_tokens: 5,
        }),
      ).toEqual({
        api_key: "[REDACTED]",
        input_tokens: 100,
        reasoning_tokens: 5,
      });
      telemetry.accept({
        event: "result",
        result: {
          usage: {
            input_tokens: 30316,
            output_tokens: 711,
            thinking_tokens: 517,
            cache_read_tokens: 3,
          },
        },
      });
      expect(store.get<any>("run_usage", "r")).toMatchObject({
        available: true,
        input_tokens: 30316,
        output_tokens: 711,
        reasoning_tokens: 517,
        cached_tokens: 3,
      });
      telemetry.accept({ event: "result", result: {} });
      expect(store.get<any>("run_usage", "r")).toMatchObject({
        available: false,
      });
      expect(store.get<any>("run_usage", "r").input_tokens).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

it("handles multibyte UTF8 even when the configured byte window is one", async () => {
  let out = "";
  const sink = new BufferedEventSink({
    maxBytes: 1,
    maxMemoryBytes: 1,
    onFlush: (s) => {
      out += s;
    },
  });
  await sink.writeAsync("中文🙂");
  await sink.close();
  expect(out).toBe("中文🙂");
  expect(sink.bufferedBytes).toBe(0);
});
