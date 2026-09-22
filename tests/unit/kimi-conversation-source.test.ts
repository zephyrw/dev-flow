import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KimiCodeNativeAdapter } from "../../packages/adapters/kimi/src/adapter.js";
import {
  KIMI_IMAGE_TOOL,
  KIMI_MAIN_AGENT_ID,
  KIMI_PLAN_FLAG,
  KIMI_PLAN_INHERIT_REASON,
  KIMI_PROMPT_FLAG,
  KIMI_PROMPT_PLAN_CONFLICT,
  KIMI_TEXT_TOOL,
  KimiBoundConversationSource,
  KimiStreamDecoder,
  isKimiAgentId,
  isKimiSessionId,
  kimiBoundSourceId,
  kimiChildInheritsPlanMode,
  kimiPromptAllowsPlanFlag,
  kimiReadonlyByProfile,
  kimiSubagentCapabilities,
  prepareKimiInputAttachments,
} from "../../packages/adapters/kimi/src/conversation-source.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import type { ResolvedInputAttachment } from "../../packages/contracts/src/conversation-input.js";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/conversations/kimi-code",
);
const sessionId = "session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1";

function decodeFixture(name: string): NativeConversationEvent[] {
  const decoder = new KimiStreamDecoder("kimi-code:stream:test", sessionId);
  return decoder.push(readFileSync(join(fixtures, name), "utf8"), true);
}

function payload(event: NativeConversationEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function stageBoundSession() {
  const home = mkdtempSync(join(tmpdir(), "kimi-bound-"));
  const sessionDir = join(home, "bound-session");
  cpSync(join(fixtures, "bound-session"), sessionDir, { recursive: true });
  mkdirSync(join(home, "other-session", "agents", "agent-9"), {
    recursive: true,
  });
  writeFileSync(
    join(home, "other-session", "state.json"),
    JSON.stringify({
      id: "session_bbbbbbbb-cccc-dddd-eeee-ffffffffffff1",
      agents: { "agent-9": { type: "sub", parentAgentId: "main" } },
    }),
  );
  return new KimiBoundConversationSource({
    sessionDir,
    sessionId,
    rootNativeId: sessionId,
  });
}

describe("SA-U16 kimi conversation source", () => {
  it("records discovery/activity/stop/resume/readonly/file capabilities without Codex fields", () => {
    const capabilities = kimiSubagentCapabilities({ cli_version: "0.37.2" });
    expect(capabilities.discovery).toBe("native");
    expect(capabilities.activity).toBe("scoped-record");
    expect(capabilities.stop).toBe("owned-process-tree");
    expect(capabilities.resume).toBe("parent-instruction");
    expect(capabilities.readonly_delegation).toBe("unsupported");
    expect(capabilities.file_input).toEqual({
      text: true,
      image: true,
      binary: false,
    });
    expect(capabilities.cli_version).toBe("0.37.2");
    expect(capabilities.reason).toContain(KIMI_PROMPT_PLAN_CONFLICT);
    expect(capabilities.reason).toContain("thinkingEffort");
    expect(capabilities.reason).toContain("不是 Codex sandbox_mode");
    expect(kimiPromptAllowsPlanFlag()).toBe(false);
    expect(kimiChildInheritsPlanMode()).toBe(false);
    expect(KIMI_PLAN_FLAG).toBe("--plan");
    expect(KIMI_PROMPT_FLAG).toBe("--prompt");
    expect(new KimiCodeNativeAdapter().subagents.readonly_delegation).toBe(
      "unsupported",
    );
  });

  it("keeps session_id and agent_id independent on root and child events", () => {
    const events = decodeFixture("stream-json-child-spawn.jsonl");
    const root = events.find(
      (item) =>
        item.kind === "discovered" &&
        item.agent_native_id === KIMI_MAIN_AGENT_ID,
    );
    expect(root?.session_native_id).toBe(sessionId);
    expect(root?.agent_native_id).toBe("main");
    expect(root?.parent_native_id).toBeUndefined();
    expect(isKimiSessionId(root?.session_native_id ?? "")).toBe(true);
    expect(isKimiAgentId(root?.agent_native_id ?? "")).toBe(true);

    const explore = events.find(
      (item) => item.kind === "state" && item.agent_native_id === "agent-1",
    );
    expect(explore?.session_native_id).toBe(sessionId);
    expect(explore?.agent_native_id).toBe("agent-1");
    expect(explore?.parent_native_id).toBe("main");
    expect(explore?.session_native_id).not.toBe(explore?.agent_native_id);
    expect(payload(explore!)).not.toHaveProperty("thread_id");
    expect(payload(explore!)).not.toHaveProperty("sandbox_mode");
    expect(payload(explore!)).not.toHaveProperty("effort");
  });

  it("records plan/explore profile read-only without inheriting --plan", () => {
    const events = decodeFixture("stream-json-child-spawn.jsonl");
    const explore = events.find(
      (item) =>
        item.kind === "discovered" &&
        payload(item).actual_subagent_type === "explore",
    );
    const plan = events.find(
      (item) =>
        item.kind === "discovered" &&
        payload(item).actual_subagent_type === "plan",
    );
    const coder = events.find(
      (item) =>
        item.kind === "discovered" &&
        payload(item).actual_subagent_type === "coder",
    );
    expect(payload(explore!)).toMatchObject({
      plan_mode_inherited: false,
      readonly_by_profile: true,
      resume_target: "agent",
    });
    expect(payload(plan!).readonly_by_profile).toBe(true);
    expect(payload(coder!).readonly_by_profile).toBe(false);
    expect(kimiReadonlyByProfile("explore")).toBe(true);
    expect(kimiReadonlyByProfile("coder")).toBe(false);
    expect(KIMI_PLAN_INHERIT_REASON).toContain("planMode");
  });

  it("maps child failed and interrupted exits without promoting retry to terminal", () => {
    const events = decodeFixture("stream-json-child-failed.jsonl");
    const failed = events.find(
      (item) => item.kind === "state" && item.agent_native_id === "agent-4",
    );
    expect(payload(failed!).status).toBe("failed");
    expect(payload(failed!).exception).toMatchObject({
      message: "Subagent turn cancelled",
    });
    const interrupted = events.find(
      (item) =>
        item.kind === "state" && payload(item).status === "interrupted",
    );
    expect(interrupted).toBeTruthy();
    const retry = events.find(
      (item) =>
        item.kind === "activity" && payload(item).title === "turn.step.retrying",
    );
    expect(retry?.agent_native_id).toBe("main");
    expect(
      events.some(
        (item) =>
          item.kind === "state" &&
          item.agent_native_id === "main" &&
          payload(item).status === "failed",
      ),
    ).toBe(false);
  });

  it("ignores Codex thread/sandbox/effort fields and does not invent children", () => {
    const events = decodeFixture("stream-json-unknown-codex.jsonl");
    expect(
      events.some((item) => item.session_native_id === "codex-thread-should-not-bind"),
    ).toBe(false);
    expect(events.some((item) => item.agent_native_id?.startsWith("agent-"))).toBe(
      false,
    );
    const plan = events.find(
      (item) => item.kind === "state" && payload(item).plan_mode === true,
    );
    expect(plan?.agent_native_id).toBe("main");
    expect(payload(plan!).plan_mode_inherited).toBe(false);
    const model = events.find((item) => item.kind === "model");
    expect(payload(model!)).toMatchObject({
      model_alias: "kimi-code/k3",
      thinking_effort: "max",
    });
    expect(payload(model!)).not.toHaveProperty("effort");
  });

  it("accepts text and image attachments through Read/ReadMediaFile roots", async () => {
    const text: ResolvedInputAttachment = {
      id: "file-text",
      display_name: "note.txt",
      sha256: "a".repeat(64),
      absolute_path: join(tmpdir(), "kimi-demo", "note.txt"),
      mime: "text/plain",
      read_mode: "text",
      size: 4,
    };
    const image: ResolvedInputAttachment = {
      id: "file-image",
      display_name: "shot.png",
      sha256: "b".repeat(64),
      absolute_path: join(tmpdir(), "kimi-demo", "shot.png"),
      mime: "image/png",
      read_mode: "image",
      size: 12,
    };
    const binary: ResolvedInputAttachment = {
      id: "file-bin",
      display_name: "blob.bin",
      sha256: "c".repeat(64),
      absolute_path: join(tmpdir(), "kimi-demo", "blob.bin"),
      mime: "application/octet-stream",
      read_mode: "binary",
      size: 8,
    };
    const prepared = await prepareKimiInputAttachments([text, image, binary]);
    expect(prepared.attachments).toEqual([text, image]);
    expect(prepared.extraReadRoots).toContain(join(tmpdir(), "kimi-demo"));
    expect(prepared.unsupported).toContain(KIMI_TEXT_TOOL);
    expect(prepared.unsupported).toContain(KIMI_IMAGE_TOOL);
    expect(prepared.unsupported).toContain("二进制");
  });

  it("reads only the bound session agents and their wire records", async () => {
    const source = stageBoundSession();
    const discovered = await source.readEvents({
      source_id: kimiBoundSourceId("session", sessionId),
      source_seq: "0",
    });
    const ids = discovered.map((item) => item.agent_native_id).sort();
    expect(ids).toEqual(["agent-1", "main"]);
    expect(
      discovered.every((item) => item.session_native_id === sessionId),
    ).toBe(true);
    expect(discovered.some((item) => item.agent_native_id === "agent-9")).toBe(
      false,
    );

    const childWire = await source.readEvents({
      source_id: kimiBoundSourceId("wire", sessionId, "agent-1"),
      source_seq: "0",
    });
    const childModel = childWire.find((item) => item.kind === "model");
    expect(childModel?.agent_native_id).toBe("agent-1");
    expect(payload(childModel!)).toMatchObject({
      model_alias: "kimi-code/k3",
      thinking_effort: "low",
      source: "native_session",
    });
    const childRead = childWire.find(
      (item) => item.kind === "activity" && payload(item).tool === "Read",
    );
    expect(childRead?.parent_native_id).toBe("main");

    const leaked = await source.readEvents({
      source_id: kimiBoundSourceId(
        "session",
        "session_bbbbbbbb-cccc-dddd-eeee-ffffffffffff1",
      ),
    });
    expect(leaked).toEqual([]);
  });

  it("decodes stream chunks and bound records through the adapter", async () => {
    const adapter = new KimiCodeNativeAdapter();
    const events = adapter.decodeConversation({
      stream: "stdout",
      data: readFileSync(join(fixtures, "stream-json-child-spawn.jsonl")),
      timestamp: "2026-09-20T00:00:00.000Z",
      runId: "run-kimi-1",
    });
    expect(events.some((item) => item.agent_native_id === "agent-1")).toBe(true);

    const sessionDir = join(
      mkdtempSync(join(tmpdir(), "kimi-adapter-")),
      "bound-session",
    );
    cpSync(join(fixtures, "bound-session"), sessionDir, { recursive: true });
    adapter.bindBoundSession(sessionDir, sessionId);
    const fromSource = await adapter.readConversationEvents({
      source_id: kimiBoundSourceId("session", sessionId),
      source_seq: "0",
    });
    expect(fromSource.some((item) => item.agent_native_id === "agent-1")).toBe(
      true,
    );
    const stop = await adapter.stopConversation({
      conversation_id: "conv-1",
      native_session_id: sessionId,
      native_agent_id: "agent-1",
    });
    expect(stop.confirmation).toBe("owned_process_tree");
    expect(stop.reason).toContain("agent_id");
  });
});
