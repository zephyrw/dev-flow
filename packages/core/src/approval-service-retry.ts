import type { Run, Workflow } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { isQuotaRetryBlocked, isRetryBatchCurrent, readRetryBatch, type ModelRetry } from "./model-retry.js";
import { hash } from "./util.js";

export const APPROVAL_RETRY_DELAYS = [15_000, 30_000, 60_000] as const;
export const APPROVAL_FAILURE_ENTITY = "approval_service_failure";
export const APPROVAL_CONSUMED_ENTITY = "approval_service_failure_consumed";
export const APPROVAL_RETRY_ENTITY = "approval_service_retry";
export const APPROVAL_BUDGET_ENTITY = "approval_service_retry_budget";
export const APPROVAL_CAPACITY_ERROR = "Automatic approval review failed: Selected model is at capacity. Please try a different model.\nThe action was not executed because automatic approval review could not be completed. This is a review failure, not a determination that the action is unsafe. Do not bypass the approval check; resolve the error or ask the user for guidance.";

export interface ApprovalServiceFailure {
  run_id: string;
  native_session_id: string;
  tool_call_id: string;
  observed_at: string;
  code: "APPROVAL_SERVICE_CAPACITY";
  input_hash?: string;
}
export interface ApprovalServiceRetry extends ModelRetry {
  run_id: string;
  attempt: number;
  native_session_id: string;
}

/** Match the executor's error envelope, never a command's stdout or model text. */
export function isApprovalCapacityToolError(payload: Record<string, unknown>): boolean {
  if (payload.type !== "custom_tool_call_output" || !Array.isArray(payload.output) || payload.output.length !== 2) return false;
  const [header, error] = payload.output;
  if (header?.type !== "input_text" || error?.type !== "input_text" ||
      typeof header.text !== "string" || typeof error.text !== "string" ||
      !/^Script failed\nWall time [\d.]+ seconds\nOutput:\n$/.test(header.text)) return false;
  // Rust CreateProcess debug output contains a JSON string around Rejected(...).
  const match = /^Script error:\nexec_command failed: CreateProcess \{ message: (".*") \}$/.exec(error.text);
  if (!match) return false;
  try {
    const rejected: unknown = JSON.parse(match[1]!);
    if (typeof rejected !== "string" || !rejected.startsWith("Rejected(") || !rejected.endsWith(")")) return false;
    return JSON.parse(rejected.slice(9, -1)) === APPROVAL_CAPACITY_ERROR;
  } catch { return false; }
}

/** Receives only time/cwd/session-verified root records from CodexSessionObserver. */
export class ApprovalFailureObserver {
  private calls = new Map<string, string>();
  constructor(private store: Store, private workflowId: string, private runId: string) {}
  accept(row: Record<string, unknown>, nativeSessionId: string) {
    const run = this.store.get<Run>("run", this.runId);
    const w = this.store.get<Workflow>("workflow", this.workflowId);
    if (!run || !w || w.run_id !== run.id || run.workflow_id !== w.id ||
        (run.profile?.adapterId ?? run.adapter) !== "codex" || run.conversation_id !== nativeSessionId ||
        run.status !== "running" || this.store.get("run_stop", run.id) ||
        !["EXECUTING", "VERIFYING"].includes(w.state) || row.type !== "response_item") return;
    const payload = row.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload.call_id !== "string") return;
    if (payload.type === "custom_tool_call" && (payload.name === "exec" || payload.name === "functions.exec") &&
        typeof payload.input === "string") {
      this.calls.set(payload.call_id, hash(payload.input));
      return;
    }
    if (payload.type !== "custom_tool_call_output" || !this.calls.has(payload.call_id)) return;
    const inputHash = this.calls.get(payload.call_id)!;
    this.calls.delete(payload.call_id);
    if (isApprovalCapacityToolError(payload)) {
      this.store.put(APPROVAL_FAILURE_ENTITY, run.id, w.id, {
        run_id: run.id, native_session_id: nativeSessionId, tool_call_id: payload.call_id,
        observed_at: String(row.timestamp), code: "APPROVAL_SERVICE_CAPACITY", input_hash: inputHash,
      } satisfies ApprovalServiceFailure);
    } else if (Array.isArray(payload.output) && (
      payload.output.some((part) => part?.type === "input_text" && typeof part.text === "string" &&
        part.text.startsWith("Script error:\n")) ||
      this.store.get<ApprovalServiceFailure>(APPROVAL_FAILURE_ENTITY, run.id)?.input_hash === inputHash)) {
      // A success for the identical invocation, or a later platform error,
      // supersedes the failure. Other successful checks need not resolve it.
      this.store.remove(APPROVAL_FAILURE_ENTITY, run.id);
    }
  }
}

export function approvalBudgetKey(run: Run): string {
  // A manual resume or a new native invocation must not reset the automatic budget.
  return `${run.workflow_id}:${run.plan_revision}:${run.purpose ?? run.stage}`;
}

export function currentApprovalFailure(store: Store, w: Workflow, run: Run | undefined, reason: string) {
  if (!run || w.run_id !== run.id || run.workflow_id !== w.id || run.plan_revision !== w.plan_revision ||
      !["running", "completed", "failed"].includes(run.status) || !run.conversation_id || !run.profile || !run.frozen_invocation ||
      run.profile.adapterId !== "codex" || !["EXECUTING", "VERIFYING"].includes(w.state) ||
      store.get("run_stop", run.id) || store.get("run_continuation_superseded", run.id) ||
      store.get(APPROVAL_CONSUMED_ENTITY, run.id) ||
      !/(?:自动审批|automatic approval review)[\s\S]*(?:容量不足|暂不可用|暂时不可用|at capacity)/i.test(reason)) return;
  const failure = store.get<ApprovalServiceFailure>(APPROVAL_FAILURE_ENTITY, run.id);
  if (!failure || failure.native_session_id !== run.conversation_id || failure.run_id !== run.id ||
      failure.code !== "APPROVAL_SERVICE_CAPACITY") return;
  return failure;
}

export function approvalRetryCurrent(store: Store, retry: ApprovalServiceRetry): boolean {
  const w = store.get<Workflow>("workflow", retry.id);
  const run = store.get<Run>("run", retry.run_id);
  return !!w && !!run && w.state === "BLOCKED" && w.blocker?.code === "APPROVAL_SERVICE_UNAVAILABLE" &&
    w.run_id === retry.run_id && w.plan_revision === retry.plan_revision && w.plan_hash === retry.plan_hash &&
    run.conversation_id === retry.native_session_id && !store.get("run_stop", run.id) &&
    !store.get("run_continuation_superseded", run.id) && !isQuotaRetryBlocked(store, retry) &&
    isRetryBatchCurrent(retry, readRetryBatch(store, retry.id, retry.run_id));
}

export const APPROVAL_RETRY_INSTRUCTION = "原生工具确认：自动审批服务容量不足，受审批阻止的操作未执行。请先核对当前现场，只重试该受阻操作并继续原任务；不要回放整个脚本或重复已完成的操作。保持原模型、账号、会话和审批机制，不跳过审批、不切换模型或sandbox。若发生真实安全拒绝、权限不足、取消或需要其他用户决定，请停止并明确说明。";
