import { expect, it, vi } from "vitest";
import { setup, repository, project, plan } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { ConversationControlService } from "../../packages/core/src/conversation-control.js";
import { saveWaitingContext, continuationForRecovery } from "../../packages/core/src/waiting-context.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import { currentRunUserGuidance } from "../../packages/runtime/src/profile-runtime.js";
import { unknownSubagentCapabilities, type Run, type Workflow } from "../../packages/contracts/src/index.js";

it.each(["executor_test", "planner_commit"] as const)("Engine stop → recover → dispatch retains %s guidance despite unrelated stale waiting", async purpose => {
  const s = setup();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const observed: Run[] = [];
  const guidance: Array<ReturnType<typeof currentRunUserGuidance>> = [];
  try {
    const repo = await repository(s.root);
    const prepareWorkspace = vi.spyOn(s.engine.git, "prepare");
    const p = project(repo.repo); s.store.put("project", p.id, p.id, p);
    const time = new Date().toISOString(), wid = "resume-guidance";
    const w: Workflow = { id: wid, project_id: p.id, title: "resume", request: "preserve current guidance", complexity: "simple",
      workspace_mode: "existing_workspace", quality_policy_version: 2, state: "QUEUED", stage: purpose,
      version: 1, plan_revision: 1, plan_hash: "approved", environment_revision: 0, feedback: [], created_at: time, updated_at: time };
    s.store.put("workflow", wid, p.id, w);
    s.store.put("plan", `${wid}-1`, wid, { revision: 1, hash: w.plan_hash, plan: { ...plan(objectHash(p), repo.baseline), task_model: "native-v2" } });
    s.store.put("approval", `${wid}-1`, wid, { plan_hash: w.plan_hash });
    s.store.put("pending_dispatch_purpose", wid, wid, { purpose });
    const message = new FeedbackService(s.store).submitFeedback({ request_id: "current-user-guidance", workflow_id: wid, kind: "execution",
      text: "先回答 OpenTabs 做过没有，再继续本轮剩余工作，保留已有成果" });
    const conversations = new ConversationService(s.store);
    conversations.setCapabilities(wid, { ...unknownSubagentCapabilities(), resume: "native", stop: "native" });
    const controls = new ConversationControlService(s.store, conversations, {
      stopConversation: async () => ({ accepted: true, confirmation: "exited" }),
    });
    s.engine.pauseTree = (key, input) => controls.pauseTree(key, input);
    s.engine.runtime = {
      execute: async (_workflow, run) => {
        observed.push(run);
        guidance.push(currentRunUserGuidance(s.store, wid, run));
        if (observed.length === 1) {
          s.store.put("run", run.id, wid, { ...run, conversation_id: "same-native-session" });
          conversations.applyEvent({ project_id: p.id, workflow_id: wid, run_id: run.id, adapter_id: run.adapter,
            scope: "execution", lineage_id: "main", purpose, root_native_id: "same-native-session" }, {
            source_id: "fixture", source_seq: "1", kind: "discovered", root_native_id: "same-native-session", session_native_id: "same-native-session",
            payload: { title: "Current task", status: "running" },
          });
          // Reproduce the persisted old need_user from a previously answered invocation.
          s.store.put("run", "old-waiting-run", wid, { ...run, id: "old-waiting-run", status: "completed" });
          saveWaitingContext(s.store, wid, { run_id: "old-waiting-run", purpose: "execute", role: "executor", intent: "need_user", original_text: "Old question already handled" });
          await paused;
        } else {
          await s.engine.receiveRoundResult(wid, run.id, { status: "need_user", summary: "Fixture stops after observing the bound recovery" });
        }
      },
      review: async () => { throw new Error("Unexpected review"); },
      stop: async () => { release(); return { status: "confirmed_not_started" }; },
      close: async () => {}, check: async () => { throw new Error("Unexpected check"); },
    };
    s.engine.scheduler.enqueue(wid, p.id);
    await s.engine.dispatch();
    await expect.poll(() => observed.length, { timeout: 15000 }).toBe(1);
    const first = observed[0]!;
    expect(s.store.must<any>("feedback_message", message.message_id).ack_run).toBe(first.id);
    await s.engine.stop(wid);
    await s.engine.waitForIdle(wid);
    expect(s.engine.get(wid).state).toBe("STOPPED");
    expect(s.store.must<Run>("run", first.id).status).toBe("stopped");
    expect(s.store.get("execution_completion", first.id)).toBeUndefined();
    resumeApproved(s.engine, wid);
    const recovery = s.store.list<any>("conversation_recovery", wid).at(-1);
    expect(recovery.source_run_id).toBe(first.id);
    expect(s.store.must<Run>("run", recovery.target_run_id).continuation).toMatchObject({
      source_run_id: first.id, kind: "runtime_resume", role: purpose === "planner_commit" ? "planner" : "executor",
    });
    await s.engine.dispatch();
    await expect.poll(() => observed.length, { timeout: 15000 }).toBe(2);
    await s.engine.waitForIdle(wid);
    expect(observed[1]).toMatchObject({ purpose, continuation: { kind: "runtime_resume", source_run_id: first.id } });
    expect(guidance[1]).toBeUndefined();
    expect(prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(s.store.events(wid).filter(event => event.type === "PreparationStarted")).toHaveLength(1);
    expect(JSON.stringify(observed[1]?.continuation)).not.toContain("old-waiting-run");
  } finally {
    release();
    await s.engine.waitForIdle("resume-guidance");
    s.store.close();
  }
}, 45000);

it("keeps current waiting details but never lets unrelated waiting override the explicit recovery source", () => {
  const fallback = { source_run_id: "current", purpose: "execute" as const, role: "executor" as const };
  const waiting = { purpose: "execute" as const, role: "executor" as const, run_id: "old", intent: "need_user" as const,
    original_text: "question", created_at: new Date().toISOString() };
  expect(continuationForRecovery(waiting, fallback)).toMatchObject({ source_run_id: "current", kind: "runtime_resume" });
  expect(continuationForRecovery({ ...waiting, run_id: "current" }, fallback)).toMatchObject({ source_run_id: "current", original_text: "question" });
});
