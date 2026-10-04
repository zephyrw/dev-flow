import type { Engine } from "./engine.js";
import type { Store } from "../../store/src/store.js";
import { FlowError, type Run, type UserInteractionRecord, type Workspace } from "../../contracts/src/index.js";
import { objectHash, redact, now } from "./util.js";
import { UserInteractionService, interactionConversationContext } from "./user-interaction-service.js";
import { saveWaitingContext, waitingPurposeFromRun } from "./waiting-context.js";
import { highRiskDiagnostic } from "../../presentation/src/secret-redactor.js";

export const NATIVE_PERMISSION_ENTITY = "native_permission";
export const NATIVE_TOOL_PERMISSION_ENTITY = "native_tool_permission";
interface NativeToolPermission {
  id: string;
  adapter: "agy";
  tool: "call_mcp_tool";
  granted_at: string;
  source: string;
}

/** Only the human console may create this persistent, instance-wide grant. */
export function grantNativeMcpTool(store: Store, source: string) {
  const id = "agy:call_mcp_tool";
  const existing = store.get<NativeToolPermission>(NATIVE_TOOL_PERMISSION_ENTITY, id);
  if (existing) return existing;
  const grant: NativeToolPermission = { id, adapter: "agy", tool: "call_mcp_tool", granted_at: now(), source };
  store.put(NATIVE_TOOL_PERMISSION_ENTITY, id, "global", grant);
  return grant;
}

export function hasNativeMcpToolPermission(store: Store) {
  return !!store.get<NativeToolPermission>(NATIVE_TOOL_PERMISSION_ENTITY, "agy:call_mcp_tool");
}
export interface NativePermissionCall {
  name: string;
  parameters: Record<string, unknown>;
}
export interface NativePermissionRequest {
  id: string;
  workflow_id: string;
  source_run_id: string;
  plan_revision: number;
  plan_hash?: string;
  conversation_id: string;
  purpose: Run["purpose"];
  profile_hash: string;
  account_scope?: string;
  workspace_hash: string;
  calls: Array<NativePermissionCall & { fingerprint: string; consumed_by?: string }>;
  decision?: "allow" | "deny";
  decided_at?: string;
  bound_run_id?: string;
}

export function pauseForNativePermission(engine: Engine, run: Run, calls: NativePermissionCall[], description: string, recoverBlocked = false) {
  const w = engine.get(run.workflow_id);
  const source = engine.store.must<Run>("run", run.id);
  // Recovery verifies the native denial before calling this with a generic old blocker.
  const recoverable = recoverBlocked && w.state === "BLOCKED";
  if (w.run_id !== run.id || (!recoverable && !["EXECUTING", "VERIFYING", "REVIEWING", "PLANNING", "COMMITTING"].includes(w.state)) ||
      engine.store.get("run_stop", run.id) || !source.conversation_id) return;
  const conversationId = source.conversation_id;
  const owner = waitingPurposeFromRun(run.purpose, run.stage);
  const context = interactionConversationContext(engine.store, w.id, run.id, source.conversation_id);
  return engine.store.transaction(() => {
    const rawDetail = calls.map(call => `工具：${call.name}\n参数与目标：${JSON.stringify(call.parameters)}`).join("\n\n");
    const detail = redact(rawDetail);
    const toolWide = source.adapter === "agy" && calls.length > 0 && calls.every(call => call.name === "call_mcp_tool");
    const safeDetail = detail.length <= 3500 && detail === rawDetail && !highRiskDiagnostic(rawDetail);
    const known = toolWide || calls.length > 0 && safeDetail;
    const interaction = new UserInteractionService(engine.store).createInteraction({
      workflowId: w.id, sourceRunId: run.id, sourcePlanRevision: source.plan_revision,
      ...context, purpose: owner.purpose, role: owner.role,
      rawInput: known ? {
        kind: "question", title: toolWide ? "永久授权 call_mcp_tool 工具" : "授权本次工具操作",
        message: (safeDetail ? detail : "工具：call_mcp_tool") + (toolWide
          ? "\n永久授权整个 call_mcp_tool 工具，覆盖所有 MCP 服务、子工具和任意参数。对当前及后续所有任务生效，服务重启后仍有效，不再逐次询问。"
          : "\n仅对原会话中上述具体调用授权一次。改变工具、参数、目标或会话需要重新授权。"),
        question: toolWide ? "是否永久允许此工具的所有调用？" : "是否允许执行上述操作？", allow_free_text: false, action_label: "提交授权决定",
        choices: [{ id: toolWide ? "allow_tool" : "allow_once", label: toolWide ? "永久授权此工具" : "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }],
      } : {
        kind: "action_required", title: "工具权限需要处理",
        message: "AGY 返回权限拒绝，具体调用包含敏感内容、参数缺失或无法完整展示。请在 AGY 中核对具体操作和权限后继续；此按钮不会自动授予未知操作权限。",
        action_label: "已处理权限，继续",
      },
    });
    if (known) engine.store.put(NATIVE_PERMISSION_ENTITY, interaction.id, w.id, {
      id: interaction.id, workflow_id: w.id, source_run_id: run.id,
      plan_revision: source.plan_revision, plan_hash: w.plan_hash,
      conversation_id: conversationId, purpose: run.purpose,
      profile_hash: objectHash(source.profile), account_scope: accountScope(source),
      workspace_hash: workspaceHash(engine.store, w.id),
      calls: calls.map(call => ({ name: call.name, parameters: safeDetail ? call.parameters : {}, fingerprint: objectHash(call) })),
    } satisfies NativePermissionRequest);
    saveWaitingContext(engine.store, w.id, {
      ...owner, run_id: run.id, conversation_id: source.conversation_id,
      source_execution_run_id: owner.purpose === "execute" ? run.id : undefined,
      original_text: interaction.request.message, intent: "need_user", interaction_id: interaction.id,
    });
    engine.store.put("run", run.id, w.id, { ...source, status: "waiting", ended_at: now() });
    engine.transition(w.id, [w.state], "WAITING_INPUT", run.stage, {
      blocker: { code: "NEED_USER", message: known ? "等待你授权本次工具操作" : "等待处理工具权限" },
    });
    engine.store.event(w.id, w.project_id, "NativePermissionRequested", { interaction_id: interaction.id, source_run_id: run.id }, run.id);
    return interaction;
  });
}

/** Called only after the human-response service has validated the waiting owner. */
export function decideNativePermission(store: Store, record: UserInteractionRecord, choice?: string) {
  const request = store.get<NativePermissionRequest>(NATIVE_PERMISSION_ENTITY, record.id);
  if (!request) return;
  const w = store.must<{ plan_hash?: string }>("workflow", record.workflow_id);
  const run = store.must<Run>("run", record.source_run_id);
  if (request.source_run_id !== record.source_run_id || request.plan_hash !== w.plan_hash ||
      request.profile_hash !== objectHash(run.profile) || request.account_scope !== accountScope(run) ||
      request.workspace_hash !== workspaceHash(store, record.workflow_id) ||
      request.conversation_id !== record.native_session_id || !["allow_tool", "allow_once", "deny"].includes(choice ?? "") ||
      (choice === "allow_tool" && (run.adapter !== "agy" || !request.calls.length || request.calls.some(call => call.name !== "call_mcp_tool"))))
    throw new FlowError("INTERACTION_STALE", "权限请求或操作已变化，请刷新后重新授权", 409);
  const decision = choice === "deny" ? "deny" : "allow";
  if (choice === "allow_tool") grantNativeMcpTool(store, record.id);
  store.put(NATIVE_PERMISSION_ENTITY, request.id, request.workflow_id, {
    ...request, decision, decided_at: now(),
  });
  return decision;
}

export function nativePermissionForRun(store: Store, run: Run): NativePermissionRequest | undefined {
  const w = store.must<{ plan_hash?: string; plan_revision: number }>("workflow", run.workflow_id);
  return store.list<NativePermissionRequest>(NATIVE_PERMISSION_ENTITY, run.workflow_id).find(request =>
    request.decision === "allow" && request.source_run_id === run.continuation?.source_run_id &&
    request.plan_revision === run.plan_revision && request.plan_revision === w.plan_revision && request.plan_hash === w.plan_hash &&
    request.purpose === run.purpose && request.conversation_id === run.conversation_id &&
    request.profile_hash === objectHash(run.profile) && request.account_scope === accountScope(run) &&
    request.workspace_hash === workspaceHash(store, run.workflow_id) &&
    (!request.bound_run_id || request.bound_run_id === run.id) &&
    request.calls.some(call => !call.consumed_by));
}

function workspaceHash(store: Store, workflowId: string) {
  return objectHash(store.list<Workspace>("workspace", workflowId)
    .map(({ repo_id, root }) => ({ repo_id, root })).sort((a, b) => a.repo_id.localeCompare(b.repo_id)));
}

function accountScope(run: Run) {
  return (run.frozen_invocation ?? run.model_binding?.frozen_invocation)?.accountScope;
}

export function bindNativePermission(store: Store, run: Run) {
  const request = nativePermissionForRun(store, run);
  const permanent = run.adapter === "agy" && hasNativeMcpToolPermission(store);
  if (!request && !permanent) return;
  const bound = request ? { ...request, bound_run_id: run.id } : undefined;
  if (bound) store.put(NATIVE_PERMISSION_ENTITY, bound.id, run.workflow_id, bound);
  return { ...bound, bound_run_id: run.id, calls: [...(bound?.calls ?? []), ...(permanent ? [{ name: "call_mcp_tool" }] : [])] };
}

export function consumeNativePermission(engine: Engine, run: Run, conversation: string, call: NativePermissionCall) {
  return engine.store.transaction(() => {
    const w = engine.get(run.workflow_id);
    if (w.run_id !== run.id || !["EXECUTING", "VERIFYING", "REVIEWING", "PLANNING", "COMMITTING"].includes(w.state) ||
        engine.store.get("run_stop", run.id) || conversation !== run.conversation_id ||
        (run.deadline_at !== undefined && Date.now() >= run.deadline_at)) return false;
    if (run.adapter === "agy" && call.name === "call_mcp_tool" && hasNativeMcpToolPermission(engine.store)) {
      engine.store.event(w.id, w.project_id, "NativeToolPermissionUsed", { tool: call.name, scope: "permanent" }, run.id);
      return true;
    }
    const request = nativePermissionForRun(engine.store, run);
    const approved = request?.calls.find(item => !item.consumed_by && item.fingerprint === objectHash(call));
    if (!request || request.bound_run_id !== run.id || !approved) return false;
    approved.consumed_by = run.id;
    engine.store.put(NATIVE_PERMISSION_ENTITY, request.id, request.workflow_id, request);
    engine.store.event(w.id, w.project_id, "NativePermissionConsumed", { interaction_id: request.id, fingerprint: approved.fingerprint }, run.id);
    return true;
  });
}
