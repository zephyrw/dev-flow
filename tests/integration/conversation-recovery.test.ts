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
} from "../../packages/runtime/src/conversation-recovery.js";

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
  const runPort = new RecordingRunPort();
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
    const recreated = recovery.observeAttempt("wf1", {
      conversation_id: "cnv-new-lost",
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
    const { conversations, controls, recovery, runPort, store } = openSession();
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    await controls.pauseTree("wf1", {
      request_id: "pause-race",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
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
    const { store, conversations, controls, recovery } = openSession();
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    store.put("model_retry", "wf1", "wf1", {
      id: "wf1",
      run_id: "run1",
      plan_revision: 0,
      retry_at: Date.now() + 10_000,
      root_id: root.id,
      generation: 0,
    } satisfies ModelRetry);
    await controls.pauseTree("wf1", {
      request_id: "pause-quota",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
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
    const { conversations, recovery } = openSession();
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
