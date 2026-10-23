import type { Engine } from "./engine.js";
import type { Store } from "../../store/src/store.js";
import { FlowError, type Run, type UserInteractionInput, type UserInteractionRecord, type Workspace } from "../../contracts/src/index.js";
import { objectHash, redact, now } from "./util.js";
import { UserInteractionService, interactionConversationContext } from "./user-interaction-service.js";
import { saveWaitingContext, waitingPurposeFromRun } from "./waiting-context.js";
import { highRiskDiagnostic } from "../../presentation/src/secret-redactor.js";
import { permissionCategoryForPurpose } from "./run-profile.js";

export const NATIVE_PERMISSION_ENTITY = "native_permission";
export const NATIVE_TOOL_PERMISSION_ENTITY = "native_tool_permission";
export const NATIVE_MCP_PERMISSION_ENTITY = "native_mcp_permission";
export interface NativeMcpTarget { server: string; method: string }
export type NativeMcpScope = "service" | "method";
interface NativeMcpPermission {
  id: string;
  adapter: "agy" | "claude-code" | "opencode";
  server: string;
  method?: string;
  scope: NativeMcpScope;
  granted_at: string;
  source: string;
}

/** Only the human console may create this persistent, instance-wide grant. */
export function grantNativeMcpPermission(store: Store, source: string, target: NativeMcpTarget & { adapter?: "agy" | "claude-code" | "opencode" }, scope: NativeMcpScope) {
  if (!mcpTarget({ name: "call_mcp_tool", parameters: { ServerName: target.server, ToolName: target.method } }) ||
      !["service", "method"].includes(scope)) throw new FlowError("INVALID_PERMISSION", "MCP 服务或方法无效", 400);
  const adapter = target.adapter ?? "agy";
  const identity = { adapter, server: target.server, scope, ...(scope === "method" ? { method: target.method } : {}) };
  const id = objectHash(identity);
  const existing = store.get<NativeMcpPermission>(NATIVE_MCP_PERMISSION_ENTITY, id);
  if (existing) return existing;
  const grant: NativeMcpPermission = { id, ...identity, granted_at: now(), source };
  store.put(NATIVE_MCP_PERMISSION_ENTITY, id, "global", grant);
  return grant;
}

export function findNativeMcpPermission(store: Store, target: NativeMcpTarget, adapter = "agy") {
  return store.list<NativeMcpPermission>(NATIVE_MCP_PERMISSION_ENTITY).find(grant => grant.adapter === adapter &&
    grant.server === target.server && (grant.scope === "service" || (grant.scope === "method" && grant.method === target.method)));
}
export function mcpTarget(call: NativePermissionCall): NativeMcpTarget | undefined {
  const { ServerName: server, ToolName: method } = call.parameters;
  const valid = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(value);
  return call.name === "call_mcp_tool" && valid(server) && valid(method) ? { server, method } : undefined;
}
function requestTarget(calls: NativePermissionCall[]) {
  // Present one method at a time. Other methods must obtain their own decision.
  return calls.length && calls.every(call => !!mcpTarget(call)) ? mcpTarget(calls[0]!) : undefined;
}
export function mcpPermissionInput(target: NativeMcpTarget): UserInteractionInput {
  return {
    kind: "question", title: "授权 MCP 服务或方法",
    message: `MCP 服务：${target.server}\n当前请求的方法：${target.method}\n授权不限定调用参数。永久授权对当前及后续任务有效，服务重启后仍有效；一次授权在放行一次调用后失效，失败重试需重新授权。`,
    question: "请选择授权范围和期限", allow_free_text: false, action_label: "提交授权决定",
    choices: [
      { id: "allow_service", label: "永久授权此 MCP 服务", description: "允许此服务的所有方法，包括以后新增的方法。" },
      { id: "allow_method", label: "永久授权此方法", description: "只允许此服务中的当前方法，其他方法需另行授权。" },
      { id: "allow_service_once", label: "仅本次授权此 MCP 服务", description: "允许此服务内一次方法调用，放行后立即失效。" },
      { id: "allow_method_once", label: "仅本次授权此方法", description: "只允许当前方法调用一次，放行后立即失效。" },
      { id: "deny", label: "拒绝本次操作", description: "不新增授权，不执行当前请求。" },
    ],
  };
}
const unknownPermissionInput: UserInteractionInput = {
  kind: "action_required", title: "工具权限需要处理",
  message: "无法确认完整的服务和方法，或具体操作不能安全展示。请在对应原生工具中核对权限后继续；此按钮不会授予未知操作权限。",
  action_label: "已处理权限，继续",
};
function ineffectivePermissionInput(target: NativeMcpTarget, adapter: string): UserInteractionInput {
  const label = adapter === "claude-code" ? "Claude Code" : adapter === "opencode" ? "OpenCode" : "AGY";
  return {
    kind: "action_required", title: `已授权，但 ${label} 仍拒绝调用`,
    message: `MCP 服务：${target.server}\n方法：${target.method}\n\n你的永久授权已保存，无需重复授权。${label} 仍拒绝了这次调用，任务已暂停。\n\n请先修复授权连接，或在对应原生工具中核对该方法是否被明确设为拒绝或询问；处理后再继续。`,
    action_label: "已处理，重试调用",
  };
}
function mcpRequestInput(store: Store, target: NativeMcpTarget, adapter: string) {
  return findNativeMcpPermission(store, target, adapter) ? ineffectivePermissionInput(target, adapter) : mcpPermissionInput(target);
}
function supportsNativeGrant(run: Run, call: NativePermissionCall): boolean {
  if (run.adapter === "claude-code" && ["AskUserQuestion", "ExitPlanMode"].includes(call.name)) return false;
  if (permissionCategoryForPurpose(run.purpose ?? run.stage) !== "read-only") return true;
  if (run.adapter === "claude-code") return ["Read", "Glob", "Grep"].includes(call.name);
  if (run.adapter === "opencode") return ["read", "glob", "grep", "list"].includes(call.name);
  return true; // AGY keeps its existing native policy checks.
}
function unsupportedPermissionInput(run: Run, calls: NativePermissionCall[]): UserInteractionInput | undefined {
  if (calls.every(call => supportsNativeGrant(run, call))) return;
  const interactive = run.adapter === "claude-code" && calls.some(call => ["AskUserQuestion", "ExitPlanMode"].includes(call.name));
  return {
    kind: "action_required", title: interactive ? "请完成 Claude Code 原生交互" : "当前角色不能执行此操作",
    message: interactive
      ? `此操作需要问题答案或原生计划确认，工具授权不能代替。请在 Claude Code 中打开会话 ${run.conversation_id}，完成对应交互后继续。此按钮不会授予工具权限。`
      : "当前规划或复核角色只允许读取，不能通过工具授权执行此操作。请在任务对话中说明允许的处理方式后继续；此按钮不会扩大角色权限。",
    action_label: interactive ? "已完成原生交互，继续" : "已补充处理方式，继续",
  };
}
/** Project old pending prompts into the new scope; old allow_tool submissions are rejected. */
export function nativePermissionInteraction(store: Store, record: UserInteractionRecord): UserInteractionRecord {
  if (record.status !== "pending") return record;
  const request = store.get<NativePermissionRequest>(NATIVE_PERMISSION_ENTITY, record.id);
  if (!request) return record;
  const source = store.get<Run>("run", request.source_run_id);
  const unsupported = source && unsupportedPermissionInput(source, request.calls);
  if (unsupported) return { ...record, request: unsupported };
  if (!request.calls.some(call => call.name === "call_mcp_tool")) return record;
  const target = requestTarget(request.calls);
  const adapter = source?.adapter ?? "agy";
  return { ...record, request: target ? mcpRequestInput(store, target, adapter) : unknownPermissionInput };
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
  calls: Array<NativePermissionCall & { fingerprint: string; consumed_by?: string; consumed_native_call_id?: string }>;
  decision?: "allow" | "deny";
  decided_at?: string;
  bound_run_id?: string;
  mcp_grant?: NativeMcpTarget & { scope: NativeMcpScope; lifetime: "permanent" | "once" };
  consumed_by?: string;
  consumed_native_call_id?: string;
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
    const unsupported = unsupportedPermissionInput(source, calls);
    const target = !unsupported && ["agy", "claude-code", "opencode"].includes(source.adapter) ? requestTarget(calls) : undefined;
    const hasMcp = calls.some(call => call.name === "call_mcp_tool");
    const safeDetail = detail.length <= 3500 && detail === rawDetail && !highRiskDiagnostic(rawDetail);
    const known = !unsupported && (!!target || !hasMcp && calls.length > 0 && safeDetail);
    const interaction = new UserInteractionService(engine.store).createInteraction({
      workflowId: w.id, sourceRunId: run.id, sourcePlanRevision: source.plan_revision,
      ...context, purpose: owner.purpose, role: owner.role,
      rawInput: unsupported ?? (target ? mcpRequestInput(engine.store, target, source.adapter) : known ? {
        kind: "question", title: "授权本次工具操作",
        message: detail + "\n仅对原会话中上述具体调用授权一次。改变工具、参数、目标或会话需要重新授权。",
        question: "是否允许执行上述操作？", allow_free_text: false, action_label: "提交授权决定",
        choices: [{ id: "allow_once", label: "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }],
      } : unknownPermissionInput),
    });
    if (known) engine.store.put(NATIVE_PERMISSION_ENTITY, interaction.id, w.id, {
      id: interaction.id, workflow_id: w.id, source_run_id: run.id,
      plan_revision: source.plan_revision, plan_hash: w.plan_hash,
      conversation_id: conversationId, purpose: run.purpose,
      profile_hash: objectHash(source.profile), account_scope: accountScope(source),
      workspace_hash: workspaceHash(engine.store, w.id),
      calls: target ? [{ name: "call_mcp_tool", parameters: { ServerName: target.server, ToolName: target.method }, fingerprint: objectHash(target) }]
        : calls.map(call => ({ ...call, fingerprint: objectHash(call) })),
    } satisfies NativePermissionRequest);
    saveWaitingContext(engine.store, w.id, {
      ...owner, run_id: run.id, conversation_id: source.conversation_id,
      source_execution_run_id: owner.purpose === "execute" ? run.id : undefined,
      original_text: interaction.request.message, intent: "need_user", interaction_id: interaction.id,
    });
    engine.store.put("run", run.id, w.id, { ...source, status: "waiting", ended_at: now() });
    engine.transition(w.id, [w.state], "WAITING_INPUT", run.stage, {
      blocker: { code: "NEED_USER", message: target && findNativeMcpPermission(engine.store, target, source.adapter)
        ? "永久授权已保存，等待处理权限拒绝" : known ? "等待你授权本次工具操作" : "等待处理工具权限" },
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
  if (unsupportedPermissionInput(run, request.calls)) {
    if (choice !== undefined) throw new FlowError("INTERACTION_STALE", "此操作需要原生交互或受角色限制，请刷新查看处理方式", 409);
    return;
  }
  const target = ["agy", "claude-code", "opencode"].includes(run.adapter) ? requestTarget(request.calls) : undefined;
  if (target && findNativeMcpPermission(store, target, run.adapter)) {
    if (choice !== undefined) throw new FlowError("INTERACTION_STALE", "永久授权已保存，请刷新查看权限问题", 409);
    // Acknowledging a native policy failure neither creates nor expands a grant.
    return;
  }
  if (!target && record.request.kind === "action_required" && choice === undefined) return;
  const allowedChoices = target ? mcpPermissionInput(target).choices!.map(item => item.id) : ["allow_once", "deny"];
  if (request.source_run_id !== record.source_run_id || request.plan_hash !== w.plan_hash ||
      request.profile_hash !== objectHash(run.profile) || request.account_scope !== accountScope(run) ||
      request.workspace_hash !== workspaceHash(store, record.workflow_id) ||
      request.conversation_id !== record.native_session_id || !allowedChoices.includes(choice ?? "") ||
      (!target && request.calls.some(call => call.name === "call_mcp_tool")))
    throw new FlowError("INTERACTION_STALE", "权限请求或操作已变化，请刷新后重新授权", 409);
  const decision = choice === "deny" ? "deny" : "allow";
  const mcpGrant = target && decision === "allow" ? { ...target,
    scope: choice!.startsWith("allow_service") ? "service" as const : "method" as const,
    lifetime: choice!.endsWith("_once") ? "once" as const : "permanent" as const } : undefined;
  if (mcpGrant?.lifetime === "permanent") grantNativeMcpPermission(store, record.id,
    { ...mcpGrant, adapter: run.adapter as "agy" | "claude-code" | "opencode" }, mcpGrant.scope);
  store.put(NATIVE_PERMISSION_ENTITY, request.id, request.workflow_id, {
    ...request, decision, mcp_grant: mcpGrant, decided_at: now(),
  });
  return decision;
}

export function nativePermissionAnswer(store: Store, record: UserInteractionRecord, decision: "allow" | "deny") {
  if (decision === "deny") return "用户拒绝了上述工具调用。不要重试或换工具绕过该操作；继续允许范围内的工作，受阻部分如实说明。";
  const grant = store.get<NativePermissionRequest>(NATIVE_PERMISSION_ENTITY, record.id)?.mcp_grant;
  if (!grant) return "用户已明确授权上述具体工具调用一次。请在原会话中按原参数重试本次操作；其他工具、参数或目标未获此授权。";
  const scope = grant.scope === "service" ? `MCP 服务 ${grant.server} 的所有方法` : `MCP 方法 ${grant.server}/${grant.method}`;
  return `用户已${grant.lifetime === "permanent" ? "永久" : "仅本次"}授权${scope}，不限定调用参数。` +
    (grant.lifetime === "once" ? "仅可放行一次调用，失败重试需重新授权。" : "当前及后续任务有效。") + "其他范围未获此授权。请继续原任务。";
}

export function nativePermissionForRun(store: Store, run: Run, nativeCallId?: string): NativePermissionRequest | undefined {
  const w = store.must<{ plan_hash?: string; plan_revision: number }>("workflow", run.workflow_id);
  return store.list<NativePermissionRequest>(NATIVE_PERMISSION_ENTITY, run.workflow_id).find(request =>
    request.decision === "allow" && request.source_run_id === run.continuation?.source_run_id &&
    (!request.calls.some(call => call.name === "call_mcp_tool") || request.mcp_grant?.lifetime === "once") &&
    (!request.consumed_by || !!nativeCallId && request.consumed_by === run.id && request.consumed_native_call_id === nativeCallId) &&
    request.plan_revision === run.plan_revision && request.plan_revision === w.plan_revision && request.plan_hash === w.plan_hash &&
    request.purpose === run.purpose && request.conversation_id === run.conversation_id &&
    request.profile_hash === objectHash(run.profile) && request.account_scope === accountScope(run) &&
    request.workspace_hash === workspaceHash(store, run.workflow_id) &&
    (!request.bound_run_id || request.bound_run_id === run.id) &&
    request.calls.some(call => !call.consumed_by || !!nativeCallId && call.consumed_by === run.id && call.consumed_native_call_id === nativeCallId));
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
  const calls = request?.calls.filter(call => supportsNativeGrant(run, call)) ?? [];
  const permanent = ["agy", "claude-code", "opencode"].includes(run.adapter) &&
    supportsNativeGrant(run, { name: "call_mcp_tool", parameters: {} }) &&
    store.list<NativeMcpPermission>(NATIVE_MCP_PERMISSION_ENTITY).some(grant => grant.adapter === run.adapter);
  if (!calls.length && !permanent) return;
  const bound = request && calls.length ? { ...request, bound_run_id: run.id } : undefined;
  if (bound) store.put(NATIVE_PERMISSION_ENTITY, bound.id, run.workflow_id, bound);
  return { ...bound, bound_run_id: run.id, calls: [...calls, ...(permanent ? [{ name: "call_mcp_tool" }] : [])] };
}

export function consumeNativePermission(engine: Engine, run: Run, conversation: string, call: NativePermissionCall, nativeCallId?: string) {
  return engine.store.transaction(() => {
    const w = engine.get(run.workflow_id);
    if (w.run_id !== run.id || !["EXECUTING", "VERIFYING", "REVIEWING", "PLANNING", "COMMITTING"].includes(w.state) ||
        engine.store.get("run_stop", run.id) || conversation !== run.conversation_id ||
        (run.deadline_at !== undefined && Date.now() >= run.deadline_at)) return false;
    // A native hook must not turn a one-use human grant into a role escalation.
    // The two new bridges can approve only the same read tools exposed by their
    // read-only agents. AGY retains its existing native policy checks.
    if (!supportsNativeGrant(run, call)) return false;
    const target = ["agy", "claude-code", "opencode"].includes(run.adapter) ? mcpTarget(call) : undefined;
    if (call.name === "call_mcp_tool" && !target) return false;
    const permanent = target && findNativeMcpPermission(engine.store, target, run.adapter);
    if (permanent) {
      engine.store.event(w.id, w.project_id, "NativeToolPermissionUsed", { ...target, scope: permanent.scope, lifetime: "permanent" }, run.id);
      return true;
    }
    const request = nativePermissionForRun(engine.store, run, nativeCallId);
    if (!request || request.bound_run_id !== run.id) return false;
    if (request.mcp_grant) {
      const grant = request.mcp_grant;
      if (!target || grant.server !== target.server || grant.scope === "method" && grant.method !== target.method) return false;
      if (request.consumed_by) return request.consumed_by === run.id && !!nativeCallId && request.consumed_native_call_id === nativeCallId;
      engine.store.put(NATIVE_PERMISSION_ENTITY, request.id, request.workflow_id, {
        ...request, consumed_by: run.id, ...(nativeCallId ? { consumed_native_call_id: nativeCallId } : {}),
      });
      engine.store.event(w.id, w.project_id, "NativePermissionConsumed", { interaction_id: request.id, ...target, scope: grant.scope, lifetime: "once" }, run.id);
      return true;
    }
    const approved = request.calls.find(item => item.fingerprint === objectHash(call) &&
      (!item.consumed_by || !!nativeCallId && item.consumed_by === run.id && item.consumed_native_call_id === nativeCallId));
    if (!request || request.bound_run_id !== run.id || !approved) return false;
    // One native tool call may ask separately for its directory and its tool.
    // Re-check the live ownership above, but consume only once for that call ID.
    if (approved.consumed_by) return true;
    approved.consumed_by = run.id;
    if (nativeCallId) approved.consumed_native_call_id = nativeCallId;
    engine.store.put(NATIVE_PERMISSION_ENTITY, request.id, request.workflow_id, request);
    engine.store.event(w.id, w.project_id, "NativePermissionConsumed", { interaction_id: request.id, fingerprint: approved.fingerprint }, run.id);
    return true;
  });
}
