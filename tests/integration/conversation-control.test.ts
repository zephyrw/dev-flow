import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Store } from "../../packages/store/src/store.js";
import {
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
  ConversationControlService,
  PAUSE_PARTIAL_MS,
  type ConversationControlClock,
  type StopPort,
  type StopPortResult,
  type StopPortTarget,
} from "../../packages/core/src/conversation-control.js";
import {
  conversationControlPlugin,
  consoleHumanGuard,
} from "../../apps/api/src/routes/conversation-controls.js";

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
  gates = new Map<string, Promise<void>>();
  defaultResult: StopPortResult = { accepted: true, confirmation: "exited" };
  async stopConversation(target: StopPortTarget): Promise<StopPortResult> {
    this.calls.push({ ...target });
    const gate = this.gates.get(target.conversation_id);
    if (gate) await gate;
    return this.results.get(target.conversation_id) ?? this.defaultResult;
  }
}

function putWorkflow(
  store: Store,
  workflowId: string,
  runId: string,
  state: Workflow["state"] = "EXECUTING",
) {
  const workflow: Workflow = {
    id: workflowId,
    project_id: "proj1",
    title: workflowId,
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
    source_id: extra.source_id ?? `src-${extra.root_native_id ?? "root-native"}`,
    source_seq: extra.source_seq ?? "1",
    root_native_id: extra.root_native_id ?? "root-native",
    session_native_id: extra.session_native_id,
    agent_native_id: extra.agent_native_id,
    parent_native_id: extra.parent_native_id,
    kind: extra.kind ?? "discovered",
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
  context: ConversationApplyContext = ctx(),
  status = "running",
) {
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

function latest(
  conversations: ConversationService,
  conversationId: string,
  workflowId = "wf1",
) {
  return conversations
    .getTree(workflowId)
    .attempts.filter((item) => item.conversation_id === conversationId)
    .sort((a, b) => a.generation - b.generation)
    .at(-1);
}

function openWorld(port?: RecordingStopPort, clock?: FakeClock) {
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
  putWorkflow(store, "wf1", "run1");
  return { store, conversations, controls, stop, time };
}

const openedApps: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  for (const app of openedApps.splice(0)) await app.close();
});

async function startApp(
  store: Store,
  conversations: ConversationService,
  stop: StopPort,
  clock: FakeClock,
) {
  const controls = new ConversationControlService(
    store,
    conversations,
    stop,
    clock,
  );
  const app = Fastify({ logger: false });
  await app.register(conversationControlPlugin, {
    controls,
    human: consoleHumanGuard,
  });
  await app.ready();
  openedApps.push(app);
  return app;
}

describe("SA-I06 conversation control tree pause", () => {
  it("pauses root child and grandchild only after confirmed exit and stays idempotent", async () => {
    const { conversations, controls, stop } = openWorld();
    const root = discoverRoot(conversations);
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    const grand = spawnChild(conversations, "grand-native", "child-native", "3");
    const request = {
      request_id: "pause-tree",
      action: "pause" as const,
      root_id: root.id,
      expected_generation: 0,
    };
    const first = await controls.pauseTree("wf1", request);
    expect(first.status).toBe("complete");
    expect(latest(conversations, root.id)?.status).toBe("paused");
    expect(latest(conversations, child.id)?.status).toBe("paused");
    expect(latest(conversations, grand.id)?.status).toBe("paused");
    const second = await controls.pauseTree("wf1", request);
    expect(second.control_id).toBe(first.control_id);
    expect(stop.calls.map((item) => item.conversation_id).sort()).toEqual(
      [root.id, child.id, grand.id].sort(),
    );
  });
});

describe("SA-I07 late spawn and unconfirmed stop", () => {
  it("stops a late spawn during pause and does not fake a full stop from root exit", async () => {
    const port = new RecordingStopPort();
    let releaseRoot: () => void = () => {};
    const { conversations, controls } = openWorld(port);
    const root = discoverRoot(conversations);
    port.gates.set(
      root.id,
      new Promise<void>((resolve) => {
        releaseRoot = resolve;
      }),
    );
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    port.results.set(root.id, { accepted: true, confirmation: "exited" });
    port.results.set(child.id, { accepted: true, confirmation: "unknown" });
    const pending = controls.pauseTree("wf1", {
      request_id: "pause-late",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    await waitFor(() => port.calls.some((item) => item.conversation_id === root.id));
    const late = spawnChild(conversations, "late-native", "root-native", "9");
    port.results.set(late.id, { accepted: true, confirmation: "unknown" });
    releaseRoot();
    const result = await pending;
    expect(result.status).toBe("pending");
    expect(result.status).not.toBe("complete");
    expect(latest(conversations, root.id)?.status).toBe("paused");
    expect(latest(conversations, child.id)?.status).toBe("pausing");
    expect(latest(conversations, late.id)?.status).toBe("pausing");
    expect(port.calls.some((item) => item.conversation_id === late.id)).toBe(
      true,
    );
  });

  it("marks partial when a slow stop stays unconfirmed past 30 seconds", async () => {
    const port = new RecordingStopPort();
    port.defaultResult = { accepted: true, confirmation: "unknown" };
    const clock = new FakeClock();
    const { conversations, controls } = openWorld(port, clock);
    const root = discoverRoot(conversations);
    spawnChild(conversations, "bg-native", "root-native", "2");
    const first = await controls.pauseTree("wf1", {
      request_id: "pause-slow",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(first.status).toBe("pending");
    clock.advance(PAUSE_PARTIAL_MS);
    const partial = await controls.reconcile("wf1", first.control_id);
    expect(partial.status).toBe("partial");
    expect(partial.unconfirmed_count).toBeGreaterThan(0);
    expect(partial.targets.some((item) => item.status === "unknown")).toBe(true);
  });
});

describe("SA-I08 generation race and completed tasks", () => {
  it("does not stop a new run or rewrite a child that completed during pause", async () => {
    const port = new RecordingStopPort();
    let releaseChild: () => void = () => {};
    const { conversations, controls, store } = openWorld(port);
    const root = discoverRoot(conversations);
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    port.gates.set(
      child.id,
      new Promise<void>((resolve) => {
        releaseChild = resolve;
      }),
    );
    const pending = controls.pauseTree("wf1", {
      request_id: "pause-race",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    await waitFor(() =>
      port.calls.some((item) => item.conversation_id === child.id),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "80",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { status: "completed" },
      }),
    );
    releaseChild();
    const raced = await pending;
    expect(latest(conversations, child.id)?.status).toBe("completed");
    expect(raced.targets.find((item) => item.conversation_id === child.id)?.status).toBe(
      "completed",
    );
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
        request_id: "pause-new-gen",
        action: "pause",
        root_id: root.id,
        expected_generation: 0,
      }),
    ).rejects.toMatchObject({
      code: CONVERSATION_ERROR.VERSION_CONFLICT,
      status: 409,
    });
    expect(latest(conversations, root.id)?.generation).toBe(1);
    expect(latest(conversations, root.id)?.status).toBe("starting");
    const retry = await controls.pauseTree("wf1", {
      request_id: "pause-race",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(retry.control_id).toBe(raced.control_id);
    expect(latest(conversations, root.id)?.generation).toBe(1);
    expect(latest(conversations, root.id)?.status).toBe("starting");
    store.put("workflow", "wf1", "proj1", {
      ...store.get<Workflow>("workflow", "wf1")!,
      state: "COMPLETED",
    });
    await controls.pauseTree("wf1", {
      request_id: "pause-race",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(store.get<Workflow>("workflow", "wf1")?.state).toBe("COMPLETED");
  });
});

describe("SA-I09 restart and isolation", () => {
  it("resumes confirmation after a crash and does not stop aside or another workflow", async () => {
    const firstPort = new RecordingStopPort();
    firstPort.defaultResult = { accepted: true, confirmation: "unknown" };
    const world = openWorld(firstPort);
    putWorkflow(world.store, "wf2", "run-other");
    const root = discoverRoot(world.conversations);
    const child = spawnChild(
      world.conversations,
      "child-native",
      "root-native",
      "2",
    );
    const aside = discoverRoot(
      world.conversations,
      ctx({
        run_id: "run-aside",
        lineage_id: "lineage-aside",
        purpose: "aside",
        root_native_id: "aside-native",
      }),
    );
    const otherRoot = discoverRoot(
      world.conversations,
      ctx({
        workflow_id: "wf2",
        run_id: "run-other",
        lineage_id: "lineage-other",
        root_native_id: "other-native",
      }),
    );
    const paused = await world.controls.pauseTree("wf1", {
      request_id: "pause-crash",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(paused.status).toBe("pending");
    expect(
      firstPort.calls.every(
        (item) =>
          item.conversation_id === root.id || item.conversation_id === child.id,
      ),
    ).toBe(true);
    expect(
      firstPort.calls.some((item) => item.conversation_id === aside.id),
    ).toBe(false);
    expect(
      firstPort.calls.some((item) => item.conversation_id === otherRoot.id),
    ).toBe(false);
    const restartPort = new RecordingStopPort();
    restartPort.defaultResult = { accepted: true, confirmation: "exited" };
    const restarted = new ConversationControlService(
      world.store,
      new ConversationService(world.store),
      restartPort,
      world.time,
    );
    const continued = await restarted.reconcile("wf1", paused.control_id);
    expect(continued.status).toBe("complete");
    expect(continued.control_id).toBe(paused.control_id);
    expect(latest(world.conversations, aside.id)?.status).toBe("running");
    expect(latest(world.conversations, otherRoot.id, "wf2")?.status).toBe(
      "running",
    );
    expect(
      restartPort.calls.some((item) => item.conversation_id === aside.id),
    ).toBe(false);
  });

  it("returns 202 with pending partial or complete status", async () => {
    const port = new RecordingStopPort();
    const clock = new FakeClock();
    const { store, conversations } = openWorld(port, clock);
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    const app = await startApp(store, conversations, port, clock);
    const complete = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-controls",
      headers: { "content-type": "application/json" },
      payload: {
        request_id: "http-pause",
        action: "pause",
        root_id: root.id,
        expected_generation: 0,
      },
    });
    expect(complete.statusCode).toBe(202);
    expect(["pending", "partial", "complete"]).toContain(
      complete.json().status,
    );
    expect(complete.json().status).toBe("complete");
    port.defaultResult = { accepted: true, confirmation: "unknown" };
    const root2 = discoverRoot(
      conversations,
      ctx({
        run_id: "run-pending",
        lineage_id: "lineage-pending",
        root_native_id: "pending-root",
      }),
    );
    const pending = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-controls",
      headers: { "content-type": "application/json" },
      payload: {
        request_id: "http-pending",
        action: "pause",
        root_id: root2.id,
        expected_generation: 0,
      },
    });
    expect(pending.statusCode).toBe(202);
    expect(pending.json().status).toBe("pending");
    clock.advance(PAUSE_PARTIAL_MS);
    const read = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversation-controls/${pending.json().control_id}`,
    });
    expect(read.json().status).toBe("partial");
    conversations.applyEvent(
      ctx({ run_id: "run2" }),
      event({
        source_id: "src-run2",
        source_seq: "1",
        session_native_id: "root-native",
        payload: { title: "主会话", status: "starting" },
      }),
    );
    const stale = await app.inject({
      method: "POST",
      url: "/api/workflows/wf1/conversation-controls",
      headers: { "content-type": "application/json" },
      payload: {
        request_id: "http-stale",
        action: "pause",
        root_id: root.id,
        expected_generation: 0,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe(CONVERSATION_ERROR.VERSION_CONFLICT);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
