import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CursorAgentNativeAdapter } from "../../packages/adapters/cursor/src/adapter.js";
import {
  CURSOR_IMAGE_FLAG,
  CURSOR_NO_CHILD_REASON,
  CURSOR_READONLY_MODES,
  CursorConversationDecoder,
  CursorConversationSource,
  CursorStreamMapper,
  cursorChildIdentity,
  cursorSubagentCapabilities,
  prepareCursorInputAttachments,
} from "../../packages/adapters/cursor/src/conversation-source.js";
import {
  conversationFixturePath,
  loadConversationJsonl,
} from "../fixtures/conversations/load.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import type { ResolvedInputAttachment } from "../../packages/contracts/src/conversation-input.js";

function decodeFixture(fileName: string): NativeConversationEvent[] {
  const mapper = new CursorStreamMapper("cursor-agent:test");
  const events: NativeConversationEvent[] = [];
  for (const record of loadConversationJsonl("cursor-agent", fileName)) {
    events.push(...mapper.decodeLine(JSON.stringify(record), "2026-09-20T00:00:00.000Z"));
  }
  return events;
}

function childEvents(events: NativeConversationEvent[]): NativeConversationEvent[] {
  const root = events.find((event) => event.kind === "discovered" && !event.parent_native_id);
  const rootId = root?.root_native_id;
  return events.filter(
    (event) =>
      Boolean(event.parent_native_id) ||
      Boolean(event.agent_native_id) ||
      (rootId !== undefined &&
        event.session_native_id !== undefined &&
        event.session_native_id !== rootId),
  );
}

describe("SA-U14 cursor conversation source", () => {
  it("records discovery/activity/stop/resume/readonly/file capabilities", () => {
    const capabilities = cursorSubagentCapabilities({
      cli_version: "2026.08.11-e8db854",
    });
    expect(capabilities.discovery).toBe("unavailable");
    expect(capabilities.activity).toBe("native");
    expect(capabilities.stop).toBe("owned-process-tree");
    expect(capabilities.resume).toBe("native");
    expect(capabilities.readonly_delegation).toBe("unknown");
    expect(capabilities.file_input).toEqual({
      text: false,
      image: true,
      binary: false,
    });
    expect(capabilities.cli_version).toBe("2026.08.11-e8db854");
    expect(capabilities.reason).toBe(CURSOR_NO_CHILD_REASON);
    expect(CURSOR_READONLY_MODES).toEqual(["ask", "plan"]);
    expect(CURSOR_IMAGE_FLAG).toBe("--image");
  });

  it("does not promote unknown fields into supported capabilities", () => {
    const capabilities = cursorSubagentCapabilities();
    expect(capabilities.discovery).not.toBe("native");
    expect(capabilities.readonly_delegation).not.toBe("verified");
    expect(capabilities.stop).not.toBe("native");
    expect(capabilities.file_input.text).toBe(false);
    expect(capabilities.file_input.binary).toBe(false);
  });

  it("keeps events on the root when the version has no child identifiers", () => {
    const events = decodeFixture("create.jsonl");
    expect(events.some((event) => event.kind === "discovered")).toBe(true);
    expect(events.some((event) => event.kind === "model")).toBe(true);
    expect(events.some((event) => event.kind === "activity")).toBe(true);
    expect(childEvents(events)).toEqual([]);
    expect(events.every((event) => event.root_native_id === "chat-root-001")).toBe(
      true,
    );
  });

  it("splits root and child when structured child fields are present", () => {
    const events = decodeFixture("nested.jsonl");
    const discoveredChildren = events.filter(
      (event) => event.kind === "discovered" && event.agent_native_id === "subagent-aaa",
    );
    expect(discoveredChildren.length).toBeGreaterThan(0);
    expect(discoveredChildren[0]?.parent_native_id).toBe("chat-root-001");
    const childActivity = events.filter(
      (event) => event.kind === "activity" && event.agent_native_id === "subagent-aaa",
    );
    expect(childActivity.length).toBeGreaterThan(0);
    const rootResult = events.find(
      (event) => event.kind === "state" && !event.agent_native_id,
    );
    expect(rootResult?.session_native_id).toBe("chat-root-001");
  });

  it("does not display ordinary tool calls as subagents", () => {
    const events = decodeFixture("activity.jsonl");
    expect(childEvents(events)).toEqual([]);
    const tools = events
      .filter((event) => event.kind === "activity")
      .map((event) => (event.payload as { tool?: string }).tool)
      .filter(Boolean);
    expect(tools).toContain("shell");
    expect(tools).toContain("task");
    expect(
      events.every((event) =>
        ["discovered", "quota", "activity", "state", "model"].includes(
          event.kind,
        ),
      ),
    ).toBe(true);
  });

  it("ignores invented child arrays and unknown event types", () => {
    const events = decodeFixture("unknown-version.jsonl");
    expect(childEvents(events)).toEqual([]);
    expect(events.some((event) => event.kind === "discovered")).toBe(true);
    expect(
      events.every(
        (event) =>
          event.kind === "discovered" ||
          event.kind === "state" ||
          event.kind === "model" ||
          event.kind === "activity",
      ),
    ).toBe(true);
  });

  it("maps proven usage tokens and ignores unknown quota fields", () => {
    const events = decodeFixture("quota.jsonl");
    const quotas = events.filter((event) => event.kind === "quota");
    expect(quotas).toHaveLength(1);
    expect(quotas[0]?.payload).toEqual({
      input_tokens: 12,
      output_tokens: 34,
    });
  });

  it("treats pause/resume samples as root session facts", () => {
    const paused = decodeFixture("pause.jsonl");
    const resumed = decodeFixture("resume.jsonl");
    expect(childEvents(paused)).toEqual([]);
    expect(childEvents(resumed)).toEqual([]);
    expect(resumed[0]?.session_native_id).toBe("chat-root-001");
  });

  it("only accepts proven file input parameters", async () => {
    const image: ResolvedInputAttachment = {
      id: "file1",
      display_name: "shot.png",
      sha256: "a".repeat(64),
      absolute_path: join(tmpdir(), "cursor-demo", "shot.png"),
      mime: "image/png",
      read_mode: "image",
      size: 12,
    };
    const text: ResolvedInputAttachment = {
      id: "file2",
      display_name: "note.txt",
      sha256: "b".repeat(64),
      absolute_path: join(tmpdir(), "cursor-demo", "note.txt"),
      mime: "text/plain",
      read_mode: "text",
      size: 4,
    };
    const prepared = await prepareCursorInputAttachments([image, text]);
    expect(prepared.attachments).toEqual([image]);
    expect(prepared.unsupported).toContain("--image");
    expect(prepared.unsupported).toContain("文本/二进制");
  });

  it("reads already-bound records without scanning other chats", async () => {
    const filePath = conversationFixturePath("cursor-agent", "create.jsonl");
    const source = new CursorConversationSource({
      filePath,
      rootNativeId: "chat-root-001",
      cliVersion: "2026.08.11-e8db854",
    });
    expect(source.capabilities().reason).toBe(CURSOR_NO_CHILD_REASON);
    const events = await source.readEvents({
      source_id: filePath,
      source_seq: "0",
    });
    expect(events.some((event) => event.kind === "activity")).toBe(true);
    expect(childEvents(events)).toEqual([]);
  });

  it("does not infer children from a different session_id alone", () => {
    const identity = cursorChildIdentity(
      { type: "assistant", session_id: "other-session" },
      "chat-root-001",
    );
    expect(identity).toBeUndefined();
  });

  it("wires adapter decode, bound files, stop and attachments", async () => {
    const adapter = new CursorAgentNativeAdapter();
    expect(adapter.subagents?.reason).toBe(CURSOR_NO_CHILD_REASON);
    expect(adapter.subagents?.file_input.image).toBe(true);
    const first = adapter.decodeConversation({
      timestamp: "2026-09-20T00:00:00.000Z",
      stream: "stdout",
      runId: "run-cursor-1",
      data: '{"type":"system","subtype":"init","session_id":"chat-root-001","model":"Composer 1.5"}\n{"type":"tool_call"',
    });
    expect(first.some((event) => event.kind === "discovered")).toBe(true);
    const rest = adapter.decodeConversation({
      timestamp: "2026-09-20T00:00:01.000Z",
      stream: "stdout",
      runId: "run-cursor-1",
      data: ',"subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"ls"}}},"session_id":"chat-root-001"}\n',
    });
    expect(rest.some((event) => event.kind === "activity")).toBe(true);
    expect(childEvents(rest)).toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "cursor-bound-"));
    const bound = join(dir, "bound.jsonl");
    writeFileSync(
      bound,
      '{"type":"system","subtype":"init","session_id":"chat-root-001","model":"Composer 1.5"}\n',
    );
    adapter.bindConversationFile(bound, "chat-root-001");
    const fromFile = await adapter.readConversationEvents({
      source_id: bound,
      source_seq: "0",
    });
    expect(fromFile.some((event) => event.kind === "discovered")).toBe(true);

    const stop = await adapter.stopConversation({ conversation_id: "node-1" });
    expect(stop.confirmation).toBe("owned_process_tree");

    const prepared = await adapter.prepareInputAttachments?.([
      {
        id: "bin1",
        display_name: "a.bin",
        sha256: "c".repeat(64),
        absolute_path: join(dir, "a.bin"),
        mime: "application/octet-stream",
        read_mode: "binary",
        size: 2,
      },
    ]);
    expect(prepared?.attachments).toEqual([]);
    expect(prepared?.unsupported).toBeTruthy();
  });

  it("buffers stream-json chunks in the decoder", () => {
    const decoder = new CursorConversationDecoder("cursor-agent:stream:test");
    expect(
      decoder.push({
        timestamp: "2026-09-20T00:00:00.000Z",
        stream: "stdout",
        data: '{"type":"system","subtype":"init","session_id":"chat-root-001"',
      }),
    ).toEqual([]);
    const events = decoder.push({
      timestamp: "2026-09-20T00:00:00.000Z",
      stream: "stdout",
      data: ',"model":"Composer 1.5"}\n',
    });
    expect(events.some((event) => event.kind === "model")).toBe(true);
  });
});
