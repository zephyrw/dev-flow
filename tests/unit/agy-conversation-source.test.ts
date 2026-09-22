import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  AGY_PAUSE_ATTRIBUTION,
  AgyConversationSource,
  agyActivityId,
  agySubagentCapabilities,
  decodeAgyConversationEvents,
} from "../../packages/adapters/agy/src/conversation-source.js";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import {
  AgyNativeRecordSource,
  agyStepSourceId,
  tryDecodeAgyToolMetadata,
} from "../../packages/adapters/agy/src/native-record-source.js";
import { agyArguments, agyRunLogFile } from "../../packages/adapters/agy/src/session.js";

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const OTHER = "55555555-5555-4555-8555-555555555555";
const fixtureDir = fileURLToPath(
  new URL("../fixtures/conversations/agy", import.meta.url),
);

function loadEvents(name: string) {
  return readFileSync(join(fixtureDir, name), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function decodeFixture(name: string, root = PARENT) {
  return decodeAgyConversationEvents(loadEvents(name), { rootNativeId: root });
}

const varint = (n: number) => {
  const bytes = [];
  while (n >= 128) {
    bytes.push((n & 127) | 128);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
};
const field = (n: number, v: Buffer | string) => {
  const b = Buffer.from(v);
  return Buffer.concat([varint(n * 8 + 2), varint(b.length), b]);
};
const toolPayload = (name: string, parameters: Record<string, unknown>) =>
  field(
    5,
    field(
      4,
      Buffer.concat([
        field(1, "call-real"),
        field(2, name),
        field(3, JSON.stringify(parameters)),
      ]),
    ),
  );

function writeStepDb(
  root: string,
  conversation: string,
  index: number,
  payload: Buffer,
) {
  const base = join(root, ".gemini", "antigravity-cli", "conversations");
  mkdirSync(base, { recursive: true });
  const db = new Database(join(base, conversation + ".db"));
  db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_payload BLOB)");
  db.prepare("INSERT INTO steps VALUES (?,?)").run(index, payload);
  db.close();
}

describe("SA-U12 agy conversation source", () => {
  it("reports scoped-record discovery and honest pause attribution", () => {
    const capabilities = agySubagentCapabilities("1.2.5");
    expect(capabilities).toMatchObject({
      discovery: "scoped-record",
      activity: "scoped-record",
      stop: "owned-process-tree",
      resume: "parent-instruction",
      readonly_delegation: "unknown",
      file_input: { text: false, image: false, binary: false },
      cli_version: "1.2.5",
    });
    expect(capabilities.reason).toContain("暂停归属");
    expect(capabilities.reason).toContain("受管进程树");
    expect(capabilities.stop).not.toBe("native");
    expect(capabilities.readonly_delegation).not.toBe("verified");
  });

  it("projects parent wait separately from child run using real invoke_subagent identity", () => {
    const events = decodeFixture("parent-delegate.jsonl");
    const parentWait = events.find(
      (event) =>
        event.kind === "state" &&
        event.session_native_id === PARENT &&
        (event.payload as { status?: string }).status === "waiting",
    );
    const child = events.find((event) => event.session_native_id === CHILD);
    const parentRunning = events.find(
      (event) =>
        event.kind === "state" &&
        event.session_native_id === PARENT &&
        (event.payload as { status?: string }).status === "running" &&
        event.source_seq.includes(":parent"),
    );
    expect(parentWait?.source_id).toBe("agy:" + PARENT);
    expect(child).toMatchObject({
      root_native_id: PARENT,
      parent_native_id: PARENT,
      session_native_id: CHILD,
      agent_native_id: "DeepCoder",
    });
    expect(parentWait?.session_native_id).not.toBe(CHILD);
    expect(parentRunning?.session_native_id).toBe(PARENT);
    expect(
      events.some(
        (event) =>
          event.kind === "activity" && event.session_native_id === CHILD,
      ),
    ).toBe(false);
  });

  it("keeps child step index owned by child identity", () => {
    const parent = decodeFixture("parent-delegate.jsonl");
    const child = decodeFixture("child-steps.jsonl", PARENT);
    const parentWait = parent.find(
      (event) =>
        event.kind === "state" &&
        event.session_native_id === PARENT &&
        (event.payload as { status?: string }).status === "waiting",
    );
    const childActivity = child.find(
      (event) =>
        event.kind === "activity" && event.session_native_id === CHILD,
    );
    expect(agyActivityId({ conversation_id: PARENT, step_index: 4 })).toBe(
      "agy:11111111-1111-4111-8111-111111111111:step:4",
    );
    expect(agyActivityId({ conversation_id: CHILD, step_index: 4 })).toBe(
      "agy:22222222-2222-4222-8222-222222222222:step:4",
    );
    expect(agyStepSourceId({ conversation_id: CHILD, step_index: 4 })).not.toBe(
      agyStepSourceId({ conversation_id: PARENT, step_index: 4 }),
    );
    expect(parentWait?.source_id).toBe("agy:" + PARENT);
    expect(childActivity?.source_id).toBe("agy:" + CHILD);
    expect((childActivity?.payload as { activity_id?: string }).activity_id).toBe(
      "agy:22222222-2222-4222-8222-222222222222:step:4",
    );
    expect((childActivity?.payload as { command?: string }).command).toContain(
      "agy-conversation-source.test.ts",
    );
  });

  it("does not invent a child from parent command output", () => {
    const events = decodeFixture("parent-command-mentions-child.jsonl");
    expect(events.some((event) => event.session_native_id === CHILD)).toBe(
      false,
    );
    expect(
      events.some((event) => event.session_native_id === OTHER),
    ).toBe(false);
    expect(
      events.filter((event) => event.kind === "discovered").map(
        (event) => event.session_native_id,
      ),
    ).toEqual([PARENT]);
    const activity = events.find((event) => event.kind === "activity");
    expect(activity?.session_native_id).toBe(PARENT);
    expect((activity?.payload as { command?: string }).command).toBe(
      "echo started",
    );
  });

  it("does not guess child identity from unreadable invoke_subagent output", () => {
    const events = decodeFixture("unread-delegate.jsonl");
    const unread = events.find(
      (event) =>
        event.kind === "discovered" &&
        (event.payload as { unread_reason?: string }).unread_reason,
    );
    expect(unread?.session_native_id).toBe(PARENT);
    expect((unread?.payload as { unread_fields?: string[] }).unread_fields).toContain(
      "ConversationId",
    );
    expect(events.some((event) => event.session_native_id !== PARENT)).toBe(
      false,
    );
  });

  it("reads child association only from public tool metadata of the identified step", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-assoc-"));
    writeStepDb(
      root,
      PARENT,
      4,
      toolPayload("invoke_subagent", {
        TypeName: "DeepCoder",
        Workspace: "inherit",
      }),
    );
    writeStepDb(
      root,
      OTHER,
      4,
      toolPayload("invoke_subagent", {
        TypeName: "ShouldNotScan",
        ConversationId: OTHER,
      }),
    );
    const outputDir = join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      PARENT,
      ".system_generated",
      "steps",
      "4",
    );
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "output.txt"),
      JSON.stringify({ ConversationId: CHILD }),
    );
    const source = new AgyNativeRecordSource(root);
    expect(
      source.readChildAssociation({ conversation_id: PARENT, step_index: 4 }),
    ).toMatchObject({
      parent_conversation_id: PARENT,
      parent_step_index: 4,
      child_conversation_id: CHILD,
      agent_native_id: "DeepCoder",
      unread_fields: [],
    });
    expect(
      source.readChildAssociation({ conversation_id: PARENT, step_index: 3 }),
    ).toBeUndefined();
    expect(
      source.readIdentifiedStep({ conversation_id: PARENT, step_index: 4 })?.name,
    ).toBe("invoke_subagent");
  });

  it("fails closed on encrypted metadata and does not treat parent output as child details", () => {
    const root = mkdtempSync(join(tmpdir(), "agy-unread-"));
    writeStepDb(root, PARENT, 8, Buffer.from([0xff, 0x00, 0x7e, 0x01]));
    const outputDir = join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      PARENT,
      ".system_generated",
      "steps",
      "8",
    );
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "output.txt"),
      "spawned child " + CHILD + " ran pnpm test\n",
    );
    const source = new AgyNativeRecordSource(root);
    const association = source.readChildAssociation({
      conversation_id: PARENT,
      step_index: 8,
    });
    expect(association?.child_conversation_id).toBeUndefined();
    expect(association?.unread_fields).toEqual(
      expect.arrayContaining(["call_id", "name", "parameters", "output"]),
    );
    expect(association?.unread_reason).toBe("unreadable_metadata");
    expect(tryDecodeAgyToolMetadata(Buffer.from([0xff])).ok).toBe(false);
    const fallbackDir = join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      OTHER,
      ".system_generated",
      "steps",
      "1",
    );
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(
      join(fallbackDir, "output.txt"),
      "The command exited with code 0.\nStdout:\nspawned " + CHILD + " pnpm test\n",
    );
    expect(
      source.readChildAssociation({ conversation_id: OTHER, step_index: 1 }),
    ).toBeUndefined();
    expect(source.read(OTHER, 1)?.name).toBe("run_command");
  });

  it("reads this Run stream without scanning other conversation databases", async () => {
    const root = mkdtempSync(join(tmpdir(), "agy-source-"));
    const streamPath = join(root, "parent-delegate.jsonl");
    writeFileSync(
      streamPath,
      readFileSync(join(fixtureDir, "parent-delegate.jsonl")),
    );
    writeStepDb(
      root,
      OTHER,
      1,
      toolPayload("invoke_subagent", { ConversationId: OTHER }),
    );
    const source = new AgyConversationSource({
      profileRoot: root,
      rootNativeId: PARENT,
      streamPath,
      cliVersion: "1.2.5",
    });
    const events = await source.readEvents({
      source_id: "agy:" + PARENT,
      source_seq: "0",
    });
    expect(source.capabilities().stop).toBe("owned-process-tree");
    expect(events.some((event) => event.session_native_id === CHILD)).toBe(
      true,
    );
    expect(events.some((event) => event.session_native_id === OTHER)).toBe(
      false,
    );
    expect(
      source.recordSource().readChildAssociation({
        conversation_id: PARENT,
        step_index: 4,
      }),
    ).toBeUndefined();
  });

  it("binds this Run log file only as a session argument", () => {
    const logFile = agyRunLogFile("C:/run-dir", "run-1");
    const args = agyArguments(
      "gemini-3.7-flash-high",
      "prompt",
      5,
      PARENT,
      undefined,
      "accept-edits",
      undefined,
      logFile,
    );
    expect(args[args.indexOf("--log-file") + 1]).toBe(logFile);
    expect(args[args.indexOf("--conversation") + 1]).toBe(PARENT);
    expect(agyArguments("model", "legacy", 5)).not.toContain("--log-file");
  });

  it("exposes adapter capabilities, decodeConversation and owned-process stop limits", async () => {
    const adapter = new AgyNativeCliAdapter({ cliVersion: "1.2.5" });
    expect(adapter.subagents).toMatchObject({
      discovery: "scoped-record",
      activity: "scoped-record",
      stop: "owned-process-tree",
      resume: "parent-instruction",
      readonly_delegation: "unknown",
      file_input: { text: false, image: false, binary: false },
      cli_version: "1.2.5",
    });
    expect(adapter.subagents.readonly_delegation).not.toBe(false);
    const streamed = adapter.decodeConversation({
      stream: "stdout",
      timestamp: "2026-09-20T00:00:00.000Z",
      runId: "run_agy",
      data: readFileSync(join(fixtureDir, "parent-delegate.jsonl"), "utf8"),
      final: true,
    });
    expect(streamed.some((event) => event.session_native_id === CHILD)).toBe(
      true,
    );
    adapter.bindConversationFile(
      join(fixtureDir, "parent-delegate.jsonl"),
      PARENT,
    );
    const recovered = await adapter.readConversationEvents({
      source_id: "agy:" + PARENT,
      source_seq: "0",
    });
    expect(recovered.some((event) => event.session_native_id === CHILD)).toBe(
      true,
    );
    const stopped = await adapter.stopConversation({
      conversation_id: CHILD,
    });
    expect(stopped.confirmation).toBe("owned_process_tree");
    expect(stopped.reason).toBe(AGY_PAUSE_ATTRIBUTION);
  });
});
