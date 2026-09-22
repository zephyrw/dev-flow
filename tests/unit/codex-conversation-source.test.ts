import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexNativeAdapter } from "../../packages/adapters/codex/src/adapter.js";
import {
  CodexConversationDecoder,
  CodexConversationSource,
  CodexStreamMapper,
  CODEX_UNPAID_REASON,
  continuationForCodexSession,
  collectInstalledCodexCliVersion,
  codexProtocolCompatible,
  codexSubagentCapabilities,
  parseCodexCliVersion,
  rootProcessExitState,
} from "../../packages/adapters/codex/src/conversation-source.js";
import { CodexSessionObserver } from "../../packages/runtime/src/codex-session-observer.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import type { RunTelemetry } from "../../packages/runtime/src/run-telemetry.js";
import {
  conversationFixturePath,
  loadConversationJsonl,
} from "../fixtures/conversations/load.js";

const ROOT = "019947a2-8a00-7000-8000-000000000010";
const CHILD = "019947a2-8a00-7000-8000-000000000011";
const GRAND = "019947a2-8a00-7000-8000-000000000012";
const RECREATED = "019947a2-8a00-7000-8000-000000000013";

function decodeFixture(name: string): NativeConversationEvent[] {
  const mapper = new CodexStreamMapper(`fixture:${name}`);
  const events: NativeConversationEvent[] = [];
  for (const record of loadConversationJsonl("codex", name)) {
    events.push(
      ...mapper.decodeLine(JSON.stringify(record), "2026-09-20T00:00:00.000Z"),
    );
  }
  return events;
}

function payloadOf<T>(event: NativeConversationEvent | undefined): T {
  return (event?.payload ?? {}) as T;
}

describe("SA-U11 Codex conversation source", () => {
  it("builds the tree from spawn-returned child ids and keeps parent identity", () => {
    const events = decodeFixture("create.jsonl");
    const child = events.find(
      (event) =>
        event.kind === "discovered" && event.session_native_id === CHILD,
    );
    expect(child?.root_native_id).toBe(ROOT);
    expect(child?.parent_native_id).toBe(ROOT);
    expect(child?.agent_native_id).toBe("explore-1");
    expect(payloadOf<{ spawn_call_id?: string }>(child).spawn_call_id).toBe(
      "item_spawn_1",
    );
    const childState = events.find(
      (event) => event.kind === "state" && event.session_native_id === CHILD,
    );
    expect(payloadOf<{ status?: string }>(childState).status).toBe("running");
  });

  it("nests grandchild under the spawn parent instead of the root", () => {
    const events = decodeFixture("nested.jsonl");
    const grand = events.find(
      (event) =>
        event.kind === "discovered" && event.session_native_id === GRAND,
    );
    expect(grand?.parent_native_id).toBe(CHILD);
    expect(grand?.parent_native_id).not.toBe(ROOT);
    expect(grand?.agent_native_id).toBe("review-2");
  });

  it("splits root and child activity and does not copy parent commands onto the child", () => {
    const events = decodeFixture("activity.jsonl");
    const rootCmd = events.find(
      (event) =>
        event.kind === "activity" &&
        event.session_native_id === ROOT &&
        payloadOf<{ command?: string }>(event).command?.includes("root.test"),
    );
    const childCmd = events.find(
      (event) =>
        event.kind === "activity" &&
        event.session_native_id === CHILD &&
        payloadOf<{ command?: string }>(event).command?.includes("child.test"),
    );
    expect(rootCmd).toBeDefined();
    expect(childCmd).toBeDefined();
    expect(rootCmd?.session_native_id).not.toBe(childCmd?.session_native_id);
    expect(
      events.some(
        (event) =>
          event.kind === "activity" &&
          event.session_native_id === CHILD &&
          payloadOf<{ command?: string }>(event).command?.includes("root.test"),
      ),
    ).toBe(false);
  });

  it("pauses the child without treating a root turn completion as descendant exit", () => {
    const events = decodeFixture("pause.jsonl");
    const childPaused = events.find(
      (event) =>
        event.kind === "state" &&
        event.session_native_id === CHILD &&
        payloadOf<{ status?: string }>(event).status === "paused",
    );
    expect(childPaused).toBeDefined();
    const rootTurn = events.find(
      (event) =>
        event.kind === "state" &&
        event.session_native_id === ROOT &&
        payloadOf<{ status?: string }>(event).status === "waiting",
    );
    expect(payloadOf<{ descendants_terminal?: boolean }>(rootTurn).descendants_terminal).toBe(
      false,
    );
    expect(
      events.some(
        (event) =>
          event.kind === "state" &&
          event.session_native_id === CHILD &&
          payloadOf<{ status?: string }>(event).status === "completed",
      ),
    ).toBe(false);
  });

  it("marks resume-native for the same session and recreate after confirmed exit", () => {
    expect(
      continuationForCodexSession({
        sameNativeSession: true,
        confirmedExited: false,
      }),
    ).toBe("resume-native");
    expect(
      continuationForCodexSession({
        sameNativeSession: false,
        confirmedExited: true,
      }),
    ).toBe("recreate-after-confirmed-exit");
    const events = decodeFixture("resume.jsonl");
    const resumed = events.find(
      (event) =>
        event.kind === "discovered" && event.session_native_id === CHILD,
    );
    expect(payloadOf<{ continuation?: string }>(resumed).continuation).toBe(
      "resume-native",
    );
    const recreated = events.find(
      (event) =>
        event.kind === "discovered" && event.session_native_id === RECREATED,
    );
    expect(payloadOf<{ continuation?: string }>(recreated).continuation).toBe(
      "recreate-after-confirmed-exit",
    );
    expect(
      payloadOf<{ replaces_native_id?: string }>(recreated).replaces_native_id,
    ).toBe(CHILD);
  });

  it("keeps quota on the emitting session instead of the parent", () => {
    const events = decodeFixture("quota.jsonl");
    const quota = events.find((event) => event.kind === "quota");
    expect(quota?.session_native_id).toBe(CHILD);
    expect(quota?.session_native_id).not.toBe(ROOT);
    const failed = events.find(
      (event) =>
        event.kind === "state" &&
        payloadOf<{ reason?: string }>(event).reason === "quota",
    );
    expect(failed?.session_native_id).toBe(CHILD);
  });

  it("does not misidentify unknown-version events as children or activities", () => {
    expect(decodeFixture("unknown-version.jsonl")).toEqual([]);
    const mismatch = codexSubagentCapabilities("9.0.0");
    expect(mismatch.discovery).toBe("unknown");
    expect(mismatch.activity).toBe("unavailable");
    expect(mismatch.reason).toContain("版本协议不符");
    expect(codexProtocolCompatible("0.20.0")).toBe(false);
    expect(codexProtocolCompatible("0.154.0")).toBe(true);
    expect(codexSubagentCapabilities().file_input).toEqual({
      text: true,
      image: true,
      binary: false,
    });
    expect(mismatch.file_input.image).toBe(false);
  });

  it("reads bound session records for per-session model and skips unknown rows", async () => {
    const source = new CodexConversationSource(
      {
        filePath: conversationFixturePath("codex", "session-child.jsonl"),
        rootNativeId: ROOT,
        sessionNativeId: CHILD,
        parentNativeId: ROOT,
      },
      "0.154.0",
    );
    const events = await source.readEvents({
      source_id: source.sourceId,
      source_seq: "0",
    });
    const model = events.find((event) => event.kind === "model");
    expect(model?.session_native_id).toBe(CHILD);
    expect(payloadOf<{ actual_model?: string; actual_effort?: string }>(model)).toMatchObject({
      actual_model: "gpt-5.2-codex",
      actual_effort: "medium",
      model_source: "native_session",
    });
    expect(events.some((event) => event.session_native_id === ROOT && event.kind === "model")).toBe(
      false,
    );
    expect(
      events.some(
        (event) => event.session_native_id === "019947a2-8a00-7000-8000-000000000099",
      ),
    ).toBe(false);
  });

  it("exposes adapter capabilities, decodeConversation and owned-process stop limits", async () => {
    const adapter = new CodexNativeAdapter({ cliVersion: "codex-cli 0.154.0" });
    expect(adapter.subagents).toMatchObject({
      discovery: "native",
      activity: "native",
      stop: "owned-process-tree",
      resume: "native",
      readonly_delegation: "unknown",
      cli_version: "0.154.0",
      reason: CODEX_UNPAID_REASON,
    });
    expect(parseCodexCliVersion("codex-cli 0.154.0")).toBe("0.154.0");
    const streamed = adapter.decodeConversation({
      stream: "stdout",
      timestamp: "2026-09-20T00:00:00.000Z",
      runId: "run_codex",
      data: JSON.stringify({
        type: "thread.started",
        thread_id: ROOT,
      }) + "\n",
    });
    expect(streamed.some((event) => event.kind === "discovered")).toBe(true);
    adapter.bindConversationFile(
      conversationFixturePath("codex", "create.jsonl"),
      ROOT,
    );
    const recovered = await adapter.readConversationEvents({
      source_id: conversationFixturePath("codex", "create.jsonl"),
      source_seq: "0",
    });
    expect(
      recovered.some(
        (event) => event.kind === "discovered" && event.session_native_id === CHILD,
      ),
    ).toBe(true);
    const stopped = await adapter.stopConversation({
      conversation_id: CHILD,
      native_session_id: CHILD,
    });
    expect(stopped.confirmation).toBe("owned_process_tree");
    expect(stopped.reason).toContain("root PID");
  });

  it("observes only bound sessions, isolates model/effort, and does not complete children on root PID exit", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "codex-sa-u11-"));
    const home = join(rootDir, "codex-home");
    const startedAt = new Date().toISOString();
    const date = new Date(startedAt).toISOString().slice(0, 10).split("-");
    const dir = join(home, "sessions", ...date);
    mkdirSync(dir, { recursive: true });
    const line = (type: string, payload: Record<string, unknown>) =>
      JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) +
      "\n";
    writeFileSync(
      join(dir, "rollout-test-" + ROOT + ".jsonl"),
      line("session_meta", { id: ROOT, cwd: rootDir }) +
        line("turn_context", { model: "gpt-5.2", effort: "xhigh" }),
    );
    writeFileSync(
      join(dir, "rollout-test-" + CHILD + ".jsonl"),
      line("session_meta", { id: CHILD, cwd: rootDir }) +
        line("turn_context", { model: "gpt-5.2-codex", effort: "medium" }),
    );
    const models: Array<Record<string, unknown>> = [];
    const conversationEvents: NativeConversationEvent[] = [];
    const observer = new CodexSessionObserver({
      home,
      cwd: rootDir,
      startedAt,
      telemetry: {
        metadata(value: Record<string, unknown>) {
          models.push(value);
        },
      } as unknown as RunTelemetry,
      onConversationEvent(event) {
        conversationEvents.push(event);
      },
    });
    try {
      observer.bind(ROOT);
      observer.bindChild(CHILD, ROOT);
      await observer.poll();
      observer.notifyRootProcessExit();
      const rootModel = conversationEvents.find(
        (event) => event.kind === "model" && event.session_native_id === ROOT,
      );
      const childModel = conversationEvents.find(
        (event) => event.kind === "model" && event.session_native_id === CHILD,
      );
      expect(payloadOf<{ actual_model?: string; actual_effort?: string }>(rootModel)).toMatchObject({
        actual_model: "gpt-5.2",
        actual_effort: "xhigh",
      });
      expect(payloadOf<{ actual_model?: string; actual_effort?: string }>(childModel)).toMatchObject({
        actual_model: "gpt-5.2-codex",
        actual_effort: "medium",
      });
      expect(models).toEqual([
        {
          actual_model: "gpt-5.2",
          effort: "xhigh",
          model_source: "native_session",
        },
      ]);
      const exitState = conversationEvents.find(
        (event) => event.source_seq === "root-process-exit",
      );
      expect(exitState?.session_native_id).toBe(ROOT);
      expect(payloadOf<ReturnType<typeof rootProcessExitState>>(exitState)).toMatchObject({
        status: "interrupted",
        root_process_exit: true,
        descendants_terminal: false,
      });
      expect(
        conversationEvents.some(
          (event) =>
            event.session_native_id === CHILD &&
            payloadOf<{ status?: string }>(event).status === "completed",
        ),
      ).toBe(false);
    } finally {
      await observer.close();
    }
  });

  it("records the unpaid verification reason even when a local CLI version is parsed", () => {
    const installed = collectInstalledCodexCliVersion();
    const capabilities = codexSubagentCapabilities(installed ?? "0.154.0");
    expect(capabilities.reason).toContain(CODEX_UNPAID_REASON);
    if (installed) expect(capabilities.cli_version).toBe(installed);
    const decoder = new CodexConversationDecoder("codex:stream:test");
    expect(
      decoder.push({
        stream: "stderr",
        timestamp: "2026-09-20T00:00:00.000Z",
        data: '{"type":"thread.started","thread_id":"' + ROOT + '"}\n',
      }),
    ).toEqual([]);
  });
});
