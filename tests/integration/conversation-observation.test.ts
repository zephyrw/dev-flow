import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "../helpers.js";
import {
  CONVERSATION_ENTITY,
  type ConversationAttempt,
  type ConversationNode,
  type Run,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import type { ConversationRecordSource } from "../../packages/adapters/sdk/src/conversation-source.js";
import type { SubagentCapabilities } from "../../packages/contracts/src/conversation.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import { ConversationObserver } from "../../packages/runtime/src/conversation-observer.js";
import { Store } from "../../packages/store/src/store.js";
import { CodexNativeAdapter } from "../../packages/adapters/codex/src/adapter.js";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import { decodeAgyConversationEvents } from "../../packages/adapters/agy/src/conversation-source.js";
import { loadConversationJsonl } from "../fixtures/conversations/load.js";
import { now } from "../../packages/core/src/util.js";

const opened: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) {
    try {
      item.close();
    } catch {}
  }
});

class OnceRecordSource implements ConversationRecordSource {
  adapterId: string;
  private sent = false;
  constructor(
    adapterId: string,
    private events: NativeConversationEvent[],
    private caps: SubagentCapabilities,
  ) {
    this.adapterId = adapterId;
  }
  capabilities() {
    return this.caps;
  }
  async readEvents() {
    if (this.sent) return [];
    this.sent = true;
    return this.events;
  }
}

function putWorkflow(store: Store, workflowId: string, runId: string) {
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: workflowId,
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 0,
    environment_revision: 0,
    run_id: runId,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  const run: Run = {
    id: runId,
    workflow_id: workflowId,
    plan_revision: 0,
    adapter: "codex",
    purpose: "implement",
    stage: "exec",
    status: "running",
    started_at: "2026-09-20T00:00:00.000Z",
    package_hash: "pkg",
  };
  store.put("workflow", workflowId, "p1", workflow);
  store.put("run", runId, workflowId, run);
}

function ctx(
  extra: Partial<ConversationApplyContext> = {},
): ConversationApplyContext {
  return {
    project_id: "p1",
    workflow_id: extra.workflow_id ?? "wf1",
    run_id: extra.run_id ?? "run1",
    adapter_id: extra.adapter_id ?? "codex",
    scope: extra.scope ?? "profile-codex",
    lineage_id: extra.lineage_id ?? "lineage-implement",
    purpose: extra.purpose ?? "implement",
    root_native_id: extra.root_native_id ?? "root-native",
    ...extra,
  };
}

function event(
  extra: Partial<NativeConversationEvent> & {
    payload?: Record<string, unknown>;
  },
): NativeConversationEvent {
  return {
    source_id: extra.source_id ?? "src-1",
    source_seq: extra.source_seq ?? "1",
    root_native_id: extra.root_native_id ?? "root-native",
    session_native_id: extra.session_native_id,
    agent_native_id: extra.agent_native_id,
    parent_native_id: extra.parent_native_id,
    kind: extra.kind ?? "discovered",
    occurred_at: extra.occurred_at,
    payload: extra.payload ?? {},
  };
}

function decodeAdapterJsonl(
  adapter: { decodeConversation: (chunk: { stream: "stdout"; data: string; timestamp: string; runId: string; final?: boolean }) => NativeConversationEvent[] },
  fixtureAdapter: string,
  fileName: string,
  runId: string,
) {
  const events: NativeConversationEvent[] = [];
  for (const record of loadConversationJsonl(fixtureAdapter, fileName)) {
    events.push(
      ...adapter.decodeConversation({
        stream: "stdout",
        data: JSON.stringify(record) + "\n",
        timestamp: "2026-09-20T00:00:00.000Z",
        runId,
      }),
    );
  }
  return events;
}

function openWorld(workflowId = "wf1", runId = "run1") {
  const s = setup();
  putWorkflow(s.store, workflowId, runId);
  const conversations = new ConversationService(s.store);
  opened.push({ close: () => s.store.close() });
  return { s, conversations };
}

function snapshotShape(tree: ReturnType<ConversationService["getTree"]>) {
  return {
    active_root_id: tree.active_root_id,
    cursor: tree.cursor,
    nodes: tree.nodes
      .map((node) => ({
        id: node.id,
        kind: node.kind,
        native_session_id: node.native_session_id,
        parent_id: node.parent_id,
        root_id: node.root_id,
        title: node.title,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    attempts: tree.attempts
      .map((attempt) => ({
        id: attempt.id,
        conversation_id: attempt.conversation_id,
        generation: attempt.generation,
        status: attempt.status,
        actual_model: attempt.actual_model,
        actual_effort: attempt.actual_effort,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

describe("SA-I01 adapter observation into SQLite", () => {
  it("routes adapter events through observer into a consistent tree and cursor", async () => {
    const { s, conversations } = openWorld();
    const adapter = new CodexNativeAdapter({ cliVersion: "0.50.0" });
    const decoded = decodeAdapterJsonl(adapter, "codex", "create.jsonl", "run1");
    expect(decoded.some((item) => item.kind === "discovered")).toBe(true);
    const observer = new ConversationObserver({
      service: conversations,
      context: ctx({
        root_native_id:
          decoded.find((item) => item.kind === "discovered")?.root_native_id ??
          "root-native",
      }),
    });
    observer.addSource({
      source_id: "codex:create",
      adapter_id: "codex",
      record_source: new OnceRecordSource(
        "codex",
        decoded,
        adapter.subagents,
      ),
    });
    await observer.poll();
    const tree = conversations.getTree("wf1");
    expect(tree.nodes.length).toBeGreaterThan(0);
    expect(tree.cursor).toBe(s.store.eventCursor("wf1"));
    expect(tree.active_root_id).toBeTruthy();
    const child = tree.nodes.find((node) => node.kind === "subagent");
    expect(child).toBeTruthy();
    expect(child?.parent_id).toBe(tree.active_root_id);
    const first = snapshotShape(tree);
    await observer.poll();
    expect(snapshotShape(conversations.getTree("wf1"))).toEqual(first);
    await observer.stop();
  });

  it("rebuilds the same tree and cursor from the sqlite file", async () => {
    const { s, conversations } = openWorld();
    const adapter = new CodexNativeAdapter({ cliVersion: "0.50.0" });
    const decoded = decodeAdapterJsonl(adapter, "codex", "nested.jsonl", "run1");
    const observer = new ConversationObserver({
      service: conversations,
      context: ctx({
        root_native_id: decoded[0]?.root_native_id ?? "root-native",
      }),
    });
    observer.addSource({
      source_id: "codex:nested",
      adapter_id: "codex",
      record_source: new OnceRecordSource(
        "codex",
        decoded,
        adapter.subagents,
      ),
    });
    await observer.poll();
    const before = snapshotShape(conversations.getTree("wf1"));
    expect(before.nodes.length).toBeGreaterThan(1);
    const sqliteFile = s.config.storage_root
      ? join(s.config.storage_root, "devflow.sqlite")
      : s.store.file;
    await observer.stop();
    s.store.close();
    const reopened = new Store(sqliteFile);
    opened.push({ close: () => reopened.close() });
    const rebuilt = new ConversationService(reopened);
    expect(snapshotShape(rebuilt.getTree("wf1"))).toEqual(before);
    expect(reopened.eventCursor("wf1")).toBe(before.cursor);
  });
});

describe("SA-I02 parent and child activity isolation", () => {
  it("keeps concurrent duplicate steps queryable without polluting the root", async () => {
    const { s, conversations } = openWorld();
    const dir = join(s.root, "conv-src");
    mkdirSync(dir, { recursive: true });
    const rootFile = join(dir, "root.jsonl");
    const childFile = join(dir, "child.jsonl");
    const rows = (session: string, parent?: string) => [
      {
        kind: "discovered",
        source_id: `file-${session}`,
        source_seq: "0",
        root_native_id: "root-native",
        session_native_id: session,
        parent_native_id: parent,
        payload: {
          title: session === "root-native" ? "主会话" : "子 Agent",
          status: "running",
        },
      },
      {
        kind: "activity",
        source_id: `file-${session}`,
        source_seq: "1",
        root_native_id: "root-native",
        session_native_id: session,
        parent_native_id: parent,
        payload: {
          activity_id: "dup",
          step_index: 0,
          public_text: `${session}-work`,
          command: `echo ${session}`,
        },
      },
      {
        kind: "model",
        source_id: `file-${session}`,
        source_seq: "2",
        root_native_id: "root-native",
        session_native_id: session,
        parent_native_id: parent,
        payload: {
          actual_model: session === "root-native" ? "gpt-root" : "gpt-child",
          actual_effort: session === "root-native" ? "high" : "low",
        },
      },
    ];
    writeFileSync(
      rootFile,
      rows("root-native").map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    writeFileSync(
      childFile,
      rows("child-native", "root-native")
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const observer = new ConversationObserver({
      service: conversations,
      context: ctx(),
      maxParallelReads: 2,
    });
    observer.addSource({
      source_id: "file-root-native",
      adapter_id: "codex",
      file_path: rootFile,
      trusted_root: dir,
    });
    observer.addSource({
      source_id: "file-child-native",
      adapter_id: "codex",
      file_path: childFile,
      trusted_root: dir,
    });
    await observer.poll();
    const tree = conversations.getTree("wf1");
    const root = tree.nodes.find((node) => node.kind === "main")!;
    const child = tree.nodes.find((node) => node.kind === "subagent")!;
    expect(root.native_session_id).toBe("root-native");
    expect(child.native_session_id).toBe("child-native");
    const rootPage = conversations.listActivities("wf1", root.id);
    const childPage = conversations.listActivities("wf1", child.id);
    expect(rootPage.items).toHaveLength(1);
    expect(childPage.items).toHaveLength(1);
    expect(
      (rootPage.items[0]!.payload as { public_text: string }).public_text,
    ).toBe("root-native-work");
    expect(
      (childPage.items[0]!.payload as { public_text: string }).public_text,
    ).toBe("child-native-work");
    const rootAttempt = tree.attempts.find(
      (item) => item.id === root.current_attempt_id,
    )!;
    const childAttempt = tree.attempts.find(
      (item) => item.id === child.current_attempt_id,
    )!;
    expect(rootAttempt.actual_model).toBe("gpt-root");
    expect(childAttempt.actual_model).toBe("gpt-child");
    expect(rootAttempt.actual_effort).toBe("high");
    expect(s.store.list<ConversationNode>(CONVERSATION_ENTITY.node, "wf1")).toHaveLength(
      2,
    );
    await observer.stop();
  });

  it("covers the legacy agy parent and child record path", async () => {
    const { conversations } = openWorld();
    const adapter = new AgyNativeCliAdapter();
    const parentId = "11111111-1111-4111-8111-111111111111";
    const parentEvents = decodeAgyConversationEvents(
      loadConversationJsonl("agy", "parent-delegate.jsonl"),
      { rootNativeId: parentId },
    );
    const childEvents = decodeAgyConversationEvents(
      loadConversationJsonl("agy", "child-steps.jsonl"),
      { rootNativeId: parentId },
    );
    expect(parentEvents.length).toBeGreaterThan(0);
    expect(childEvents.some((item) => item.session_native_id !== parentId)).toBe(
      true,
    );
    const agyCtx = ctx({
      adapter_id: "agy",
      scope: "profile-agy",
      lineage_id: "lineage-agy",
      root_native_id: parentId,
    });
    const observer = new ConversationObserver({
      service: conversations,
      context: agyCtx,
    });
    observer.addSource({
      source_id: "agy:parent",
      adapter_id: "agy",
      record_source: new OnceRecordSource(
        "agy",
        [...parentEvents, ...childEvents],
        adapter.subagents ?? {
          discovery: "scoped-record",
          activity: "scoped-record",
          stop: "owned-process-tree",
          resume: "parent-instruction",
          readonly_delegation: "unknown",
          file_input: { text: false, image: false, binary: false },
        },
      ),
    });
    await observer.poll();
    const tree = conversations.getTree("wf1");
    const root = tree.nodes.find((node) => node.kind === "main");
    const child = tree.nodes.find((node) => node.kind === "subagent");
    expect(root).toBeTruthy();
    expect(child).toBeTruthy();
    expect(child?.parent_id).toBe(root?.id);
    const rootActivities = conversations.listActivities("wf1", root!.id);
    const childActivities = conversations.listActivities("wf1", child!.id);
    expect(
      childActivities.items.some((item) =>
        JSON.stringify(item.payload).includes("vitest"),
      ),
    ).toBe(true);
    expect(
      rootActivities.items.some((item) =>
        JSON.stringify(item.payload).includes("vitest"),
      ),
    ).toBe(false);
    const rootAttempt = tree.attempts.find(
      (item) => item.conversation_id === root!.id,
    ) as ConversationAttempt;
    expect(rootAttempt.actual_model ?? "").not.toMatch(/child/i);
    expect(adapter.subagents?.readonly_delegation).toBe("unknown");
    expect(adapter.subagents?.readonly_delegation).not.toBe("unsupported");
    await observer.stop();
  });
});
