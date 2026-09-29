import { afterEach, expect, it, vi } from "vitest";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";
import { CONVERSATION_ENTITY } from "../../packages/contracts/src/conversation.js";
import { CONVERSATION_CONTROL_FENCE } from "../../packages/core/src/conversation-control.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import * as profiles from "../../packages/core/src/run-profile.js";

afterEach(() => vi.restoreAllMocks());

async function prepare(purpose: "implement" | "executor_test" | "quality_review" = "implement") {
  const s = await fixture();
  const reviewing = purpose === "quality_review";
  const w = s.engine.get(s.w.id);
  s.store.put("workflow", w.id, w.project_id, { ...w,
    state: reviewing ? "REVIEW_QUEUED" : "QUEUED",
    stage: reviewing ? "quality_before_human" : purpose === "implement" ? "execute" : purpose,
  });
  s.store.put("pending_dispatch_purpose", w.id, w.id, {
    purpose, ...(reviewing ? { review_phase: "before_human" } : {}),
  });
  s.store.put("workspace", "fixture-workspace", w.id, {
    id: "fixture-workspace", workflow_id: w.id, repo_id: "main", root: s.repo,
    common_dir: s.repo, baseline: s.baseline, branch: "task/fixture", owned: false,
  });
  vi.spyOn(s.engine.git, "prepare").mockResolvedValue([]);
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  vi.spyOn(profiles, "bindProfile").mockImplementation((_store, _config, _key, selected) => ({
    purpose: selected, profile: { id: "isolated", revision: 1, adapterId: "codex", executableRef: "unused", modelSelection: "explicit", modelId: "fixture" },
    routing_role: selected === "quality_review" ? "reviewer" : "executor", protocol: "lightweight",
  } as any));
  const invoke = vi.fn<(w: unknown, run: Run) => Promise<never>>();
  s.engine.runtime = { execute: invoke, review: invoke, stop: async () => ({ status: "confirmed_exited" }) } as any;
  const run = (runId = "formal-run") => (s.engine as any).run(w.id, runId, reviewing, []);
  return { ...s, invoke, run };
}

function pause(s: Awaited<ReturnType<typeof prepare>>, run: Run) {
  const id = "control-fixture";
  s.store.put(CONVERSATION_CONTROL_FENCE, id, s.w.id, {
    id, workflow_id: s.w.id, control_id: id, run_id: run.id,
    root_id: "root-fixture", expected_generation: 2, dispatch_frozen: true,
  });
  s.store.put(CONVERSATION_ENTITY.control, id, s.w.id, {
    id, workflow_id: s.w.id, action: "pause", root_id: "root-fixture", expected_generation: 2,
    status: "pending", unconfirmed_count: 1, targets: [{ conversation_id: "root-fixture", status: "pausing" }],
  });
  s.store.put("process_record", run.id, s.w.id, { id: run.id, status: "exited", confirmed: true });
  return new FlowError("RUN_REVOKED", "root agent idle; waiting for background task", 422, { termination_reason: "manual" });
}

it.each(["executor_test", "quality_review"] as const)("formal pause before control completion stops normally and preserves %s on feedback", async (purpose) => {
  const s = await prepare(purpose);
  try {
    s.invoke.mockImplementation(async (_w, run) => { throw pause(s, run); });
    await s.run();
    expect(s.engine.get(s.w.id).state).toBe("STOPPED");
    expect(s.engine.get(s.w.id).blocker).toBeUndefined();
    expect(s.store.get<Run>("run", "formal-run")?.status).toBe("stopped");
    expect(s.store.get<any>("interruption", s.w.id)).toMatchObject({ category: "pause", prior_purpose: purpose });
    expect(s.store.events(s.w.id).some((e) => e.type === "StateChanged" && (e.payload as { to?: string }).to === "BLOCKED")).toBe(false);
    // pauseTree finishes after the process-exit callback, as in the real race.
    const control = s.store.get<any>(CONVERSATION_ENTITY.control, "control-fixture");
    s.store.put(CONVERSATION_ENTITY.control, control.id, s.w.id, { ...control, status: "complete", unconfirmed_count: 0 });
    const message = new FeedbackService(s.store).submitFeedback({ request_id: "guidance", workflow_id: s.w.id, kind: "execution", text: "continue with the new guidance" });
    s.engine.queueFormalFeedback(s.w.id, message.message_id);
    expect(s.engine.get(s.w.id)).toMatchObject({ state: purpose === "quality_review" ? "REVIEW_QUEUED" : "QUEUED",
      stage: purpose === "quality_review" ? "quality_before_human" : "executor_test" });
    if (purpose === "executor_test") expect(s.store.get<any>("pending_dispatch_purpose", s.w.id)?.purpose).toBe("executor_test");
    expect(s.store.get<any>("feedback_message", message.message_id)?.status).toBe("pending");
  } finally { await cleanup(s); }
});

it.each(["foreign-run", "generation", "unknown-stop", "partial-control", "unknown-child", "unconfirmed-complete", "non-manual", "real-error"] as const)("formal pause does not suppress %s", async (kind) => {
  const s = await prepare("quality_review");
  try {
    s.invoke.mockImplementation(async (_w, run) => {
      let error = pause(s, run);
      const fence = s.store.get<any>(CONVERSATION_CONTROL_FENCE, "control-fixture");
      if (kind === "foreign-run") s.store.put(CONVERSATION_CONTROL_FENCE, fence.id, s.w.id, { ...fence, run_id: "another-run" });
      if (kind === "generation") s.store.put(CONVERSATION_CONTROL_FENCE, fence.id, s.w.id, { ...fence, expected_generation: 1 });
      if (kind === "unknown-stop") s.store.put("process_record", run.id, s.w.id, { status: "failed", confirmed: false });
      const control = s.store.get<any>(CONVERSATION_ENTITY.control, "control-fixture");
      if (kind === "partial-control") s.store.put(CONVERSATION_ENTITY.control, control.id, s.w.id, { ...control, status: "partial" });
      if (kind === "unconfirmed-complete") s.store.put(CONVERSATION_ENTITY.control, control.id, s.w.id, { ...control, status: "complete", unconfirmed_count: 1 });
      if (kind === "unknown-child") s.store.put(CONVERSATION_ENTITY.control, control.id, s.w.id, { ...control,
        targets: [...control.targets, { conversation_id: "child", status: "unknown", confirmation: "unconfirmed" }],
      });
      if (kind === "non-manual") error = new FlowError("RUN_REVOKED", "unrelated revocation");
      if (kind === "real-error") error = new FlowError("MODEL_AUTH", "login expired");
      throw error;
    });
    await s.run();
    expect(s.engine.get(s.w.id).state).toBe("BLOCKED");
    expect(s.store.get("run_stop", "formal-run")).toBeUndefined();
    expect(s.store.get<Run>("run", "formal-run")?.status).toBe("failed");
  } finally { await cleanup(s); }
});

it.each([
  { purpose: "none", role: "none", revision: 1, resumed: false },
  { purpose: "planning", role: "planner", revision: 1, resumed: false },
  { purpose: "executor_test", role: "executor", revision: 1, resumed: false },
  { purpose: "implement", role: "review_fixer", revision: 1, resumed: false },
  { purpose: "implement", role: "executor", revision: 0, resumed: false },
  { purpose: "implement", role: "executor", revision: 1, resumed: true },
])("resumed=$resumed requires a prior matching purpose/role/revision ($purpose/$role/$revision)", async (previous) => {
  const s = await prepare();
  try {
    if (previous.purpose !== "none") s.store.put("run", "prior", s.w.id, { id: "prior", workflow_id: s.w.id, purpose: previous.purpose,
      routing_role: previous.role, plan_revision: previous.revision, status: "stopped" });
    s.invoke.mockImplementation(async (_w, run) => { throw pause(s, run); });
    await s.run();
    const event = s.store.events(s.w.id).findLast((e) => e.type === "StateChanged" && (e.payload as { to?: string }).to === "EXECUTING");
    expect((event?.payload as { resumed?: boolean } | undefined)?.resumed).toBe(previous.resumed);
    expect(s.engine.get(s.w.id)).not.toHaveProperty("resumed");
  } finally { await cleanup(s); }
});

it.each([false, true])("preparation reuses existing workspaces only when every repository is present (%s)", async (allPresent) => {
  const s = await prepare();
  try {
    vi.mocked(s.engine.dispatch).mockRestore();
    vi.spyOn(s.engine as any, "run").mockResolvedValue(undefined);
    const project = s.engine.project(s.w.project_id);
    s.store.put("project", project.id, project.id, { ...project, repositories: [...project.repositories, { ...project.repositories[0], id: "second" }] });
    if (allPresent) s.store.put("workspace", "second", s.w.id, { id: "second", repo_id: "second", root: s.repo });
    await s.engine.dispatch();
    const event = s.store.events(s.w.id).findLast((e) => e.type === "PreparationStarted");
    const message = (event?.payload as { message?: string } | undefined)?.message;
    expect(message).toBe(allPresent ? undefined : "正在检查主工作区");
    expect(s.store.get<any>("queue_wait", s.w.id)?.message)
      .toContain(allPresent ? "正在连接模型会话" : "正在检查主工作区");
  } finally {
    (s.engine as any).running.delete(s.w.id);
    await cleanup(s);
  }
});
