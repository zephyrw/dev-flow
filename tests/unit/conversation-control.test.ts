import { describe, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  type Run,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import {
  CONVERSATION_CONTROL_FENCE,
  ConversationControlService,
  PAUSE_HINT_MS,
  PAUSE_PARTIAL_MS,
  pausePendingMessage,
  type ConversationControlClock,
  type ConversationControlFence,
  type StopPort,
  type StopPortResult,
  type StopPortTarget,
} from "../../packages/core/src/conversation-control.js";

class FakeClock implements ConversationControlClock {
  current = Date.parse("2026-09-20T00:00:00.000Z");
  iso() {
    return new Date(this.current).toISOString();
  }
  ms() {
    return this.current;
  }
  advance(ms: number) {
    this.current += ms;
  }
}

class RecordingStopPort implements StopPort {
  calls: StopPortTarget[] = [];
  results = new Map<string, StopPortResult>();
  defaultResult: StopPortResult = { accepted: true, confirmation: "exited" };
  async stopConversation(target: StopPortTarget): Promise<StopPortResult> {
    this.calls.push({ ...target });
    return this.results.get(target.conversation_id) ?? this.defaultResult;
  }
}

function openControl(port?: RecordingStopPort, clock?: FakeClock) {
  const store = new Store(":memory:");
  const conversations = new ConversationService(store);
  const stop = port ?? new RecordingStopPort();
  const time = clock ?? new FakeClock();
  const controls = new ConversationControlService(
    store,
    conversations,
    stop,
    time,
  );
  putWorkflow(store, "wf1", "EXECUTING", "run1");
  return { store, conversations, controls, stop, time };
}

function putWorkflow(
  store: Store,
  workflowId: string,
  state: Workflow["state"],
  runId: string,
) {
  const workflow: Workflow = {
    id: workflowId,
    project_id: "proj1",
    title: "控制测试",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state,
    stage: "exec",
    version: 1,
    plan_revision: 0,
    environment_revision: 0,
    run_id: runId,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
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
    continuation: {
      kind: "runtime_resume",
      source_run_id: runId,
      purpose: "execute",
      role: "executor",
      phase: "exec",
    },
  };
  store.put("workflow", workflowId, "proj1", workflow);
  store.put("run", runId, workflowId, run);
}

function ctx(
  extra: Partial<ConversationApplyContext> = {},
): ConversationApplyContext {
  return {
    project_id: "proj1",
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

function discoverRoot(
  service: ConversationService,
  context: ConversationApplyContext = ctx(),
  seq = "1",
) {
  return service.applyEvent(
    context,
    event({
      source_id: `src-${context.run_id}`,
      source_seq: seq,
      root_native_id: context.root_native_id,
      session_native_id: context.root_native_id,
      payload: { title: "主会话", status: "running" },
    }),
  ).node!;
}

function spawnChild(
  service: ConversationService,
  nativeId: string,
  parentNativeId: string,
  seq: string,
  status = "running",
  extra: Partial<ConversationApplyContext> = {},
) {
  const context = ctx(extra);
  return service.applyEvent(
    context,
    event({
      source_id: `src-${context.run_id}`,
      source_seq: seq,
      root_native_id: context.root_native_id,
      session_native_id: nativeId,
      parent_native_id: parentNativeId,
      payload: { title: nativeId, status },
    }),
  ).node!;
}

function latestStatus(
  conversations: ConversationService,
  conversationId: string,
  workflowId = "wf1",
) {
  const tree = conversations.getTree(workflowId);
  return tree.attempts
    .filter((item) => item.conversation_id === conversationId)
    .sort((a, b) => a.generation - b.generation)
    .at(-1);
}

describe("SA-U19 conversation control pause intent", () => {
  it("excludes completed and cancelled from recovery and keeps interrupted quota plus nested parent", async () => {
    const { conversations, controls } = openControl();
    const root = discoverRoot(conversations);
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    spawnChild(conversations, "done-native", "root-native", "3", "completed");
    spawnChild(conversations, "cancel-native", "root-native", "4", "cancelled");
    spawnChild(
      conversations,
      "quota-native",
      "root-native",
      "5",
      "interrupted",
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "6",
        session_native_id: "quota-native",
        parent_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    const grand = spawnChild(
      conversations,
      "grand-native",
      "child-native",
      "7",
    );
    await controls.pauseTree("wf1", {
      request_id: "pause-recovery",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    const recovery = controls.listRecoveryCandidates("wf1", root.id);
    const ids = recovery.map((item) => item.conversation_id);
    expect(ids).toContain(root.id);
    expect(ids).toContain(child.id);
    expect(ids).toContain(grand.id);
    const tree = conversations.getTree("wf1");
    expect(ids).not.toContain(
      tree.nodes.find((node) => node.native_session_id === "done-native")?.id,
    );
    expect(ids).not.toContain(
      tree.nodes.find((node) => node.native_session_id === "cancel-native")?.id,
    );
    const quota = recovery.find(
      (item) => item.native_session_id === "quota-native",
    );
    expect(quota?.status).toBe("interrupted");
    expect(quota?.reason).toBe("quota");
    expect(
      recovery.find((item) => item.conversation_id === grand.id)?.parent_id,
    ).toBe(child.id);
  });

  it("is idempotent for the same request_id and cancels model retry", async () => {
    const { store, conversations, controls, stop } = openControl();
    const root = discoverRoot(conversations);
    store.put("model_retry", "wf1", "wf1", {
      id: "wf1",
      run_id: "run1",
      plan_revision: 0,
      retry_at: Date.now() + 60_000,
    });
    const request = {
      request_id: "pause-once",
      action: "pause" as const,
      root_id: root.id,
      expected_generation: 0,
    };
    const first = await controls.pauseTree("wf1", request);
    const second = await controls.pauseTree("wf1", request);
    expect(second.control_id).toBe(first.control_id);
    expect(second.status).toBe("complete");
    expect(store.get("model_retry", "wf1")).toBeUndefined();
    expect(controls.isDispatchFrozen("wf1", root.id)).toBe(true);
    expect(stop.calls.length).toBeGreaterThan(0);
    await expect(
      controls.pauseTree("wf1", { ...request, expected_generation: 1 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("pauses the root when the tree has no running children", async () => {
    const { conversations, controls, stop } = openControl();
    const root = discoverRoot(conversations);
    const result = await controls.pauseTree("wf1", {
      request_id: "pause-root-only",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(result.status).toBe("complete");
    expect(latestStatus(conversations, root.id)?.status).toBe("paused");
    expect(stop.calls.map((item) => item.conversation_id)).toEqual([root.id]);
  });

  it("keeps pausing when stop is accepted without exit confirmation", async () => {
    const port = new RecordingStopPort();
    port.defaultResult = { accepted: true, confirmation: "unknown" };
    const { conversations, controls } = openControl(port);
    const root = discoverRoot(conversations);
    const result = await controls.pauseTree("wf1", {
      request_id: "pause-unconfirmed",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(result.status).toBe("pending");
    expect(latestStatus(conversations, root.id)?.status).toBe("pausing");
    expect(latestStatus(conversations, root.id)?.status).not.toBe("paused");
  });

  it("shows a 10s pending hint and turns partial with unknown after 30s", async () => {
    const port = new RecordingStopPort();
    port.defaultResult = { accepted: true, confirmation: "unknown" };
    const clock = new FakeClock();
    const { conversations, controls } = openControl(port, clock);
    const root = discoverRoot(conversations);
    const first = await controls.pauseTree("wf1", {
      request_id: "pause-timer",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(first.status).toBe("pending");
    expect(first.message).toBeUndefined();
    clock.advance(PAUSE_HINT_MS);
    const hinted = await controls.reconcile("wf1", first.control_id);
    expect(hinted.status).toBe("pending");
    expect(hinted.message).toBe(pausePendingMessage(1));
    clock.advance(PAUSE_PARTIAL_MS - PAUSE_HINT_MS);
    const partial = await controls.reconcile("wf1", first.control_id);
    expect(partial.status).toBe("partial");
    expect(partial.status).not.toBe("complete");
    expect(latestStatus(conversations, root.id)?.status).toBe("unknown");
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "20",
        session_native_id: "root-native",
        payload: { status: "interrupted", reason: "user_pause" },
      }),
    );
    const converged = await controls.reconcile("wf1", first.control_id);
    expect(converged.status).toBe("complete");
    expect(latestStatus(conversations, root.id)?.status).not.toBe("paused");
  });

  it("rejects stale root and generation without stopping the new run", async () => {
    const { conversations, controls, stop } = openControl();
    const old = discoverRoot(conversations);
    const replaced = conversations.applyEvent(
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
    await expect(
      controls.pauseTree("wf1", {
        request_id: "pause-stale",
        action: "pause",
        root_id: old.id,
        expected_generation: 0,
      }),
    ).rejects.toMatchObject({
      code: CONVERSATION_ERROR.STALE_ROOT,
      status: 409,
    });
    expect(stop.calls).toEqual([]);
    expect(latestStatus(conversations, replaced.id)?.status).toBe("starting");
  });

  it("does not rewrite a completed child to paused or change workflow to STOPPED", async () => {
    const { store, conversations, controls } = openControl();
    const root = discoverRoot(conversations);
    const child = spawnChild(
      conversations,
      "child-native",
      "root-native",
      "2",
      "completed",
    );
    const result = await controls.pauseTree("wf1", {
      request_id: "pause-completed-child",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(result.status).toBe("complete");
    expect(latestStatus(conversations, child.id)?.status).toBe("completed");
    expect(store.get<Workflow>("workflow", "wf1")?.state).toBe("EXECUTING");
    store.put("workflow", "wf1", "proj1", {
      ...store.get<Workflow>("workflow", "wf1")!,
      state: "COMPLETED",
    });
    await controls.pauseTree("wf1", {
      request_id: "pause-ended-workflow",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(store.get<Workflow>("workflow", "wf1")?.state).toBe("COMPLETED");
    expect(store.get<Workflow>("workflow", "wf1")?.state).not.toBe("STOPPED");
  });

  it("freezes prior purpose and does not treat aside as the same tree", async () => {
    const { store, conversations, controls, stop } = openControl();
    const root = discoverRoot(conversations);
    const asideCtx = ctx({
      run_id: "run-aside",
      lineage_id: "lineage-aside",
      purpose: "aside",
      root_native_id: "aside-native",
    });
    const aside = discoverRoot(conversations, asideCtx, "1");
    await controls.pauseTree("wf1", {
      request_id: "pause-main",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(latestStatus(conversations, aside.id)?.status).toBe("running");
    expect(stop.calls.some((item) => item.conversation_id === aside.id)).toBe(
      false,
    );
    const control = store.list<{ id: string }>(CONVERSATION_ENTITY.control, "wf1")[0]!;
    const saved = store.get<ConversationControlFence>(
      CONVERSATION_CONTROL_FENCE,
      control.id,
    );
    expect(saved?.purpose).toBe("implement");
    expect(saved?.stage).toBe("exec");
    expect(saved?.dispatch_frozen).toBe(true);
    expect(saved?.continuation?.purpose).toBe("execute");
  });
});

describe("SA-U19 conversation control generation fence", () => {
  it("returns VERSION_CONFLICT for an old generation after a new attempt", async () => {
    const { conversations, controls, stop } = openControl();
    const root = discoverRoot(conversations);
    conversations.applyEvent(
      ctx({ run_id: "run2" }),
      event({
        source_id: "src-run2",
        source_seq: "1",
        session_native_id: "root-native",
        payload: { title: "主会话", status: "starting" },
      }),
    );
    await expect(
      controls.pauseTree("wf1", {
        request_id: "pause-old-gen",
        action: "pause",
        root_id: root.id,
        expected_generation: 0,
      }),
    ).rejects.toMatchObject({
      code: CONVERSATION_ERROR.VERSION_CONFLICT,
      status: 409,
    });
    expect(stop.calls).toEqual([]);
    expect(latestStatus(conversations, root.id)?.generation).toBe(1);
    expect(latestStatus(conversations, root.id)?.status).toBe("starting");
  });
});
