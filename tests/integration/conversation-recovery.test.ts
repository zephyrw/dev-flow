import { describe, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  FlowError,
  unknownSubagentCapabilities,
  type ConversationNode,
  type ExecutionSpec,
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
  type ConversationControlClock,
  type StopPort,
  type StopPortResult,
  type StopPortTarget,
} from "../../packages/core/src/conversation-control.js";
import {
  isQuotaRetryBlocked,
  quotaRetryAt,
  type ModelRetry,
} from "../../packages/core/src/model-retry.js";
import { saveWaitingContext } from "../../packages/core/src/waiting-context.js";
import {
  ConversationRecovery,
  RECOVERY_ARRANGED_MESSAGE,
  recoveryGuidanceText,
  type RecoveryRunPort,
  type RecoveryRunRequest,
  storeRecoveryRunPort,
} from "../../packages/runtime/src/conversation-recovery.js";
import { currentRunUserGuidance } from "../../packages/runtime/src/profile-runtime.js";

class FakeClock implements ConversationControlClock {
  current = Date.parse("2026-09-20T00:00:00.000Z");
  iso() {
    return new Date(this.current).toISOString();
  }
  ms() {
    return this.current;
  }
}

class RecordingStopPort implements StopPort {
  stillAlive = new Set<string>();
  async stopConversation(target: StopPortTarget): Promise<StopPortResult> {
    if (this.stillAlive.has(target.conversation_id))
      return { accepted: true, confirmation: "unknown" };
    return { accepted: true, confirmation: "exited" };
  }
}

class RecordingRunPort implements RecoveryRunPort {
  constructor(private readonly store: Store) {}
  requests: RecoveryRunRequest[] = [];
  runs: Run[] = [];
  createRun(request: RecoveryRunRequest): Run {
    this.requests.push(request);
    const existing = this.runs.find((item) => item.id === request.run_id);
    if (existing) return existing;
    const run: Run = {
      id: request.run_id,
      workflow_id: request.workflow_id,
      plan_revision: 0,
      adapter: "codex",
      purpose: request.purpose as Run["purpose"],
      stage: request.stage ?? "exec",
      status: "queued",
      started_at: "2026-09-20T00:00:00.000Z",
      package_hash: "pkg",
      continuation: request.continuation,
    };
    this.runs.push(run);
    this.store.put("run", run.id, request.workflow_id, run);
    return run;
  }
}

function openSession(purpose: Run["purpose"] = "implement", stage = "exec") {
  const store = new Store(":memory:");
  const conversations = new ConversationService(store);
  conversations.setCapabilities("wf1", {
    ...unknownSubagentCapabilities(),
    resume: "native",
    stop: "native",
  });
  const stop = new RecordingStopPort();
  const controls = new ConversationControlService(
    store,
    conversations,
    stop,
    new FakeClock(),
  );
  const runPort = new RecordingRunPort(store);
  const recovery = new ConversationRecovery({
    store,
    conversations,
    controls,
    runPort,
    clock: new FakeClock(),
  });
  putWorkflow(store, purpose, stage);
  return { store, conversations, controls, recovery, runPort, stop };
}

function putWorkflow(
  store: Store,
  purpose: Run["purpose"] = "implement",
  stage = "exec",
) {
  const workflow: Workflow = {
    id: "wf1",
    project_id: "proj1",
    title: "恢复集成",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "BLOCKED",
    stage,
    version: 1,
    plan_revision: 0,
    plan_hash: "plan-hash",
    environment_revision: 0,
    run_id: "run1",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    feedback: [],
  };
  const run: Run = {
    id: "run1",
    workflow_id: "wf1",
    plan_revision: 0,
    adapter: "codex",
    purpose,
    stage,
    status: "failed",
    started_at: "2026-09-20T00:00:00.000Z",
    package_hash: "pkg",
    profile: {
      id: "profile-codex",
      adapterId: "codex",
      revision: 1,
      modelSelection: "native-config",
      options: {},
    },
    execution_spec_id: "spec-1",
    continuation: {
      kind: "runtime_resume",
      source_run_id: "run1",
      purpose:
        purpose === "quality_review"
          ? "review"
          : purpose === "planning"
            ? "planning"
            : "execute",
      role: purpose === "implement" ? "executor" : "planner",
      phase: purpose === "quality_review" ? "before_human" : undefined,
    },
  };
  store.put("workflow", "wf1", "proj1", workflow);
  store.put("run", "run1", "wf1", run);
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
) {
  return service.applyEvent(
    context,
    event({
      source_id: `src-${context.run_id}`,
      source_seq: "1",
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
      payload: { title: nativeId, task_summary: nativeId, status },
    }),
  ).node!;
}

function resumeBody(rootId: string, requestId = "resume-1") {
  return {
    request_id: requestId,
    action: "resume" as const,
    root_id: rootId,
    expected_generation: 0,
  };
}

async function reusedRootSession(withOldPause = false) {
  const s = openSession();
  const first = s.store.must<Run>("run", "run1");
  const observe = (runId: string, nativeId: string, hour: string) => {
    const timestamp = `2026-09-20T${hour}:00:00.000Z`;
    s.store.put("run", runId, "wf1", { ...first, id: runId, started_at: timestamp });
    s.store.put("workflow", "wf1", "proj1", {
      ...s.store.must<Workflow>("workflow", "wf1"), run_id: runId,
    });
    return s.conversations.applyEvent(ctx({ run_id: runId, root_native_id: nativeId }), event({
      source_id: `reuse-${runId}`, source_seq: "1", root_native_id: nativeId, session_native_id: nativeId,
      occurred_at: timestamp, payload: { status: "running" },
    })).node!;
  };
  const oldRoot = observe("run1", "root-native", "01");
  if (withOldPause) await s.controls.pauseTree("wf1", {
    request_id: "old-generation-pause", action: "pause", root_id: oldRoot.id, expected_generation: 0,
  });
  const laterRoot = observe("run2", "other-account-root", "02");
  const reused = observe("run3", "root-native", "03");
  expect(reused.id).toBe(oldRoot.id);
  expect(reused.created_at < laterRoot.created_at).toBe(true);
  s.store.put("workflow", "wf1", "proj1", { ...s.store.must<Workflow>("workflow", "wf1"), run_id: "run3" });
  const generation = s.conversations.getTree("wf1").attempts.find((a) => a.run_id === "run3" && a.conversation_id === reused.id)!.generation;
  return { ...s, reused, laterRoot, generation };
}

describe("reused native roots follow the latest execution instead of node creation", () => {
  it("can pause and recover the old root after a newer Run reused it", async () => {
    const s = await reusedRootSession();
    try {
      const paused = await s.controls.pauseTree("wf1", {
        request_id: "pause-reused", action: "pause", root_id: s.reused.id, expected_generation: s.generation,
      });
      expect(paused.unconfirmed_count).toBe(0);
      const result = await s.recovery.arrangeRecovery("wf1", {
        ...resumeBody(s.reused.id, "resume-reused"), expected_generation: s.generation,
      }, { reason: "user_resume" });
      expect(result.manifest.source_run_id).toBe("run3");
      expect(result.manifest.root_conversation_id).toBe(s.reused.id);
      expect(s.runPort.requests).toHaveLength(1);
    } finally { s.store.close(); }
  });

  it("both entry points reject the superseded root even after its delayed activity event", async () => {
    const s = await reusedRootSession();
    try {
      s.conversations.applyEvent(ctx({ run_id: "run2", root_native_id: "other-account-root" }), event({
        source_id: "reuse-run2", source_seq: "2", root_native_id: "other-account-root", session_native_id: "other-account-root",
        occurred_at: "2026-09-20T04:00:00.000Z", kind: "activity", payload: { summary: "delayed older run observation" },
      }));
      await expect(s.controls.pauseTree("wf1", {
        request_id: "pause-superseded", action: "pause", root_id: s.laterRoot.id, expected_generation: 0,
      })).rejects.toMatchObject({ code: CONVERSATION_ERROR.STALE_ROOT });
      await expect(s.recovery.arrangeRecovery("wf1", resumeBody(s.laterRoot.id, "resume-superseded"),
        { reason: "user_resume" })).rejects.toMatchObject({ code: CONVERSATION_ERROR.STALE_ROOT });
      expect(s.runPort.requests).toHaveLength(0);
      expect(s.conversations.getTree("wf1").attempts.find((a) => a.run_id === "run3")?.status).toBe("running");
    } finally { s.store.close(); }
  });

  it("an older generation fence cannot replace the reused root's failed Run or lose its guidance", async () => {
    const s = await reusedRootSession(true);
    try {
      // Mirror a failed model call followed by Engine.stop while already queued:
      // there is no new live process to pause, so only an older fence exists.
      s.conversations.applyEvent(ctx({ run_id: "run3" }), event({
        source_id: "reuse-run3", source_seq: "2", session_native_id: "root-native", kind: "state",
        occurred_at: "2026-09-20T03:30:00.000Z", payload: { status: "failed" },
      }));
      const source = { ...s.store.must<Run>("run", "run3"), status: "failed" as const,
        assignment_id: "current-assignment", routing_role: "executor" as const };
      s.store.put("run", source.id, "wf1", source);
      s.store.put("workflow", "wf1", "proj1", { ...s.store.must<Workflow>("workflow", "wf1"), state: "STOPPED" });
      s.store.put("feedback_message", "current-guidance", "wf1", {
        workflow_id: "wf1", seq: 6, text: "继续本轮，并逐项回答我之前的问题", ack_run: source.id,
      });
      for (const fence of s.store.list<any>("conversation_control_fence", "wf1")) {
        s.store.put("conversation_control_fence", fence.id, "wf1",
          { ...fence, updated_at: "2026-09-20T05:00:00.000Z", dispatch_frozen: false });
      }
      const recovery = new ConversationRecovery({ store: s.store, conversations: s.conversations,
        controls: s.controls, runPort: storeRecoveryRunPort(s.store), clock: new FakeClock() });
      const result = await recovery.arrangeRecovery("wf1", {
        ...resumeBody(s.reused.id, "resume-after-failure"), expected_generation: s.generation,
      }, { reason: "user_resume" });
      expect(result.manifest.source_run_id).toBe(source.id);
      const resumed = s.store.must<Run>("run", result.manifest.target_run_id);
      expect(resumed.assignment_id).toBe("current-assignment");
      expect(resumed.continuation).toMatchObject({ kind: "runtime_resume", source_run_id: source.id });
      expect(currentRunUserGuidance(s.store, "wf1", resumed)?.messages)
        .toEqual([expect.objectContaining({ seq: 6, text: "继续本轮，并逐项回答我之前的问题" })]);
    } finally { s.store.close(); }
  });
});

async function observeChildPaused(conversations: ConversationService, controls: ConversationControlService, controlId: string) {
  // An unknown tree-exit receipt requires subsequent observations for all live targets.
  conversations.applyEvent(ctx(), event({ source_id: "src-run1", source_seq: "49", kind: "state",
    session_native_id: "root-native", payload: { status: "paused", reason: "user_pause" } }));
  conversations.applyEvent(ctx(), event({ source_id: "src-run1", source_seq: "50", kind: "state",
    session_native_id: "child-native", parent_native_id: "root-native", payload: { status: "paused", reason: "user_pause" } }));
  const settled = await controls.reconcile("wf1", controlId);
  expect(settled.unconfirmed_count).toBe(0);
}

function observeResumedNode(store: Store, conversations: ConversationService, runId: string,
  nativeId: string, parentNativeId: string, status: string) {
  store.put("workflow", "wf1", "proj1", { ...store.must<Workflow>("workflow", "wf1"), run_id: runId });
  store.put("run", runId, "wf1", { ...store.must<Run>("run", runId), status: "running" });
  const context = ctx({ run_id: runId });
  conversations.applyEvent(context, event({ source_id: `resume-${runId}`, source_seq: "1",
    session_native_id: "root-native", payload: { status: "running" } }));
  return conversations.applyEvent(context, event({ source_id: `resume-${runId}`, source_seq: "2",
    session_native_id: nativeId, parent_native_id: parentNativeId, payload: { status } })).node!;
}

describe("SA-I10 quota restore reuses purpose and treats delivered as not observed", () => {
  it("reuses original purpose and config, injects manifest, and keeps delivered distinct from observed", async () => {
    const { store, conversations, recovery, runPort } = openSession();
    const root = discoverRoot(conversations);
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "10",
        session_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "11",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    const arranged = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "quota-1"),
      { reason: "quota_retry" },
    );
    expect(arranged.message).toBe(RECOVERY_ARRANGED_MESSAGE);
    expect(arranged.purpose).toBe("implement");
    expect(arranged.manifest.stage).toBe("delivered");
    expect(arranged.manifest.stage).not.toBe("observed");
    expect(arranged.counts.restored).toBe(0);
    expect(arranged.counts.pending).toBeGreaterThan(0);
    expect(runPort.requests[0]?.manifest.recovery_id).toBe(arranged.recovery_id);
    expect(runPort.requests[0]?.purpose).toBe("implement");
    expect(store.get<Run>("run", "run1")?.plan_revision).toBe(0);
    expect(store.get<Run>("run", "run1")?.package_hash).toBe("pkg");
    observeResumedNode(store, conversations, arranged.manifest.target_run_id, "child-native", "root-native", "running");
    const observed = recovery.observeAttempt("wf1", {
      conversation_id: child.id,
      run_id: arranged.manifest.target_run_id,
      status: "running",
      native_session_id: "child-native",
    });
    expect(observed?.stage).not.toBe("delivered");
    expect(observed?.observed_count).toBe(1);
    expect(recoveryGuidanceText(arranged.manifest)).toContain(child.id);
  });
});

describe("SA-I11 nested restore native resume and confirmed recreate", () => {
  it("keeps parent nesting, resumes native children, recreates lost ones, and skips completed", async () => {
    const { store, conversations, recovery } = openSession();
    conversations.setCapabilities("wf1", {
      ...unknownSubagentCapabilities(),
      resume: "native",
      stop: "native",
    });
    const root = discoverRoot(conversations);
    const parent = spawnChild(conversations, "parent-native", "root-native", "2");
    const nested = spawnChild(conversations, "nested-native", "parent-native", "3");
    spawnChild(conversations, "done-native", "root-native", "4", "completed");
    const lost = spawnChild(conversations, "lost-native", "parent-native", "5");
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "20",
        session_native_id: "root-native",
        payload: { status: "paused", reason: "user_pause" },
      }),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "21",
        session_native_id: "parent-native",
        parent_native_id: "root-native",
        payload: { status: "paused", reason: "user_pause" },
      }),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "22",
        session_native_id: "nested-native",
        parent_native_id: "parent-native",
        payload: { status: "paused", reason: "user_pause" },
      }),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "23",
        session_native_id: "lost-native",
        parent_native_id: "parent-native",
        payload: { status: "interrupted", reason: "process_exit" },
      }),
    );
    const node = store.get<ConversationNode>(
      CONVERSATION_ENTITY.node,
      lost.id,
    )!;
    store.put(CONVERSATION_ENTITY.node, node.id, node.workflow_id, {
      ...node,
      native_session_id: undefined,
    });
    const arranged = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "nested-1"),
      { reason: "user_resume" },
    );
    const pending = arranged.manifest.pending_children;
    expect(pending.find((item) => item.conversation_id === nested.id)?.parent_id).toBe(
      parent.id,
    );
    expect(
      pending.find((item) => item.conversation_id === nested.id)?.continuation,
    ).toBe("resume-native");
    expect(
      pending.find((item) => item.conversation_id === lost.id)?.continuation,
    ).toBe("recreate-after-confirmed-exit");
    expect(pending.some((item) => item.native_session_id === "done-native")).toBe(
      false,
    );
    const recreatedNode = observeResumedNode(store, conversations, arranged.manifest.target_run_id, "new-lost-native", "parent-native", "starting");
    const recreated = recovery.observeAttempt("wf1", {
      conversation_id: recreatedNode.id,
      run_id: arranged.manifest.target_run_id,
      status: "starting",
      parent_id: parent.id,
      replaces_conversation_id: lost.id,
    });
    expect(recreated?.observed_count).toBe(1);
  });
});

describe("SA-I12 quota timer, pause, config change and duplicate recover", () => {
  it("lets only one resume request create a run when outbox and recover race", async () => {
    const { conversations, controls, recovery, runPort, store, stop } = openSession();
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    stop.stillAlive.add(root.id);
    const paused = await controls.pauseTree("wf1", {
      request_id: "pause-race",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(paused.unconfirmed_count).toBe(2);
    await observeChildPaused(conversations, controls, paused.control.id);
    const first = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "outbox-1"),
      { reason: "user_resume" },
    );
    const second = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "outbox-2"),
      { reason: "quota_retry" },
    );
    expect(second.recovery_id).toBe(first.recovery_id);
    expect(new Set(runPort.runs.map((item) => item.id)).size).toBe(1);
    expect(store.get<Workflow>("workflow", "wf1")?.plan_hash).toBe("plan-hash");
  });

  it("does not resume a quota timer after user pause, and recreates when the next tool changed", async () => {
    const { store, conversations, controls, recovery, stop } = openSession();
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    stop.stillAlive.add(root.id);
    store.put("model_retry", "wf1", "wf1", {
      id: "wf1",
      run_id: "run1",
      plan_revision: 0,
      retry_at: Date.now() + 10_000,
      root_id: root.id,
      generation: 0,
    } satisfies ModelRetry);
    const paused = await controls.pauseTree("wf1", {
      request_id: "pause-quota",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(paused.unconfirmed_count).toBe(2);
    await observeChildPaused(conversations, controls, paused.control.id);
    expect(store.get("model_retry", "wf1")).toBeUndefined();
    store.put("model_retry", "wf1", "wf1", {
      id: "wf1",
      run_id: "run1",
      plan_revision: 0,
      retry_at: Date.now() + 10_000,
      root_id: root.id,
      generation: 0,
    } satisfies ModelRetry);
    expect(
      isQuotaRetryBlocked(store, store.get<ModelRetry>("model_retry", "wf1")!),
    ).toBe(true);
    const spec: ExecutionSpec = {
      schema_version: 2,
      roleOverrides: { reviewer: { mode: "inherit" }, review_fixer: { mode: "inherit" }, functional_fixer: { mode: "inherit" } },
      id: "spec-2",
      revision: 2,
      workflow_id: "wf1",
      plannerProfile: {
        id: "profile-agy",
        adapterId: "agy",
        revision: 1,
        modelSelection: "native-config",
        options: {},
      },
      executorProfile: {
        id: "profile-agy",
        adapterId: "agy",
        revision: 1,
        modelSelection: "native-config",
        options: {},
      },
      template_id: "native-development",
      template_revision: 3,
      mode: "single_tool",
      created_at: "2026-09-20T00:00:00.000Z",
    };
    store.put("execution_spec", spec.id, "wf1", spec);
    const arranged = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "tool-switch"),
      { reason: "user_resume" },
    );
    expect(arranged.profile_changed).toBe(true);
    expect(
      arranged.manifest.pending_children.every(
        (item) => item.continuation === "recreate-after-confirmed-exit",
      ),
    ).toBe(true);
  });
});

describe("SA-I13 native failure, quota again, missing reset, live leftover", () => {
  it("marks partial when native resume fails and rejects live leftovers", async () => {
    const { store, conversations, recovery } = openSession();
    const root = discoverRoot(conversations);
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "30",
        session_native_id: "root-native",
        payload: { status: "paused", reason: "user_pause" },
      }),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "31",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { status: "paused", reason: "user_pause" },
      }),
    );
    const arranged = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "fail-native"),
      { reason: "user_resume" },
    );
    observeResumedNode(store, conversations, arranged.manifest.target_run_id, "child-native", "root-native", "failed");
    const failed = recovery.observeAttempt("wf1", {
      conversation_id: child.id,
      run_id: arranged.manifest.target_run_id,
      status: "failed",
      native_session_id: "child-native",
    });
    expect(failed?.stage).toBe("partial");
    expect(quotaRetryAt("额度不足", 0)).toBeNull();
    const live = openSession();
    const liveRoot = discoverRoot(live.conversations);
    spawnChild(live.conversations, "live-child", "root-native", "2");
    await expect(
      live.recovery.arrangeRecovery("wf1", resumeBody(liveRoot.id, "still-live"), {
        reason: "user_resume",
      }),
    ).rejects.toMatchObject({
      code: CONVERSATION_ERROR.STOP_UNCONFIRMED,
      status: 409,
    });
    expect(live.runPort.runs).toHaveLength(0);
  });

  it("does not invent a reset time and keeps the same recovery batch after quota again", async () => {
    const { store, conversations, recovery } = openSession();
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "40",
        session_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    conversations.applyEvent(
      ctx(),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "41",
        session_native_id: "child-native",
        parent_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    const first = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "quota-again"),
      { reason: "quota_retry" },
    );
    store.put("workflow", "wf1", "proj1", {
      ...store.get<Workflow>("workflow", "wf1")!,
      state: "BLOCKED",
      blocker: { code: "MODEL_QUOTA", message: "额度不足" },
    });
    const second = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "quota-again-2"),
      { reason: "quota_retry" },
    );
    expect(second.recovery_id).toBe(first.recovery_id);
    expect(second.manifest.target_run_id).toBe(first.manifest.target_run_id);
    expect(quotaRetryAt("still quota", Date.now())).toBeNull();
  });

  it("only restores planning permission when the first plan is not approved", async () => {
    const { store, conversations, recovery, runPort } = openSession(
      "planning",
      "planning",
    );
    store.put("workflow", "wf1", "proj1", {
      ...store.get<Workflow>("workflow", "wf1")!,
      plan_hash: undefined,
      state: "PLANNING",
    });
    const root = discoverRoot(
      conversations,
      ctx({ purpose: "planning", lineage_id: "lineage-plan" }),
    );
    conversations.applyEvent(
      ctx({ purpose: "planning", lineage_id: "lineage-plan" }),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "50",
        session_native_id: "root-native",
        payload: { status: "interrupted", reason: "quota" },
      }),
    );
    saveWaitingContext(store, "wf1", {
      purpose: "planning",
      role: "planner",
      run_id: "run1",
      conversation_id: root.id,
      intent: "need_user",
    });
    const arranged = await recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "plan-only"),
      { reason: "user_resume" },
    );
    expect(arranged.planning_only).toBe(true);
    expect(arranged.purpose).toBe("planning");
    expect(arranged.waiting_purpose).toBe("planning");
    expect(runPort.requests[0]?.planning_only).toBe(true);
    expect(runPort.runs[0]?.purpose).toBe("planning");
  });

  it("keeps quality review phase and does not recover aside or completed workflows", async () => {
    const review = openSession("quality_review", "quality_before_human");
    const root = discoverRoot(
      review.conversations,
      ctx({ purpose: "quality_review", lineage_id: "lineage-review" }),
    );
    review.conversations.applyEvent(
      ctx({ purpose: "quality_review", lineage_id: "lineage-review" }),
      event({
        source_id: "src-run1",
        kind: "state",
        source_seq: "60",
        session_native_id: "root-native",
        payload: { status: "paused", reason: "user_pause" },
      }),
    );
    const asideCtx = ctx({
      run_id: "run-aside",
      purpose: "aside",
      lineage_id: "lineage-aside",
      root_native_id: "aside-native",
    });
    review.conversations.applyEvent(
      asideCtx,
      event({
        source_id: "src-aside",
        source_seq: "1",
        root_native_id: "aside-native",
        session_native_id: "aside-native",
        payload: { title: "临时提问", status: "running", kind: "aside" },
      }),
    );
    const arranged = await review.recovery.arrangeRecovery(
      "wf1",
      resumeBody(root.id, "review-phase"),
      { reason: "user_resume" },
    );
    expect(arranged.purpose).toBe("quality_review");
    expect(arranged.phase).toBe("before_human");
    expect(arranged.waiting_purpose).toBe("review");
    expect(
      arranged.manifest.pending_children.some(
        (item) => item.native_session_id === "aside-native",
      ),
    ).toBe(false);
    review.store.put("workflow", "wf1", "proj1", {
      ...review.store.get<Workflow>("workflow", "wf1")!,
      state: "COMPLETED",
    });
    await expect(
      review.recovery.arrangeRecovery("wf1", resumeBody(root.id, "done-wf"), {
        reason: "user_resume",
      }),
    ).rejects.toBeInstanceOf(FlowError);
  });
});


describe("stored recovery run projections", () => {
  it.each(["executor_test", "functional_fix"] as const)("repeated recovery keeps the stopped generation and purpose %s until launch", async (purpose) => {
    const s = openSession(purpose, purpose === "functional_fix" ? "acceptance_guidance" : purpose);
    try {
      const recovery = new ConversationRecovery({ store: s.store, conversations: s.conversations,
        controls: s.controls, runPort: storeRecoveryRunPort(s.store), clock: new FakeClock() });
      const tree = s.conversations.getTree("wf1");
      const root = tree.active_root_id!;
      const request = { request_id: "api-resume", action: "resume" as const,
        root_id: root, expected_generation: tree.attempts.at(-1)!.generation };
      const first = await recovery.arrangeRecovery("wf1", request, { reason: "user_resume" });
      const after = s.conversations.getTree("wf1", root);
      expect(after.attempts).toEqual(tree.attempts);
      // The API prepares a recovery before resumeApproved performs its own lookup.
      const repeated = await recovery.arrangeRecovery("wf1", { ...request, request_id: "engine-resume",
        expected_generation: after.attempts.at(-1)!.generation }, { reason: "user_resume" });
      expect(repeated.recovery_id).toBe(first.recovery_id);
      const queued = s.store.must<Run>("run", first.manifest.target_run_id);
      expect(queued).toMatchObject({ status: "queued", purpose, conversation_id: root });
      expect(s.store.list<Run>("run", "wf1")).toHaveLength(2);
      // Once actually launched, the projected new attempt must still block duplicates.
      s.store.put("run", queued.id, "wf1", { ...queued, status: "running" });
      const active = s.conversations.getTree("wf1", root);
      expect(active.attempts.at(-1)).toMatchObject({ run_id: queued.id, status: "running" });
      await expect(recovery.arrangeRecovery("wf1", { ...request, request_id: "duplicate-after-launch",
        expected_generation: active.attempts.at(-1)!.generation }, { reason: "user_resume" }))
        .rejects.toMatchObject({ code: CONVERSATION_ERROR.STOP_UNCONFIRMED });
    } finally { s.store.close(); }
  });
});
