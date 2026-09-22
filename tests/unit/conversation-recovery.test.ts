import { describe, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import {
  unknownSubagentCapabilities,
  type RecoveryManifest,
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
  invalidateTreeRetry,
  isQuotaRetryBlocked,
  isRetryBatchCurrent,
  quotaRetryAt,
  readRetryBatch,
  type ModelRetry,
} from "../../packages/core/src/model-retry.js";
import {
  preserveWaitingOwnership,
  waitingPurposeFromRun,
  type WaitingContext,
} from "../../packages/core/src/waiting-context.js";
import {
  ConversationRecovery,
  RECOVERY_ARRANGED_MESSAGE,
  RECOVERY_GUIDANCE_TEXT,
  buildManifest,
  recoveryContentHash,
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
  async stopConversation(_target: StopPortTarget): Promise<StopPortResult> {
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

function openRecovery() {
  const store = new Store(":memory:");
  const conversations = new ConversationService(store);
  conversations.setCapabilities("wf1", {
    ...unknownSubagentCapabilities(),
    resume: "native",
    stop: "native",
  });
  const controls = new ConversationControlService(
    store,
    conversations,
    new RecordingStopPort(),
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
  putWorkflow(store, "wf1", "STOPPED", "run1", "implement", "exec");
  return { store, conversations, controls, recovery, runPort };
}

function putWorkflow(
  store: Store,
  workflowId: string,
  state: Workflow["state"],
  runId: string,
  purpose: Run["purpose"] = "implement",
  stage = "exec",
) {
  const workflow: Workflow = {
    id: workflowId,
    project_id: "proj1",
    title: "恢复测试",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state,
    stage,
    version: 1,
    plan_revision: 0,
    plan_hash: "plan-hash",
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
    purpose,
    stage,
    status: "interrupted",
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
      source_run_id: runId,
      purpose: purpose === "quality_review" ? "review" : purpose === "planning" ? "planning" : "execute",
      role: purpose === "implement" ? "executor" : "planner",
      phase: purpose === "quality_review" ? "before_human" : stage,
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
  payload: Record<string, unknown> = {},
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
      payload: { title: nativeId, task_summary: payload.task_summary ?? nativeId, status, ...payload },
    }),
  ).node!;
}

function resumeRequest(rootId: string, requestId = "resume-1") {
  return {
    request_id: requestId,
    action: "resume" as const,
    root_id: rootId,
    expected_generation: 0,
  };
}

describe("SA-U19 conversation recovery set", () => {
  it("excludes completed and cancelled, keeps paused interrupted quota, and nests under the original parent", async () => {
    const { conversations, controls, recovery } = openRecovery();
    const root = discoverRoot(conversations);
    const child = spawnChild(conversations, "child-native", "root-native", "2");
    spawnChild(conversations, "done-native", "root-native", "3", "completed", {}, {
      task_summary: "已写接口",
    });
    spawnChild(conversations, "cancel-native", "root-native", "4", "cancelled");
    spawnChild(conversations, "quota-native", "root-native", "5", "interrupted");
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
    const grand = spawnChild(conversations, "grand-native", "child-native", "7");
    await controls.pauseTree("wf1", {
      request_id: "pause-recovery",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    const arranged = await recovery.arrangeRecovery(
      "wf1",
      resumeRequest(root.id),
      { reason: "user_resume" },
    );
    expect(arranged.message).toBe(RECOVERY_ARRANGED_MESSAGE);
    const ids = arranged.manifest.pending_children.map(
      (item) => item.conversation_id,
    );
    expect(ids).toContain(child.id);
    expect(ids).toContain(grand.id);
    expect(ids).not.toContain(root.id);
    const tree = conversations.getTree("wf1");
    expect(ids).not.toContain(
      tree.nodes.find((node) => node.native_session_id === "done-native")?.id,
    );
    expect(ids).not.toContain(
      tree.nodes.find((node) => node.native_session_id === "cancel-native")?.id,
    );
    expect(arranged.manifest.cancelled_children).toContain(
      tree.nodes.find((node) => node.native_session_id === "cancel-native")?.id,
    );
    const quota = arranged.manifest.pending_children.find(
      (item) => item.native_session_id === "quota-native",
    );
    expect(quota?.last_status).toBe("interrupted");
    expect(quota?.interruption_reason).toBe("quota");
    expect(
      arranged.manifest.pending_children.find(
        (item) => item.conversation_id === grand.id,
      )?.parent_id,
    ).toBe(child.id);
    expect(
      arranged.manifest.completed_children.some(
        (item) => item.summary === "已写接口",
      ),
    ).toBe(true);
  });

  it("hashes the same pending set and is idempotent for repeated recover requests", async () => {
    const { conversations, controls, recovery, runPort } = openRecovery();
    const root = discoverRoot(conversations);
    spawnChild(conversations, "child-native", "root-native", "2");
    await controls.pauseTree("wf1", {
      request_id: "pause-hash",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    const first = await recovery.arrangeRecovery(
      "wf1",
      resumeRequest(root.id, "resume-a"),
      { reason: "user_resume" },
    );
    const second = await recovery.arrangeRecovery(
      "wf1",
      resumeRequest(root.id, "resume-b"),
      { reason: "user_resume" },
    );
    expect(second.recovery_id).toBe(first.recovery_id);
    expect(second.manifest.target_run_id).toBe(first.manifest.target_run_id);
    expect(recoveryContentHash(second.manifest)).toBe(
      recoveryContentHash(first.manifest),
    );
    expect(new Set(runPort.runs.map((item) => item.id)).size).toBe(1);
    const rebuilt = buildManifest({
      recovery_id: first.manifest.recovery_id,
      workflow_id: "wf1",
      root_conversation_id: root.id,
      source_run_id: "run1",
      target_run_id: first.manifest.target_run_id,
      reason: "user_resume",
      purpose: "implement",
      tree: conversations.getTree("wf1", root.id),
    });
    expect(recoveryContentHash(rebuilt)).toBe(recoveryContentHash(first.manifest));
  });

  it("invalidates quota retries after a user pause of the same tree", async () => {
    const { store, conversations, controls } = openRecovery();
    const root = discoverRoot(conversations);
    store.put("model_retry", "wf1", "wf1", {
      id: "wf1",
      run_id: "run1",
      plan_revision: 0,
      retry_at: Date.now() + 60_000,
      root_id: root.id,
      generation: 0,
    } satisfies ModelRetry);
    await controls.pauseTree("wf1", {
      request_id: "pause-retry",
      action: "pause",
      root_id: root.id,
      expected_generation: 0,
    });
    expect(store.get("model_retry", "wf1")).toBeUndefined();
    store.put("model_retry", "wf1", "wf1", {
      id: "wf1",
      run_id: "run1",
      plan_revision: 0,
      retry_at: Date.now() + 60_000,
      root_id: root.id,
      generation: 0,
    } satisfies ModelRetry);
    expect(isQuotaRetryBlocked(store, store.get<ModelRetry>("model_retry", "wf1")!)).toBe(
      true,
    );
    invalidateTreeRetry(store, "wf1", root.id);
    expect(store.get("model_retry", "wf1")).toBeUndefined();
    expect(quotaRetryAt("quota reached", 0)).toBeNull();
    const batch = readRetryBatch(store, "wf1", "run1");
    expect(
      isRetryBatchCurrent(
        { id: "wf1", plan_revision: 0, retry_at: 1, root_id: root.id, generation: 0 },
        batch,
      ),
    ).toBe(true);
    expect(
      isRetryBatchCurrent(
        { id: "wf1", plan_revision: 0, retry_at: 1, root_id: root.id, generation: 1 },
        batch,
      ),
    ).toBe(false);
  });

  it("keeps waiting ownership instead of rewriting it to executor", () => {
    const waiting: WaitingContext = {
      purpose: "review",
      role: "planner",
      phase: "after_human",
      run_id: "run-review",
      conversation_id: "cnv-review",
      intent: "need_user",
      created_at: "2026-09-20T00:00:00.000Z",
    };
    const continuation = preserveWaitingOwnership(waiting);
    expect(continuation.purpose).toBe("review");
    expect(continuation.role).toBe("planner");
    expect(continuation.phase).toBe("after_human");
    expect(continuation.source_run_id).toBe("run-review");
    expect(
      waitingPurposeFromRun("quality_review", "quality_before_human").phase,
    ).toBe("before_human");
    expect(waitingPurposeFromRun("planning").purpose).toBe("planning");
    expect(recoveryGuidanceText({
      recovery_id: "rcv-1",
      workflow_id: "wf1",
      root_conversation_id: "cnv-1",
      source_run_id: "run1",
      target_run_id: "run2",
      reason: "user_resume",
      purpose: "implement",
      pending_children: [],
      completed_children: [],
      cancelled_children: [],
      stage: "prepared",
    } as RecoveryManifest)).toContain(RECOVERY_GUIDANCE_TEXT);
  });
});
