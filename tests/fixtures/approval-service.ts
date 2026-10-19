import { setup, project, plan } from "../helpers.js";
import { bindProfile } from "../../packages/core/src/run-profile.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";
import { APPROVAL_CAPACITY_ERROR, ApprovalFailureObserver } from "../../packages/core/src/approval-service-retry.js";
import { removeDirWithBoundedRetry } from "./isolation.js";

export const SESSION = "019947a2-8a00-7000-8000-000000000001";
export const CHILD = "019947a2-8a00-7000-8000-000000000002";
export function approvalOutput(message = APPROVAL_CAPACITY_ERROR) {
  return { type: "custom_tool_call_output", call_id: "call-1", output: [
    { type: "input_text", text: "Script failed\nWall time 10.4 seconds\nOutput:\n" },
    { type: "input_text", text: "Script error:\nexec_command failed: CreateProcess { message: " +
      JSON.stringify("Rejected(" + JSON.stringify(message) + ")") + " }" },
  ] };
}
export const capacityResult = { status: "need_user", summary: "已核对文件，但暂存被权限阻止，尚未创建提交。",
  notes: "自动审批因模型容量不足未能完成，受阻操作未执行。" };
export function approvalFixture() {
  const s = setup();
  const time = new Date().toISOString();
  const w: Workflow = { id: "approval-test", project_id: "p1", title: "审批恢复", request: "提交",
    complexity: "simple", workspace_mode: "existing_workspace", state: "EXECUTING", stage: "planner_commit",
    quality_policy_version: 2, version: 1, plan_revision: 1, plan_hash: "approved-hash", run_id: "run-1",
    environment_revision: 0, feedback: [], created_at: time, updated_at: time };
  s.store.put("project", "p1", "p1", project(s.root));
  s.store.put("workflow", w.id, "p1", w);
  s.store.put("plan", `${w.id}-1`, w.id, { revision: 1, hash: w.plan_hash,
    plan: { ...plan("project-hash", "a".repeat(40)), task_model: "native-v2" } });
  const binding = bindProfile(s.store, s.config, w.id, "planner_commit");
  const run: Run = { ...binding, id: w.run_id!, workflow_id: w.id, plan_revision: 1, adapter: "codex",
    purpose: "planner_commit", stage: "planner_commit", status: "running", started_at: time,
    package_hash: "fixture", conversation_id: SESSION, dispatch_context: { purpose: "planner_commit", review_phase: "after_human" } };
  s.store.put("run", run.id, w.id, run);
  const observer = new ApprovalFailureObserver(s.store, w.id, run.id);
  const accept = (payload: Record<string, unknown>, session = SESSION) =>
    observer.accept({ type: "response_item", timestamp: new Date().toISOString(), payload }, session);
  const fail = () => {
    accept({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: "await tools.exec_command({cmd: 'git add app.txt'})" });
    accept(approvalOutput());
  };
  return { ...s, w, run, observer, accept, fail, async cleanup() { s.store.close(); await removeDirWithBoundedRetry(s.root); } };
}
