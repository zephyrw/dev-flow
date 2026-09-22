import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MIMO_ADAPTER_ID,
  MimoConversationSource,
  type MimoInstanceBinding,
} from "../../packages/adapters/mimo/src/conversation-source.js";
import { parseJsonLine } from "../../packages/adapters/sdk/src/conversation-source.js";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/conversations/mimo",
);

function readFixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), "utf8");
}

function jsonlEvents(name: string): unknown[] {
  return readFixture(name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine(line))
    .filter((item) => item !== undefined);
}

function binding(
  extra: Partial<MimoInstanceBinding> = {},
): MimoInstanceBinding {
  return {
    workflowId: "wf1",
    runId: "run1",
    lineageId: "wf1:run1",
    rootSessionId: "ses_mimo1",
    purpose: "implement",
    cliVersion: "0.1.14",
    ...extra,
  };
}

function decodeAll(
  source: MimoConversationSource,
  name: string,
): ReturnType<MimoConversationSource["decodeChunk"]> {
  const payload = readFixture(name);
  return source.decodeChunk({
    runId: "run1",
    stream: "stdout",
    data: payload,
    timestamp: "2026-09-22T09:00:00.000Z",
    final: true,
  });
}

describe("MiMo conversation source", () => {
  it("adapter id is mimo-code and does not alias opencode", () => {
    expect(MIMO_ADAPTER_ID).toBe("mimo-code");
  });

  it("binds the current MiMo session and maps error/text/tool events", () => {
    const current = binding();
    const source = new MimoConversationSource(current);
    const events = decodeAll(source, "run-json-session-events.jsonl");
    const target = events.filter((e) => e.session_native_id === "ses_mimo1");
    const other = events.filter((e) => e.session_native_id === "ses_other9");

    // Non-target session events must be dropped entirely.
    expect(other).toEqual([]);
    expect(target.length).toBeGreaterThan(0);

    const kinds = new Set(target.map((e) => e.kind));
    expect(kinds.has("activity")).toBe(true);
    expect(kinds.has("state")).toBe(true);

    // text is mapped to model-output activity, tool_use to tool activity.
    const texts = target.filter(
      (e) => e.kind === "activity" && (e.payload as { kind?: string }).kind === "message",
    );
    expect(texts.some((e) =>
      JSON.stringify(e.payload).includes("已完成文件读取"),
    )).toBe(true);
    const tools = target.filter(
      (e) => e.kind === "activity" && (e.payload as { kind?: string }).kind === "tool",
    );
    expect(tools.some((e) => (e.payload as { tool?: string }).tool === "bash")).toBe(
      true,
    );

    // Target-session error becomes a failed state (run is still ours).
    const failed = target.filter(
      (e) =>
        e.kind === "state" &&
        (e.payload as { status?: string }).status === "failed",
    );
    expect(failed.length).toBeGreaterThan(0);

    // Other-session error must NOT end the current run.
    expect(
      target.some((e) => JSON.stringify(e.payload).includes("other-session auth failed")),
    ).toBe(false);
  });

  it("decodeChunk binds first seen session id to the run", () => {
    const source = new MimoConversationSource(
      binding({ rootSessionId: undefined }),
    );
    const lines = jsonlEvents("run-json-session-events.jsonl") as Array<
      Record<string, unknown>
    >;
    // First event carries ses_mimo1; source should bind it as root.
    const first = lines[0]!;
    const events = source.decodeChunk({
      runId: "run1",
      stream: "stdout",
      data: JSON.stringify(first) + "\n",
      timestamp: "2026-09-22T09:00:00.000Z",
      final: false,
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.session_native_id === "ses_mimo1")).toBe(true);
  });

  it("rejects stop of a non-target session and confirms stop of the bound one", async () => {
    const source = new MimoConversationSource(binding());
    const foreign = await source.abort({
      conversation_id: "conv1",
      native_session_id: "ses_other9",
    });
    expect(foreign.confirmation).toBe("unconfirmed");

    const owned = await source.abort({
      conversation_id: "conv1",
      native_session_id: "ses_mimo1",
    });
    // Managed CLI run has no separate abort API; process-tree stop is the limit.
    expect(["owned_process_tree", "native", "unconfirmed"]).toContain(
      owned.confirmation,
    );
    if (owned.confirmation === "unconfirmed") {
      expect(owned.reason).toBeTruthy();
    }
  });

  it("does not treat foreign-session completion as this run finishing", () => {
    const source = new MimoConversationSource(binding());
    // Foreign session ends cleanly — must not emit a completed state for our run.
    const foreignEnd = decodeAll(source, "run-json-session-events.jsonl").filter(
      (e) =>
        e.session_native_id === "ses_other9" ||
        (e.kind === "state" &&
          (e.payload as { status?: string }).status === "completed"),
    );
    // ses_other9 is dropped; nothing here should mark our run completed.
    expect(foreignEnd).toEqual([]);
  });
});
