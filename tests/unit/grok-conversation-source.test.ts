import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, cpSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrokBuildNativeAdapter } from "../../packages/adapters/grok/src/adapter.js";
import {
  GrokBoundConversationSource,
  GrokStreamDecoder,
  classifyGrokWriteRestriction,
  grokBoundSourceId,
  grokSessionDirectory,
  grokSubagentCapabilities,
  grokSubagentsDefaultDisabled,
  parseGrokBoundSourceId,
} from "../../packages/adapters/grok/src/conversation-source.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/conversations/grok-build",
);
const rootSession = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee0";
const workspace = "C:\\fixture\\grok-workspace";

function decodeFixture(name: string) {
  const decoder = new GrokStreamDecoder();
  return decoder.push(readFileSync(join(fixtures, name), "utf8"), true);
}

function payload(event: { payload: unknown }) {
  return event.payload as Record<string, unknown>;
}

function stageBoundSession(extraEvents?: string) {
  const grokHome = mkdtempSync(join(tmpdir(), "grok-bound-"));
  const sessionDir = grokSessionDirectory(grokHome, workspace, rootSession);
  mkdirSync(sessionDir, { recursive: true });
  cpSync(join(fixtures, "bound-session"), sessionDir, { recursive: true });
  if (extraEvents) {
    writeFileSync(join(sessionDir, "events.jsonl"), extraEvents);
  }
  return new GrokBoundConversationSource({
    grokHome,
    workspaceRoot: workspace,
    sessionId: rootSession,
    rootSessionId: rootSession,
  });
}

describe("SA-U15 grok conversation source", () => {
  it("does not treat subagents as disabled by default", () => {
    expect(grokSubagentsDefaultDisabled()).toBe(false);
    const capabilities = grokSubagentCapabilities("grok 1.0.30");
    expect(capabilities.discovery).toBe("native");
    expect(capabilities.activity).toBe("native");
    expect(capabilities.resume).toBe("native");
    expect(capabilities.stop).toBe("owned-process-tree");
    expect(capabilities.readonly_delegation).toBe("verified");
    expect(capabilities.file_input).toEqual({
      text: false,
      image: false,
      binary: false,
    });
    expect(capabilities.reason).not.toMatch(/no-subagents|disabled/i);
    expect(new GrokBuildNativeAdapter().subagents.discovery).toBe("native");
  });

  it("decodes streaming-json explore spawn as a write-restricted child", () => {
    const events = decodeFixture("streaming-json-spawn-explore.jsonl");
    const discovered = events.find((item) => item.kind === "discovered");
    expect(discovered?.parent_native_id).toBe("unbound-root");
    expect(payload(discovered!)).toMatchObject({
      tool: "spawn_subagent",
      subagent_type: "explore",
      write_restriction: "restricted",
      description: "Inspect adapters",
    });
    expect(payload(discovered!)).not.toHaveProperty("prompt");
    const started = events.find(
      (item) => item.kind === "state" && payload(item).subagent_id === "sa-explore-1",
    );
    expect(started?.session_native_id).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1",
    );
    expect(payload(started!).status).toBe("running");
    expect(events.some((item) => payload(item).tool_name === "read_file")).toBe(
      true,
    );
  });

  it("keeps write tools unrestricted for general-purpose spawn", () => {
    const events = decodeFixture("streaming-json-spawn-general.jsonl");
    expect(payload(events[0]!)).toMatchObject({
      subagent_type: "general-purpose",
      write_restriction: "unrestricted",
    });
    expect(classifyGrokWriteRestriction({ subagentType: "general-purpose" })).toBe(
      "unrestricted",
    );
  });

  it("keeps readonly custom child write-restricted", () => {
    const events = decodeFixture("streaming-json-readonly-child.jsonl");
    expect(payload(events[0]!)).toMatchObject({
      subagent_type: "devflow-readonly-child",
      write_restriction: "restricted",
    });
    expect(
      classifyGrokWriteRestriction({
        subagentType: "devflow-readonly-child",
        tools: ["read", "grep", "glob"],
      }),
    ).toBe("restricted");
    expect(
      classifyGrokWriteRestriction({
        subagentType: "explore",
        tools: ["read_file", "write"],
      }),
    ).toBe("unrestricted");
  });

  it("does not treat unknown fields or types as supported capabilities", () => {
    const events = decodeFixture("streaming-json-unknown-fields.jsonl");
    expect(events.some((item) => item.kind === "discovered" && payload(item).tool === "not_a_subagent")).toBe(false);
    expect(events.filter((item) => item.kind === "discovered")).toHaveLength(1);
    const mystery = events.find((item) => item.kind === "discovered");
    expect(payload(mystery!)).toMatchObject({
      subagent_type: "mystery-type",
      write_restriction: "unknown",
    });
    expect(payload(mystery!)).not.toHaveProperty("file_input_binary");
    expect(payload(mystery!)).not.toHaveProperty("stop");
    expect(payload(mystery!)).not.toHaveProperty("native_abort");
    const completed = events.find((item) => item.kind === "state");
    expect(payload(completed!)).not.toHaveProperty("quantum_resume");
    expect(events.some((item) => payload(item).discovery === "native")).toBe(false);
    expect(events.some((item) => item.kind === "activity" && payload(item).tool_name === "not_a_subagent")).toBe(true);
  });

  it("reads only the bound session files and ignores unknown relationship values", async () => {
    const source = stageBoundSession();
    expect(source.capabilities().readonly_delegation).toBe("verified");
    const started = await source.readEvents({
      source_id: grokBoundSourceId("events", rootSession),
      source_seq: "0",
    });
    expect(started.map((item) => item.kind)).toEqual(["state", "model", "state"]);
    expect(payload(started[1]!)).toEqual({
      actual_model: "grok-4.6",
      model_source: "native_event",
    });
    const updates = await source.readEvents({
      source_id: grokBoundSourceId("updates", rootSession),
      source_seq: "0",
    });
    expect(payload(updates[0]!)).toMatchObject({
      subagent_type: "plan",
      write_restriction: "restricted",
    });
    expect(updates.some((item) => payload(item).native_stop === true)).toBe(false);
    const summary = await source.readEvents({
      source_id: grokBoundSourceId("summary", rootSession),
      source_seq: "0",
    });
    expect(summary[0]?.agent_native_id).toBe("ag-root-1");
    const meta = await source.readEvents({
      source_id: grokBoundSourceId("meta", rootSession, "sa-plan-1"),
      source_seq: "0",
    });
    expect(payload(meta[0]!)).toMatchObject({
      subagent_id: "sa-plan-1",
      subagent_type: "plan",
      write_restriction: "restricted",
    });
    expect(payload(meta[0]!)).not.toHaveProperty("file_input_binary");
    expect(payload(meta[0]!)).not.toHaveProperty("stop");
    const unknown = stageBoundSession(
      '{"ts":"2026-09-20T00:00:00.000Z","type":"turn_started","session_id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee0","session_relationship":"side-channel","model_id":"stolen-model"}\n',
    );
    const skipped = await unknown.readEvents({
      source_id: grokBoundSourceId("events", rootSession),
      source_seq: "0",
    });
    expect(skipped).toEqual([]);
  });

  it("rejects unbound or unsafe source identities", () => {
    expect(parseGrokBoundSourceId("grok-build:events:../secret")).toBeUndefined();
    expect(
      parseGrokBoundSourceId("codex:events:" + rootSession),
    ).toBeUndefined();
    expect(() =>
      grokSessionDirectory("C:\\tmp", workspace, "../escape"),
    ).toThrow("Grok 会话标识无效");
  });

  it("decodes streaming-json chunks through the grok adapter", () => {
    const adapter = new GrokBuildNativeAdapter();
    const events = adapter.decodeConversation({
      stream: "stdout",
      timestamp: "2026-09-20T00:00:00.000Z",
      runId: "run-1",
      data: readFileSync(
        join(fixtures, "streaming-json-spawn-explore.jsonl"),
        "utf8",
      ),
      final: true,
    });
    expect(events.some((item) => item.kind === "discovered")).toBe(true);
    expect(adapter.decodeConversation({
      stream: "stderr",
      timestamp: "2026-09-20T00:00:00.000Z",
      data: '{"type":"tool_call","toolName":"spawn_subagent"}\n',
    })).toEqual([]);
  });
});
