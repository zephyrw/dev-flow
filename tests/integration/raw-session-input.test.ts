import { expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { Run } from "../../packages/contracts/src/index.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";

it("passes exact follow-up bytes to a real CLI process in the same session without generating or reading a handoff", async () => {
  const s = setup();
  const repo = await repository(s.root);
  const p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({project_id: p.id, title: "Raw session test", request: "initial task",
    complexity: "simple", workspace_mode: "existing_workspace"}, "raw-create");
  await s.engine.git.prepare(p, created.id, "existing_workspace", {main: repo.baseline});
  s.store.put("plan", `${created.id}-1`, created.id, {revision: 1, hash: "plan", plan: plan("project", repo.baseline)});
  const processes = new ProcessManager();
  const runtime = new ProfileRuntime(s.engine, processes);
  const w = {...created, plan_revision: 1, plan_hash: "plan", binding_strategy: "unified" as const};
  s.store.put("workflow", w.id, w.project_id, w);
  const makeRun = (id: string): Run => ({id, workflow_id: w.id, plan_revision: w.plan_revision,
    adapter: "codex", purpose: "implement", stage: "execute", protocol: "lightweight", status: "running",
    started_at: new Date().toISOString(), package_hash: "fixture", profile: {id: "raw-profile", revision: 1,
      adapterId: "codex", executableRef: process.execPath, modelSelection: "explicit", modelId: "fixture-model",
      options: {prefixArgs: [resolve("tests/fixtures/raw-session-cli.mjs")]}}});
  const invoke = async (run: Run, materials: () => unknown) => {
    s.store.put("run", run.id, w.id, run);
    s.store.put("workflow", w.id, w.project_id, {...w, state: "EXECUTING", run_id: run.id});
    return (runtime as any).invoke(s.engine.get(w.id), run, materials, {});
  };
  try {
    const first = makeRun("raw-first");
    const initial = vi.fn(() => ({instructions: "Initial stage requirements"}));
    await invoke(first, initial);
    expect(initial).toHaveBeenCalledOnce();
    const session = s.store.must<Run>("run", first.id).conversation_id;
    expect(session).toBeTruthy();
    expect(existsSync(join(s.config.storage_root, "native-runs", first.id, "HANDOFF.json"))).toBe(true);
    const run = makeRun("raw-followup");
    const raw = "  不要读取任务包。\r\n请回答当前问题！\n";
    const message = new FeedbackService(s.store).submitFeedback({request_id: "raw-text", workflow_id: w.id, kind: "execution", text: raw});
    s.store.put("feedback_message", message.message_id, w.id, {...message, status: "acknowledged", ack_run: run.id});
    const nextMessage = new FeedbackService(s.store).submitFeedback({request_id: "next-text", workflow_id: w.id,
      kind: "execution", text: "第二条独立指导"});
    s.store.put("feedback_message", nextMessage.message_id, w.id, {...nextMessage, status: "acknowledged", ack_run: run.id});
    const materials = vi.fn(() => { throw new Error("A follow-up must never generate stage materials"); });
    s.store.put("model_input_feedback", run.id, w.id, {message: "额外的系统修复指导"});
    const result = await invoke(run, materials);
    expect(materials).not.toHaveBeenCalled();
    expect(result.captured_text).toBe(raw);
    expect(result.captured_args).not.toContain("--output-schema");
    expect(s.store.get("feedback_message", nextMessage.message_id)).toMatchObject({status: "pending"});
    expect(s.store.must<Run>("run", run.id).conversation_id).toBe(session);
    expect(existsSync(join(s.config.storage_root, "native-runs", run.id, "HANDOFF.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.config.storage_root, "native-runs", run.id, "input.json"), "utf8")).text).toBe(raw);
    expect(s.store.get("session_input", run.id)).toMatchObject({state: "delivered", kind: "followup", message_ids: [message.message_id]});
    const resumed = {...makeRun("raw-resumed"), continuation: {kind: "runtime_resume" as const, source_run_id: run.id,
      purpose: "execute" as const, role: "executor" as const, conversation_id: session}};
    expect((await invoke(resumed, materials)).captured_text).toBe("继续");
    expect(materials).not.toHaveBeenCalled();
    expect(s.store.must<Run>("run", resumed.id).conversation_id).toBe(session);

    const otherTool = {...first, id: "other-tool-source", adapter: "agy", profile: {...first.profile!, adapterId: "agy"},
      conversation_id: "other-tool-session", status: "completed" as const};
    s.store.put("run", otherTool.id, w.id, otherTool);
    const testing = {...makeRun("new-testing-stage"), purpose: "executor_test" as const, stage: "executor_test",
      dispatch_context: {purpose: "executor_test" as const, source_run_id: otherTool.id}};
    const testingRaw = "  你是卡住了吗？\r\n先回答我，再查看日志。\n";
    const testingMessage = new FeedbackService(s.store).submitFeedback({request_id: "stage-text", workflow_id: w.id,
      kind: "execution", text: testingRaw});
    s.store.put("feedback_message", testingMessage.message_id, w.id, {...testingMessage, status: "acknowledged", ack_run: testing.id});
    s.store.put("model_input_feedback", testing.id, w.id, {message: "不要把这段注入用户指导"});
    expect((await invoke(testing, materials)).captured_text).toBe(testingRaw);
    expect(materials).not.toHaveBeenCalled();
    const testingRoot = join(s.config.storage_root, "native-runs", testing.id);
    expect(existsSync(join(testingRoot, "HANDOFF.json"))).toBe(false);
    expect(existsSync(join(testingRoot, "CROSS_TOOL_HISTORY.jsonl"))).toBe(false);
    expect(s.store.get("session_input", testing.id)).toMatchObject({state: "delivered", user_input: true,
      message_ids: [testingMessage.message_id]});
  } finally {
    await processes.close();
    s.store.close();
  }
}, 60000);

it("records definitely unstarted user input before account admission can reject a run with an old session ID", async () => {
  const s = setup();
  const runtime = new ProfileRuntime(s.engine, new ProcessManager());
  const w = {id: "preflight-workflow", project_id: "project"} as any;
  const run: Run = {id: "admission-run", workflow_id: w.id, plan_revision: 1, adapter: "agy", purpose: "executor_test",
    stage: "executor_test", status: "running", started_at: new Date().toISOString(), package_hash: "fixture",
    conversation_id: "old-session", profile: {id: "agy-profile", revision: 1, adapterId: "agy",
      modelSelection: "explicit", modelId: "fixture-model", options: {}}};
  s.store.put("run", run.id, w.id, run);
  const message = new FeedbackService(s.store).submitFeedback({request_id: "preflight-text", workflow_id: w.id,
    kind: "execution", text: "  你是卡住了吗？\r\n"});
  s.store.put("feedback_message", message.message_id, w.id, {...message, status: "acknowledged", ack_run: run.id});
  const prepareProfileRun = vi.fn(async () => {throw new Error("account admission timed out before native start");});
  (runtime as any).accountBridge = {prepareProfileRun};
  const materials = vi.fn();
  try {
    await expect((runtime as any).invoke(w, run, materials, {})).rejects.toThrow("account admission timed out");
    expect(prepareProfileRun).toHaveBeenCalledOnce();
    expect(materials).not.toHaveBeenCalled();
    expect(s.store.get("session_input", run.id)).toMatchObject({state: "prepared", user_input: true,
      message_ids: [message.message_id], conversation_id: "old-session"});
    expect(s.store.get("feedback_message", message.message_id)).toMatchObject({text: message.text, ack_run: run.id});
  } finally {
    s.store.close();
  }
});
