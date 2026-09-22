import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_EVENT,
  ConversationControlSchema,
  conversationActivityKey,
  unknownSubagentCapabilities,
  type ConversationControl,
  type ConversationNode,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import { CONVERSATION_SOURCE_LIMITS } from "../../packages/adapters/sdk/src/conversation-source.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import { ConversationObserver } from "../../packages/runtime/src/conversation-observer.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";

function openService() {
  const store = new Store(":memory:");
  return { store, service: new ConversationService(store) };
}

function ctx(
  extra: Partial<ConversationApplyContext> = {},
): ConversationApplyContext {
  return {
    project_id: "proj1",
    workflow_id: "wf1",
    run_id: "run1",
    adapter_id: "codex",
    scope: "profile-codex",
    lineage_id: "lineage-implement",
    purpose: "implement",
    root_native_id: "root-native",
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

function discoverRoot(
  service: ConversationService,
  context: ConversationApplyContext,
  seq = "1",
) {
  return service.applyEvent(
    context,
    event({
      source_seq: seq,
      session_native_id: context.root_native_id,
      payload: { title: "主会话", status: "running" },
    }),
  );
}

function jsonl(rows: unknown[]) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

describe("SA-U01 conversation identity and tree", () => {
  it("does not fold child discovery into a live-bound root conversation", () => {
    const { service } = openService();
    const base = ctx();
    const root = discoverRoot(service, base, "1").node!;
    base.conversation_id = root.id;
    service.applyEvent(
      base,
      event({
        source_seq: "2",
        session_native_id: "child-live",
        parent_native_id: "root-native",
        payload: { title: "explore", status: "running" },
      }),
    );
    const tree = service.getTree("wf1");
    const children = tree.nodes.filter((node) => node.kind === "subagent");
    expect(children).toHaveLength(1);
    expect(children[0]?.id).not.toBe(root.id);
    expect(children[0]?.parent_id).toBe(root.id);
    expect(children[0]?.native_session_id).toBe("child-live");
  });

  it("keeps spawn title when later activity events carry a tool title", () => {
    const { service } = openService();
    const base = ctx();
    const root = discoverRoot(service, base, "1").node!;
    base.conversation_id = root.id;
    service.applyEvent(
      base,
      event({
        source_seq: "2",
        session_native_id: "child-live",
        parent_native_id: "root-native",
        payload: {
          title: "running-agent",
          task_summary: "持续核对接口",
          status: "running",
        },
      }),
    );
    service.applyEvent(
      base,
      event({
        kind: "activity",
        source_seq: "3",
        session_native_id: "child-live",
        parent_native_id: "root-native",
        payload: {
          title: "模型输出",
          public_text: "子会话正在运行",
          status: "active",
        },
      }),
    );
    const child = service
      .getTree("wf1")
      .nodes.find((node) => node.kind === "subagent")!;
    expect(child.title).toBe("running-agent");
    expect(child.task_summary).toBe("持续核对接口");
    expect(
      service.getTree("wf1").attempts.find(
        (attempt) => attempt.conversation_id === child.id,
      )?.activity_summary,
    ).toBe("持续核对接口");
  });

  it("keeps same-title children and different adapters as distinct nodes", () => {
    const { service } = openService();
    const base = ctx();
    discoverRoot(service, base, "1");
    service.applyEvent(
      base,
      event({
        source_seq: "2",
        session_native_id: "child-a",
        parent_native_id: "root-native",
        payload: { title: "research", status: "running" },
      }),
    );
    service.applyEvent(
      base,
      event({
        source_seq: "3",
        session_native_id: "child-b",
        parent_native_id: "root-native",
        payload: { title: "research", status: "running" },
      }),
    );
    const other = ctx({ adapter_id: "agy", scope: "profile-agy", run_id: "run-agy" });
    service.applyEvent(
      other,
      event({
        source_id: "src-agy",
        source_seq: "1",
        session_native_id: "child-a",
        parent_native_id: "root-native",
        payload: { title: "research" },
      }),
    );
    const tree = service.getTree("wf1");
    const children = tree.nodes.filter((node) => node.kind === "subagent");
    expect(children).toHaveLength(3);
    expect(new Set(children.map((node) => node.id)).size).toBe(3);
    expect(children.filter((node) => node.title === "research")).toHaveLength(3);
    expect(children.filter((node) => node.adapter_id === "codex")).toHaveLength(2);
    expect(children.filter((node) => node.adapter_id === "agy")).toHaveLength(1);
  });

  it("builds a three-level tree and fills an unknown parent later", () => {
    const { service } = openService();
    const base = ctx();
    discoverRoot(service, base, "1");
    service.applyEvent(
      base,
      event({
        source_seq: "2",
        session_native_id: "grand",
        parent_native_id: "child-native",
        payload: { title: "grandchild", status: "running" },
      }),
    );
    let tree = service.getTree("wf1");
    const grand = tree.nodes.find((node) => node.native_session_id === "grand")!;
    expect(grand.parent_id).toBeUndefined();
    expect(grand.root_id).toBe(tree.active_root_id);
    expect(
      service.getDiagnostics().some((item) => item.code === "pending_parent"),
    ).toBe(true);
    service.applyEvent(
      base,
      event({
        source_seq: "3",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { title: "child", status: "running" },
      }),
    );
    tree = service.getTree("wf1");
    const child = tree.nodes.find((node) => node.native_session_id === "child-native")!;
    const linked = tree.nodes.find((node) => node.native_session_id === "grand")!;
    const root = tree.nodes.find((node) => node.id === node.root_id)!;
    expect(child.parent_id).toBe(root.id);
    expect(linked.parent_id).toBe(child.id);
    expect(linked.root_id).toBe(root.id);
    expect(service.readNode("wf1", linked.id).ancestors.map((n) => n.id)).toEqual([
      child.id,
      root.id,
    ]);
  });

  it("rejects self-reference, cross-root and cycle without stopping later events", () => {
    const { service } = openService();
    const first = ctx();
    discoverRoot(service, first, "1");
    const self = service.applyEvent(
      first,
      event({
        source_seq: "2",
        session_native_id: "loop-child",
        parent_native_id: "loop-child",
        payload: { title: "self" },
      }),
    );
    expect(self.diagnostics.some((item) => item.code === "self_reference")).toBe(
      true,
    );
    expect(self.node?.parent_id).toBeUndefined();
    service.applyEvent(
      first,
      event({
        source_seq: "3",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { title: "child" },
      }),
    );
    const other = ctx({
      lineage_id: "lineage-review",
      purpose: "quality_review",
      run_id: "run-review",
      root_native_id: "review-root",
    });
    discoverRoot(service, other, "10");
    const tree = service.getTree("wf1");
    const child = tree.nodes.find((node) => node.native_session_id === "child-native")!;
    const reviewRoot = tree.nodes.find(
      (node) => node.native_session_id === "review-root",
    )!;
    const cross = service.applyEvent(
      first,
      event({
        source_seq: "4",
        session_native_id: "child-native",
        parent_native_id: "review-root",
        payload: { title: "child" },
      }),
    );
    expect(cross.diagnostics.some((item) => item.code === "cross_root")).toBe(
      true,
    );
    expect(service.readNode("wf1", child.id).node.parent_id).not.toBe(
      reviewRoot.id,
    );
    service.applyEvent(
      first,
      event({
        source_seq: "5",
        session_native_id: "grand",
        parent_native_id: "child-native",
        payload: { title: "grand" },
      }),
    );
    const cycled = service.applyEvent(
      first,
      event({
        source_seq: "6",
        session_native_id: "child-native",
        parent_native_id: "grand",
        payload: { title: "child" },
      }),
    );
    expect(cycled.diagnostics.some((item) => item.code === "cycle")).toBe(true);
    const after = service.readNode("wf1", child.id).node;
    expect(after.parent_id).toBe(tree.active_root_id);
    const later = service.applyEvent(
      first,
      event({
        kind: "activity",
        source_seq: "7",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { activity_id: "still-working", public_text: "继续" },
      }),
    );
    expect(later.skipped).toBe(false);
    expect(later.node?.id).toBe(child.id);
  });

  it("fills spawn_call_id nodes with later native ids instead of creating a second row", () => {
    const { service } = openService();
    const base = ctx();
    discoverRoot(service, base, "1");
    const spawned = service.applyEvent(
      base,
      event({
        source_seq: "2",
        parent_native_id: "root-native",
        payload: { spawn_call_id: "call-1", title: "spawned" },
      }),
    ).node!;
    expect(spawned.native_session_id).toBeUndefined();
    const filled = service.applyEvent(
      base,
      event({
        source_seq: "3",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { spawn_call_id: "call-1", title: "spawned" },
      }),
    ).node!;
    expect(filled.id).toBe(spawned.id);
    expect(filled.native_session_id).toBe("child-native");
    expect(
      service.getTree("wf1").nodes.filter((node) => node.spawn_call_id === "call-1"),
    ).toHaveLength(1);
  });
});

describe("SA-U06 activity keys and child isolation", () => {
  it("does not let root and child share activity or step identity", () => {
    const { store, service } = openService();
    const base = ctx();
    const root = discoverRoot(service, base, "1").node!;
    const child = service.applyEvent(
      base,
      event({
        source_seq: "2",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { title: "child", status: "running" },
      }),
    ).node!;
    service.applyEvent(
      base,
      event({
        kind: "activity",
        source_seq: "3",
        session_native_id: "root-native",
        payload: {
          activity_id: "dup",
          step_index: 0,
          public_text: "root-work",
          command: "echo root",
        },
      }),
    );
    service.applyEvent(
      base,
      event({
        kind: "activity",
        source_seq: "4",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: {
          activity_id: "dup",
          step_index: 0,
          public_text: "child-work",
          command: "echo child",
        },
      }),
    );
    const rootPage = service.listActivities("wf1", root.id);
    const childPage = service.listActivities("wf1", child.id);
    expect(rootPage.items).toHaveLength(1);
    expect(childPage.items).toHaveLength(1);
    const rootPayload = rootPage.items[0]!.payload as { activity_id: string; public_text: string };
    const childPayload = childPage.items[0]!.payload as {
      activity_id: string;
      public_text: string;
      attempt_id: string;
    };
    expect(rootPayload.public_text).toBe("root-work");
    expect(childPayload.public_text).toBe("child-work");
    expect(
      conversationActivityKey(root.id, root.current_attempt_id!, "dup"),
    ).not.toBe(
      conversationActivityKey(child.id, child.current_attempt_id!, "dup"),
    );
    expect(store.conversationNodesByRoot<ConversationNode>(root.id).length).toBeGreaterThan(1);
  });

  it("does not copy child model, session or quota onto the root", () => {
    const { service } = openService();
    const base = ctx();
    const rootId = discoverRoot(service, base, "1").node!.id;
    service.applyEvent(
      base,
      event({
        kind: "model",
        source_seq: "2",
        session_native_id: "root-native",
        payload: {
          actual_model: "gpt-root",
          requested_model: "gpt-root",
          actual_effort: "high",
          model_source: "native_event",
        },
      }),
    );
    service.applyEvent(
      base,
      event({
        source_seq: "3",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { title: "child" },
      }),
    );
    service.applyEvent(
      base,
      event({
        kind: "model",
        source_seq: "4",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: {
          actual_model: "gpt-child",
          requested_model: "gpt-child",
          actual_effort: "low",
          model_source: "native_session",
        },
      }),
    );
    service.applyEvent(
      base,
      event({
        kind: "quota",
        source_seq: "5",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { used_percent: 90 },
      }),
    );
    const tree = service.getTree("wf1");
    const root = tree.nodes.find((node) => node.id === rootId)!;
    const child = tree.nodes.find((node) => node.native_session_id === "child-native")!;
    const rootAttempt = tree.attempts.find(
      (item) => item.id === root.current_attempt_id,
    )!;
    const childAttempt = tree.attempts.find(
      (item) => item.id === child.current_attempt_id,
    )!;
    expect(root.native_session_id).toBe("root-native");
    expect(child.native_session_id).toBe("child-native");
    expect(rootAttempt.actual_model).toBe("gpt-root");
    expect(rootAttempt.actual_effort).toBe("high");
    expect(childAttempt.actual_model).toBe("gpt-child");
    expect(childAttempt.actual_effort).toBe("low");
  });
});

describe("SA-U07 ordering, terminal lock and attempts", () => {
  it("skips duplicates and older seq, and does not revive a completed attempt", () => {
    const { store, service } = openService();
    const base = ctx();
    discoverRoot(service, base, "10");
    const first = service.applyEvent(
      base,
      event({
        kind: "state",
        source_seq: "11",
        session_native_id: "root-native",
        payload: { status: "completed" },
      }),
    );
    const replay = service.applyEvent(
      base,
      event({
        kind: "state",
        source_seq: "11",
        session_native_id: "root-native",
        payload: { status: "completed" },
      }),
    );
    expect(replay.skipped).toBe(true);
    const late = service.applyEvent(
      base,
      event({
        kind: "state",
        source_seq: "12",
        session_native_id: "root-native",
        payload: { status: "running" },
      }),
    );
    expect(late.attempt?.status).toBe("completed");
    expect(late.attempt?.id).toBe(first.attempt?.id);
    const older = service.applyEvent(
      base,
      event({
        kind: "activity",
        source_seq: "9",
        session_native_id: "root-native",
        payload: { activity_id: "late", public_text: "乱序" },
      }),
    );
    expect(older.skipped).toBe(true);
    expect(store.eventCursor("wf1")).toBe(service.getTree("wf1").cursor);
  });

  it("needs a new attempt before running again after a terminal status", () => {
    const { service } = openService();
    const first = ctx();
    discoverRoot(service, first, "1");
    service.applyEvent(
      first,
      event({
        kind: "state",
        source_seq: "2",
        session_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    const sameRun = service.applyEvent(
      first,
      event({
        kind: "state",
        source_seq: "3",
        session_native_id: "root-native",
        payload: { status: "running" },
      }),
    );
    expect(sameRun.attempt?.status).toBe("interrupted");
    const resumed = ctx({ run_id: "run2" });
    const next = service.applyEvent(
      resumed,
      event({
        source_id: "src-2",
        source_seq: "1",
        session_native_id: "root-native",
        payload: { title: "主会话", status: "starting" },
      }),
    );
    expect(next.attempt?.run_id).toBe("run2");
    expect(next.attempt?.generation).toBe(1);
    expect(next.attempt?.status).toBe("starting");
    expect(next.node?.id).toBe(sameRun.node?.id);
    const running = service.applyEvent(
      resumed,
      event({
        kind: "state",
        source_id: "src-2",
        source_seq: "2",
        session_native_id: "root-native",
        payload: { status: "running" },
      }),
    );
    expect(running.attempt?.status).toBe("running");
    expect(running.attempt?.id).toBe(next.attempt?.id);
  });
});

describe("SA-U08 source cursor and trusted reads", () => {
  it("does not replay on reread, truncation or rotation", async () => {
    const { service } = openService();
    const base = ctx();
    const dir = mkdtempSync(join(tmpdir(), "conv-src-"));
    const file = join(dir, "session.jsonl");
    const rows = [
      {
        kind: "discovered",
        source_id: "file-1",
        source_seq: "0",
        root_native_id: "root-native",
        session_native_id: "root-native",
        payload: { title: "主会话", status: "running" },
      },
      {
        kind: "activity",
        source_id: "file-1",
        source_seq: "1",
        root_native_id: "root-native",
        session_native_id: "root-native",
        payload: { activity_id: "a1", public_text: "first" },
      },
    ];
    writeFileSync(file, jsonl(rows));
    const observer = new ConversationObserver({ service, context: base });
    observer.addSource({
      source_id: "file-1",
      adapter_id: "codex",
      file_path: file,
      trusted_root: dir,
    });
    await observer.poll();
    const afterFirst = service.getTree("wf1");
    const activityCount = () =>
      service.listActivities("wf1", afterFirst.active_root_id!).items.length;
    expect(activityCount()).toBe(1);
    await observer.poll();
    expect(activityCount()).toBe(1);
    writeFileSync(file, jsonl(rows.slice(0, 1)));
    await observer.poll();
    expect(activityCount()).toBe(1);
    renameSync(file, file + ".old");
    writeFileSync(file, jsonl(rows));
    await observer.poll();
    expect(activityCount()).toBe(1);
    await observer.stop();
  });

  it("skips over-long lines, malicious paths and unattributed sources", async () => {
    const { service } = openService();
    const base = ctx();
    const dir = mkdtempSync(join(tmpdir(), "conv-src-"));
    const file = join(dir, "session.jsonl");
    const outsideDir = mkdtempSync(join(tmpdir(), "conv-out-"));
    const outside = join(outsideDir, "secret.jsonl");
    writeFileSync(
      file,
      "x".repeat(300) +
        "\n" +
        JSON.stringify({
          kind: "discovered",
          source_id: "file-2",
          root_native_id: "root-native",
          session_native_id: "root-native",
          payload: { title: "主会话" },
        }) +
        "\n" +
        JSON.stringify({ hello: "no-identity" }) +
        "\n",
    );
    writeFileSync(outside, jsonl([{ kind: "activity", payload: { public_text: "leak" } }]));
    const observer = new ConversationObserver({
      service,
      context: base,
      maxBytesPerRound: 1024,
      maxLineBytes: 200,
    });
    observer.addSource({
      source_id: "file-2",
      adapter_id: "codex",
      file_path: file,
      trusted_root: dir,
    });
    observer.addSource({
      source_id: "evil",
      adapter_id: "codex",
      file_path: join(dir, "..", "escape.jsonl"),
      trusted_root: dir,
    });
    observer.addSource({
      source_id: "abs",
      adapter_id: "codex",
      file_path: outside,
      trusted_root: dir,
    });
    await observer.poll();
    const tree = service.getTree("wf1");
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.native_session_id).toBe("root-native");
    const codes = observer.getDiagnostics().map((item) => item.code);
    expect(codes).toContain("truncated_line");
    expect(codes).toContain("untrusted_path");
    expect(codes).toContain("unattributed_source");
    expect(existsSync(outside)).toBe(true);
    expect(CONVERSATION_SOURCE_LIMITS.maxBytesPerRound).toBe(1024 * 1024);
    expect(CONVERSATION_SOURCE_LIMITS.maxLineBytes).toBe(4 * 1024 * 1024);
    expect(CONVERSATION_SOURCE_LIMITS.maxParallelReads).toBe(4);
    expect(CONVERSATION_SOURCE_LIMITS.pollIntervalMs).toBe(2000);
    await observer.stop();
  });
});

describe("SA-U09 lineage continuation and new roots", () => {
  it("reuses the same root across runs and isolates a new role root from old control", () => {
    const { store, service } = openService();
    const first = ctx();
    const root = discoverRoot(service, first, "1").node!;
    store.put(
      CONVERSATION_ENTITY.control,
      "ctl-old",
      "wf1",
      ConversationControlSchema.parse({
        id: "ctl-old",
        workflow_id: "wf1",
        request_id: "pause-1",
        action: "pause",
        root_id: root.id,
        expected_generation: 0,
        status: "complete",
        created_at: "2026-09-20T00:00:00.000Z",
        updated_at: "2026-09-20T00:00:00.000Z",
      }),
    );
    const continued = service.applyEvent(
      ctx({ run_id: "run2" }),
      event({
        source_id: "src-2",
        source_seq: "1",
        session_native_id: "root-native",
        payload: { title: "主会话", status: "starting" },
      }),
    );
    expect(continued.node?.id).toBe(root.id);
    expect(continued.attempt?.generation).toBe(1);
    expect(continued.attempt?.run_id).toBe("run2");
    const review = ctx({
      run_id: "run-review",
      lineage_id: "lineage-review",
      purpose: "quality_review",
      root_native_id: "review-native",
    });
    const newRoot = discoverRoot(service, review, "1").node!;
    expect(newRoot.id).not.toBe(root.id);
    const tree = service.getTree("wf1");
    expect(tree.nodes.filter((node) => node.id === node.root_id)).toHaveLength(2);
    expect(tree.nodes.some((node) => node.id === root.id)).toBe(true);
    const control = store.get<ConversationControl>(
      CONVERSATION_ENTITY.control,
      "ctl-old",
    );
    expect(control?.root_id).toBe(root.id);
    expect(control?.root_id).not.toBe(newRoot.id);
    expect(
      tree.attempts.filter((item) => item.conversation_id === root.id),
    ).toHaveLength(2);
  });

  it("creates a replacement node without deleting the old root", () => {
    const { service } = openService();
    const first = ctx();
    const old = discoverRoot(service, first, "1").node!;
    const replaced = service.applyEvent(
      ctx({ run_id: "run-recreate", root_native_id: "root-native-2" }),
      event({
        source_id: "src-recreate",
        source_seq: "1",
        root_native_id: "root-native-2",
        session_native_id: "root-native-2",
        payload: {
          title: "主会话",
          status: "starting",
          replaces_conversation_id: old.id,
        },
      }),
    ).node!;
    expect(replaced.id).not.toBe(old.id);
    expect(replaced.replaces_conversation_id).toBe(old.id);
    const tree = service.getTree("wf1");
    expect(tree.nodes.some((node) => node.id === old.id)).toBe(true);
    expect(tree.nodes.some((node) => node.id === replaced.id)).toBe(true);
  });

  it("projects a read-only legacy root and does not invent children", () => {
    const { store, service } = openService();
    const workflow: Workflow = {
      id: "wf-old",
      project_id: "proj1",
      title: "旧任务",
      request: "r",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "COMPLETED",
      stage: "execute",
      version: 1,
      plan_revision: 1,
      environment_revision: 0,
      run_id: "run-old",
      feedback: [],
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    };
    const run: Run = {
      id: "run-old",
      workflow_id: "wf-old",
      plan_revision: 1,
      adapter: "agy",
      purpose: "implement",
      stage: "execute",
      status: "completed",
      conversation_id: "native-old",
      started_at: "2026-09-01T00:00:00.000Z",
      ended_at: "2026-09-01T01:00:00.000Z",
      package_hash: "pkg",
    };
    store.put("workflow", workflow.id, workflow.project_id, workflow);
    store.put("run", run.id, workflow.id, run);
    const tree = service.getTree("wf-old");
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.kind).toBe("main");
    expect(tree.nodes[0]?.native_session_id).toBe("native-old");
    expect(tree.nodes.filter((node) => node.kind === "subagent")).toHaveLength(0);
    expect(tree.capabilities).toEqual(unknownSubagentCapabilities("历史未记录子会话"));
    expect(store.list<ConversationNode>(CONVERSATION_ENTITY.node, "wf-old")).toHaveLength(
      0,
    );
  });
});

describe("conversation activity paging", () => {
  it("pages ConversationActivity by conversation and seq", () => {
    const { store, service } = openService();
    const base = ctx();
    const root = discoverRoot(service, base, "1").node!;
    for (let i = 0; i < 3; i++) {
      service.applyEvent(
        base,
        event({
          kind: "activity",
          source_seq: String(10 + i),
          session_native_id: "root-native",
          payload: { activity_id: `a${i}`, public_text: `n${i}` },
        }),
      );
    }
    service.applyEvent(
      base,
      event({
        source_seq: "20",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { title: "child" },
      }),
    );
    service.applyEvent(
      base,
      event({
        kind: "activity",
        source_seq: "21",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { activity_id: "child-a", public_text: "child" },
      }),
    );
    const page = store.conversationActivities("wf1", root.id, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.items.every((item) => item.type === CONVERSATION_EVENT.activity)).toBe(
      true,
    );
    const older = store.conversationActivities("wf1", root.id, {
      limit: 2,
      before_seq: page.next_before_seq,
    });
    expect(older.items).toHaveLength(1);
    expect(older.has_more).toBe(false);
    const child = service
      .getTree("wf1")
      .nodes.find((node) => node.native_session_id === "child-native")!;
    expect(store.conversationActivities("wf1", child.id).items).toHaveLength(1);
  });
});
