import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
  useRef,
} from "react";
import "./agy-accounts.css";
import {
  formatSnapshotQuotaWindow,
  formatAccountStateLabel,
} from "../../../../packages/presentation/src/agy-accounts.js";
import type {
  AgyAccountDto,
  AgyQuotaSnapshot,
  AgyManagementSelectionContext,
} from "../../../../packages/contracts/src/agy-account.js";
import { AgyAccountEnrollment, formatFriendlyError } from "./AgyAccountEnrollment.js";
import {
  agyApi,
  requestBody,
  terminalOperation,
  operationLabels,
  setAutomationEnabled,
  type AccountOperationView,
} from "./agy-api.js";

export interface AgyAccountsPanelHandle {
  refresh: () => Promise<void>;
  syncAndRefresh: () => Promise<void>;
}

interface Realm {
  revision: number;
  control_generation: number;
  auth_epoch: number;
  active_account_id?: string | null;
  pending_operation_id?: string | null;
  last_error?: string;
  service_state: string;
  desired_enabled: boolean;
}

interface AccountView {
  refresh_scope?: "all" | "active_only";
  refresh_errors?: Array<{ account_id: string }>;
  model_id?: string | null;
  active_category?: "gemini" | "other" | "mixed" | "unknown" | null;
  selection_context?: AgyManagementSelectionContext;
  accounts: Array<Pick<AgyAccountDto, "id" | "revision" | "identity" | "state"> & {
    saved_credential_status?: "available" | "unverified" | "needs_update";
  }>;
  snapshots: Array<Pick<AgyQuotaSnapshot, "account_id" | "pool_id" | "windows" | "observed_at" | "capability_verified">>;
  realm: Realm | null;
  settings?: { revision: number };
  automation?: {
    enabled: boolean;
    service_state: string;
    can_toggle: boolean;
  };
  capability: {
    supported: boolean;
    reason?: string;
  };
}
interface ManagementSnapshot extends AccountView {
  service: ServiceView;
  refresh: { status: "running" | "succeeded" | "failed" | "cancelled"; account_id?: string;
    refresh_errors?: Array<{ account_id: string; error?: string }>; error?: string } | null;
}

interface ServiceView extends Realm {
  operations: AccountOperationView[];
  can_preserve_current_login?: boolean;
  automation?: {
    enabled: boolean;
    service_state: string;
    can_toggle: boolean;
  };
}

// Keep only public snapshots across dialog mounts; never replace known data with
// an empty list because a request failed.
let accountSnapshot: { value: ManagementSnapshot; observedAt: number } | null = null;
let serviceSnapshot: ServiceView | null = null;
let switchIntent: { accountId: string; body: string } | null = null;

function CompactQuotaBar({
  snapshot,
  kind,
  now,
}: {
  snapshot: AccountView["snapshots"][number] | undefined;
  kind: AgyQuotaSnapshot["windows"][number]["kind"];
  now: number;
}) {
  const window = snapshot?.windows.find(
    (w) =>
      w.kind === kind ||
      (kind === "weekly" ? w.duration_minutes === 10080 : w.duration_minutes === 300),
  );
  if (!window) {
    return (
      <span className="agy-no-quota">
        {kind === "weekly" ? "周额度待实测/不可用" : "5小时待实测/不可用"}
      </span>
    );
  }
  const value = formatSnapshotQuotaWindow(snapshot, kind, now);
  const percent = value.fraction !== null ? Math.round(value.fraction * 100) : null;
  const quotaTooltip = value.resetText !== "—"
    ? `${value.label}：${value.percentageText}，${value.resetText}`
    : `${value.label}：${value.percentageText}`;

  return (
    <div className="agy-compact-quota" title={`${quotaTooltip}；查询于 ${snapshot?.observed_at ? new Date(snapshot.observed_at).toLocaleString() : "未知"}`}>
      <span className="agy-quota-lbl">{value.label}</span>
      <div className="agy-quota-track">
        <div
          className="agy-quota-fill"
          style={{
            width: `${percent ?? 0}%`,
            background: percent !== null && percent < 20 ? "#ef4444" : percent !== null && percent < 50 ? "#f59e0b" : "#10b981",
          }}
        />
      </div>
      <span className="agy-quota-num">{value.percentageText}</span>
      {value.shortResetText ? (
        <span className="agy-quota-reset" title={value.resetText}>
          {value.shortResetText}
        </span>
      ) : null}
    </div>
  );
}

export const AgyAccountsPanel = forwardRef<
  AgyAccountsPanelHandle,
  { onDismiss?: () => void; onRefreshingChange?: (value: boolean) => void }
>(function AgyAccountsPanel({ onDismiss, onRefreshingChange }, ref) {
  const [view, setView] = useState<ManagementSnapshot | null>(accountSnapshot?.value ?? null);
  const [service, setService] = useState<ServiceView | null>(serviceSnapshot);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [dismissedOperationId, setDismissedOperationId] = useState("");
  const [notice, setNotice] = useState("");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [reauthAccount, setReauthAccount] = useState<AccountView["accounts"][number] | null>(null);
  const [reauthSubmitting, setReauthSubmitting] = useState(false);
  const reauthOperationId = useRef("");
  const [togglingAutomation, setTogglingAutomation] = useState(false);
  const [activeOperation, setActiveOperation] = useState<AccountOperationView | null>(null);
  const [checkingOperation, setCheckingOperation] = useState(false);
  const [verifiedAccountId, setVerifiedAccountId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);

  const [readErrors, setReadErrors] = useState({ accounts: "", service: "" });
  const [quotaWarning, setQuotaWarning] = useState("");
  const [observedAt, setObservedAt] = useState(accountSnapshot?.observedAt ?? 0);
  const [serviceFresh, setServiceFresh] = useState(Boolean(serviceSnapshot));
  const [submittingAccount, setSubmittingAccount] = useState<string | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const reading = useRef<Promise<void> | null>(null);
  const submitting = useRef(false);
  const revision = useRef(0);
  const quotaRequest = useRef<Promise<void> | null>(null);
  const readAbort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const readFailed = useRef(false);
  const scheduleFallback = useRef<() => void>(() => {});
  useEffect(() => onRefreshingChange?.(refreshing), [refreshing, onRefreshingChange]);

  const refresh = useCallback((invalidate = false): Promise<void> => {
    if (invalidate) { revision.current++; readAbort.current?.abort(); reading.current = null; }
    if (reading.current) return reading.current;
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted) return Promise.resolve();
    const version = revision.current;
    const request = new AbortController(); readAbort.current = request;
    const pending = (async () => {
      try {
        const next = await agyApi<ManagementSnapshot>("/snapshot", { signal: AbortSignal.any([controller.signal, request.signal]) });
        if (controller.signal.aborted || version !== revision.current) return;
        accountSnapshot = { value: next, observedAt: Date.now() };
        serviceSnapshot = next.service;
        setView(next); setService(next.service);
        setObservedAt(accountSnapshot.observedAt);
        setNow(accountSnapshot.observedAt);
        const operation = next.service.pending_operation_id === undefined
          ? next.service.operations.find(op => !terminalOperation(op.phase)) ?? null
          : next.service.operations.find(op => op.operation_id === next.service.pending_operation_id) ?? null;
        setActiveOperation(operation);
        const running = next.refresh?.status === "running";
        busy.current = running || !!operation;
        readFailed.current = false;
        scheduleFallback.current();
        setRefreshing(running);
        setQuotaWarning(next.refresh?.status === "failed"
          ? next.refresh.error === "operation_in_progress" ? "账号操作收尾后才能刷新额度"
          : "部分额度未能更新，已保留上次查询结果" : "");
        setServiceFresh(true); setReadErrors({ accounts: "", service: "" });
      } catch {
        if (controller.signal.aborted || request.signal.aborted || version !== revision.current) return;
        setServiceFresh(false);
        setReadErrors({ accounts: "账号状态暂时读取失败，已保留上次结果", service: "" });
        readFailed.current = true;
        scheduleFallback.current();
      } finally {
        if (!controller.signal.aborted && version === revision.current) setLoading(false);
      }
    })().finally(() => { if (reading.current === pending) reading.current = null; });
    reading.current = pending;
    return pending;
  }, []);

  const verifyIdentity = useCallback(async (signal: AbortSignal) => {
    try {
      const identity = await agyApi<{ status: string; account_id?: string | null }>("/verify-active", { method: "POST", signal });
      if (!signal.aborted) setVerifiedAccountId(identity.status === "verified" ? identity.account_id ?? null : null);
    } catch {
      if (!signal.aborted) setVerifiedAccountId(null);
    }
  }, []);

  const syncAndRefresh = useCallback((force = true): Promise<void> => {
    if (quotaRequest.current) return quotaRequest.current;
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted) return Promise.resolve();
    setRefreshing(true);
    const pending = (async () => {
      try {
        await agyApi("/refresh", {
          method: "POST", body: requestBody({ force, scope: "active_only" }), signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        await refresh(true);
      } catch {
        if (!controller.signal.aborted) setQuotaWarning("额度查询暂时失败，已保留上次结果（可能已过期）");
        if (!controller.signal.aborted) setRefreshing(false);
      }
    })().finally(() => { if (quotaRequest.current === pending) quotaRequest.current = null; });
    quotaRequest.current = pending;
    return pending;
  }, [refresh]);

  useImperativeHandle(ref, () => ({ refresh, syncAndRefresh }), [refresh, syncAndRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    reading.current = null;
    quotaRequest.current = null;
    let connected = false, socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined, notification: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const schedule = () => {
      clearTimeout(fallback);
      if (controller.signal.aborted || !visible() || (connected && !readFailed.current)) return;
      fallback = setTimeout(() => { void refresh().finally(schedule); }, busy.current || readFailed.current ? 1000 : 30000);
    };
    scheduleFallback.current = schedule;
    const connect = () => {
      if (controller.signal.aborted) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/agy-accounts/notifications`);
      socket.onopen = () => { connected = true; clearTimeout(fallback); if (visible()) void refresh(true); };
      socket.onmessage = () => {
        if (!visible() || notification) return;
        notification = setTimeout(() => { notification = undefined; void refresh(true); }, 50);
      };
      socket.onclose = () => { connected = false; schedule(); if (!controller.signal.aborted) retry = setTimeout(connect, 5000); };
    };
    const verify = () => { if (visible() && !busy.current) void verifyIdentity(controller.signal); };
    const visibility = () => { if (visible()) { void refresh(true); verify(); } schedule(); };
    document.addEventListener("visibilitychange", visibility);
    const identityTimer = setInterval(() => { setNow(Date.now()); verify(); }, 30000);
    void refresh().then(() => { if (!controller.signal.aborted && visible() && !busy.current) void syncAndRefresh(false); });
    connect(); schedule();
    return () => {
      controller.abort(); readAbort.current?.abort(); socket?.close();
      clearTimeout(retry); clearTimeout(notification); clearTimeout(fallback);
      clearInterval(identityTimer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh, syncAndRefresh, verifyIdentity]);

  useEffect(() => {
    if (activeOperation || service?.last_error || !serviceFresh) {
      setVerifiedAccountId(null);
    } else if (lifecycle.current) {
      void verifyIdentity(lifecycle.current.signal);
    }
  }, [activeOperation?.operation_id, service?.active_account_id, service?.auth_epoch, service?.last_error, serviceFresh, verifyIdentity]);

  const handleToggleAutomation = async () => {
    if (togglingAutomation || !service) return;
    setTogglingAutomation(true);
    setError("");
    try {
      const next = !isAutomationOn;
      const result = await setAutomationEnabled(next, view?.settings?.revision);
      await refresh();
      setNotice(result.enabled ? "已开启自动切号" : "已关闭自动切号");
      setTimeout(() => setNotice(""), 3000);
    } catch (e) {
      await refresh();
      setError(e instanceof Error ? e.message : "更新自动切号状态失败");
    } finally {
      setTogglingAutomation(false);
    }
  };

  const formatErrorMsg = (e: unknown, fallback: string): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const friendlyMap: Record<string, string> = {
      account_identity_in_use: "AGY 正在使用账号，退出相关会话后可重新核验",
      identity_unverified: "暂时无法确认 AGY 当前登录，请在 AGY 确认登录后重新核验",
      external_change: "检测到 AGY 登录已变化，请刷新账号状态后重试",
      operation_in_progress: "当前已有另一项账号操作正在进行中，请先等待其完成或点击取消",
      account_in_use: "该账号当前正在使用中，无法移除，请先切换至其他账号",
      identity_mismatch: "切换期间检测到账号身份变化，请刷新账号后重试",
      domain_lock_acquire_failed: "未能获取系统账号锁，可能有其他进程正在使用",
    };
    return friendlyMap[raw] || (raw ? `${fallback}: ${raw}` : fallback);
  };

  const handleSwitchTo = async (accountId: string) => {
    if (submitting.current || activeOperation || !serviceFresh) return;
    submitting.current = true;
    setSubmittingAccount(accountId);
    setError("");
    setNotice("");
    revision.current++;
    if (switchIntent?.accountId !== accountId) switchIntent = {
      accountId, body: requestBody({ selection: { mode: "explicit", account_id: accountId }, expected_epoch: service?.auth_epoch }),
    };
    const controller = lifecycle.current!;
    try {
      const op = await agyApi<AccountOperationView>("/switch", {
        method: "POST", body: switchIntent.body, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      switchIntent = null;
      revision.current++;
      setActiveOperation(terminalOperation(op.phase) ? null : op);
      setNotice("");
    } catch (e) {
      if (typeof (e as { status?: number })?.status === "number" && (e as { status: number }).status < 500) switchIntent = null;
      if (!controller.signal.aborted) setError(formatErrorMsg(e, "切换账号失败"));
    } finally {
      submitting.current = false;
      if (!controller.signal.aborted) {
        setSubmittingAccount(null);
        await refresh(true);
      }
    }
  };

  const handleReauth = async (disposition: "save_only" | "activate") => {
    if (!reauthAccount || reauthSubmitting) return;
    const account = reauthAccount;
    setReauthSubmitting(true);
    setError("");
    try {
      const op = await agyApi<AccountOperationView>(`/${encodeURIComponent(account.id)}/reauth`, {
        method: "POST",
        body: requestBody({
          expected_account_revision: account.revision,
          expected_identity: account.identity.email,
          reauth_disposition: disposition,
        }),
      });
      setActiveOperation(op);
      reauthOperationId.current = op.operation_id;
      setReauthAccount(null);
      await refresh();
    } catch (e) {
      setError(formatErrorMsg(e, "重新认证失败"));
      setReauthAccount(null);
    } finally {
      setReauthSubmitting(false);
    }
  };

  const handleProbeAccount = async (account: AccountView["accounts"][number]) => {
    if (activeOperation || !serviceFresh) return;
    setError("");
    try {
      const op = await agyApi<AccountOperationView>(`/${encodeURIComponent(account.id)}/probe`, {
        method: "POST", body: requestBody({ expected_account_revision: account.revision }),
      });
      setActiveOperation(op);
      await refresh(true);
    } catch (e) {
      setError(formatErrorMsg(e, "未能核验此账号额度"));
    }
  };

  const handleDeleteAccount = async (account: AccountView["accounts"][number]) => {
    if (!window.confirm(`确定要移除账号 ${account.identity.email} 吗？`)) {
      return;
    }
    setError("");
    try {
      const op = await agyApi<AccountOperationView>(`/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        body: requestBody({
          expected_revision: account.revision,
        }),
      });
      setActiveOperation(op);
      setNotice(`已发起移除账号 ${account.identity.email}`);
      setTimeout(() => setNotice(""), 3000);
      await refresh();
    } catch (e) {
      setError(formatErrorMsg(e, "移除账号失败"));
    }
  };

  const handleCancelOperation = async (op: AccountOperationView) => {
    if (checkingOperation) return;
    setCheckingOperation(true);
    setError("");
    setNotice("");
    try {
      const reconciling = op.phase === "blocked";
      const result = await agyApi<AccountOperationView>(`/operations/${encodeURIComponent(op.operation_id)}/${reconciling ? "reconcile" : "cancel"}`, {
        method: "POST",
        body: reconciling ? undefined : requestBody({ expected_revision: op.revision }),
      });
      if (result.phase === "cancelled") {
        setNotice(reconciling ? "已结束操作并同步当前登录" : "已取消");
        if (reconciling) void syncAndRefresh();
      }
      else if (result.phase === "completed") setNotice("切换已完成");
    } catch (e) {
      setError(formatErrorMsg(e, "账号操作收尾失败"));
    } finally {
      setCheckingOperation(false);
      await refresh(true);
    }
  };

  const isAutomationOn = Boolean(
    service?.automation?.enabled ??
    (service?.service_state === "running" || service?.desired_enabled)
  );

  const accounts = view?.accounts ?? [];
  const latestOperation = service?.operations[0];
  useEffect(() => {
    const op = service?.operations.find(item => item.operation_id === reauthOperationId.current);
    if (!op || !terminalOperation(op.phase)) return;
    reauthOperationId.current = "";
    if (op.phase === "completed") {
      const active = op.result?.outcome === "current_login_synced";
      setNotice(active ? "新凭据已保存为当前登录，正在核验额度" : "已更新保存凭据，当前登录已恢复");
      if (active) void syncAndRefresh();
    }
  }, [service, syncAndRefresh]);
  const operationError = latestOperation && latestOperation.operation_id !== dismissedOperationId &&
    ["failed", "blocked", "cancelled"].includes(latestOperation.phase) && latestOperation.error &&
    latestOperation.error !== "operation_cancelled"
    ? formatFriendlyError(latestOperation.error) : "";
  const activeAccountId = serviceFresh ? service?.active_account_id : view?.realm?.active_account_id;
  const identityVerified = serviceFresh && !activeOperation && !service?.last_error && verifiedAccountId === activeAccountId;
  const preserveCurrent = Boolean(service?.can_preserve_current_login);
  const canReconcile = activeOperation?.phase === "blocked" && (preserveCurrent ||
    (["switch", "probe"].includes(activeOperation.kind ?? "") &&
      activeOperation.cancel_requested && service?.last_error === "external_change"));

  return (
    <div className="agy-minimal-panel">
      {/* 顶部自动化控制栏 */}
      <div className="agy-top-control-bar">
        <div className="agy-automation-switch-group">
          <label className="agy-switch-label">
            <input
              type="checkbox"
              className="agy-switch-input"
              checked={isAutomationOn}
              disabled={togglingAutomation || !serviceFresh}
              onChange={handleToggleAutomation}
            />
            <span className="agy-switch-slider" />
            <span className="agy-switch-text">自动切换账号</span>
          </label>
          <span className="agy-switch-desc">
            {!serviceFresh ? "自动切换状态待确认" : isAutomationOn ? "额度耗尽时自动选择最佳账号" : "已停用自动切换，当前仅执行手动切换"}
          </span>
          {isAutomationOn && (
            <span
              className="agy-selection-basis-desc"
              style={{ fontSize: "12px", color: "#475569", marginTop: "4px" }}
            >
              当前自动选择依据：
              {view?.selection_context?.source === "standalone_model"
                ? `指定独立模型额度池（${view.selection_context.model_id}）`
                : view?.selection_context?.category === "gemini"
                ? "当前活跃 Gemini 任务所属额度池"
                : view?.selection_context?.category === "other"
                  ? "当前活跃其他模型任务所属额度池（Claude / GPT）"
                  : view?.selection_context?.category === "mixed"
                    ? "Gemini 与 Claude/GPT 任务同时运行；切换时按首个归零配额排序"
                   : view?.selection_context?.category === "unknown"
                     ? "当前类别尚未确认，等待恢复核对"
                     : "等待任务启动后按所属类别匹配（当前无活跃类别占用）"}
            </span>
          )}
        </div>

        <button
          type="button"
          className="agy-primary-btn"
          onClick={() => setEnrollOpen(true)}
        >
          + 导入当前账号
        </button>
      </div>

      {/* 正在进行中的操作提示卡片（弹窗打开时由弹窗内向导独立展示，避免重复叠加） */}
      {activeOperation && !enrollOpen && (
        <div className="agy-active-op-card">
          <div className="agy-active-op-info">
            {activeOperation.phase !== "blocked" && <span className="agy-op-spinner" />}
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span>
                {activeOperation.phase === "blocked"
                  ? preserveCurrent && ["probe", "maintenance"].includes(activeOperation.kind ?? "")
                    ? "额度探测已停止，需确认保留当前登录"
                    : "操作未收尾，需核对 AGY 当前登录"
                  : activeOperation.cancel_requested ? "正在取消并核对凭据"
                  : `正在执行：${operationLabels[activeOperation.phase] ?? activeOperation.phase}`}
              </span>
              {activeOperation.quota_trigger && (
                <span>
                  {activeOperation.quota_trigger.pool_id === "Claude and GPT models" ? "Claude/GPT" :
                    activeOperation.quota_trigger.pool_id === "Gemini Models" ? "Gemini" : activeOperation.quota_trigger.pool_id}
                  {activeOperation.quota_trigger.window === "weekly" ? "周额度" : "五小时额度"}
                  为 0，按该配额余额选择账号；目标账号两池均须可用
                  {activeOperation.selected_quota && `（目标余额 ${Math.round((activeOperation.quota_trigger.window === "weekly"
                    ? activeOperation.selected_quota.weekly : activeOperation.selected_quota.five_hour ?? 0) * 100)}%）`}
                </span>
              )}
              {activeOperation.phase === "waiting" && activeOperation.error && (
                <span>{formatFriendlyError(activeOperation.error)}</span>
              )}
              {activeOperation.phase === "waiting_external_exit" && (
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  {activeOperation.external_processes && activeOperation.external_processes.length > 0 ? (
                    <div>
                      <span>检测到外部 AGY 会话仍在运行，请先退出以下会话：</span>
                      <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                        {activeOperation.external_processes.map((p) => (
                          <li key={p.pid}>
                            PID {p.pid}: {p.exe_path || p.executable || "agy"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <span>请退出外部运行中的 AGY 终端会话，退出后本次操作将自动继续</span>
                  )}
                </div>
              )}
            </div>
          </div>
          {(canReconcile || (activeOperation.phase !== "blocked" && !activeOperation.cancel_requested)) && <button
            type="button"
            className="agy-text-btn danger"
            disabled={checkingOperation}
            onClick={() => handleCancelOperation(activeOperation)}
          >
            {canReconcile ? preserveCurrent ? "保留当前登录并结束操作" : "重新核验" : "取消操作"}
          </button>}
        </div>
      )}

      {/* 错误提示 */}
      {(error || operationError) && (
        <div className="agy-alert-error" role="alert">
          <span>{error || operationError}</span>
          <button type="button" onClick={() => {
            setError("");
            setDismissedOperationId(latestOperation?.operation_id ?? "");
          }}>✕</button>
        </div>
      )}

      {(readErrors.accounts || readErrors.service || quotaWarning) && (
        <div className="agy-alert-error" role="alert">
          {[readErrors.accounts, readErrors.service, quotaWarning].filter(Boolean).join("；")}
          {view && readErrors.accounts && observedAt ? `；显示 ${new Date(observedAt).toLocaleTimeString()} 的账号快照` : ""}
        </div>
      )}
      {submittingAccount && <div role="status">正在提交切换：{accounts.find(a => a.id === submittingAccount)?.identity.email ?? submittingAccount}</div>}
      {/* 成功反馈 */}
      {notice && (
        <div className="agy-alert-success" role="status">
          {notice}
        </div>
      )}

      {/* 账号列表 */}
      <div className="agy-accounts-list-wrap">
        <div className="agy-list-header">
          <span>已管理账号 {!view ? "（待读取）" : `(${accounts.length})`}</span>
          {refreshing && (
            <span style={{ marginLeft: "8px", fontSize: "12px", color: "#2563eb", fontWeight: "normal" }}>
              正在刷新额度...
            </span>
          )}
        </div>

        {loading && !view ? (
          <div className="agy-loading-state">
            <span className="agy-loading-spinner" />
            <p>正在加载账号及额度信息...</p>
          </div>
        ) : !view ? (
          <div className="agy-empty-state"><p>暂时无法读取账号，连接恢复后会自动重试</p><button type="button" onClick={() => void refresh()}>重试</button></div>
        ) : accounts.length === 0 ? (
          <div className="agy-empty-state">
            <span className="agy-empty-icon">👥</span>
            <p>暂无管理的 AGY 账号</p>
            <button
              type="button"
              className="agy-secondary-btn"
              onClick={() => setEnrollOpen(true)}
            >
              立即导入当前账号
            </button>
          </div>
        ) : (
          <div className="agy-accounts-grid">
            {accounts.map((account) => {
              const isActive = account.id === activeAccountId;
              const quotaError = view?.refresh?.refresh_errors?.find(item => item.account_id === account.id)?.error;
              const accountSnapshots =
                view?.snapshots.filter((s) => s.account_id === account.id) ?? [];
              
              // Each pool is independent; Argon must never fill the Gemini row.
              const geminiSnapshot = accountSnapshots.find(
                (s) => s.pool_id.toLowerCase() === "gemini models",
              );
              const otherSnapshot = accountSnapshots.find(
                (s) =>
                  s.pool_id === "Claude and GPT models" ||
                  s.pool_id.toLowerCase().includes("claude") ||
                  s.pool_id.toLowerCase().includes("gpt"),
              );
              const argonSnapshot = accountSnapshots.find(s => s.pool_id.toLowerCase() === "gemini 4 argon");

              return (
                <div
                  key={account.id}
                  className={`agy-account-row ${isActive ? "is-active-account" : ""}`}
                >
                  <div className="agy-account-main-info">
                    <div className="agy-account-title-line">
                      <span className="agy-account-email">{account.identity.email}</span>
                      {isActive ? (
                        <span className={identityVerified ? "agy-badge active" : "agy-badge ready"}>
                          {identityVerified ? "当前使用中" : "上次确认"}
                        </span>
                      ) : (
                        <span className="agy-badge ready">
                          {account.saved_credential_status === "unverified" ? "保存凭据待核验"
                            : account.saved_credential_status === "needs_update" ? "保存凭据需更新"
                            : formatAccountStateLabel(account.state)}
                        </span>
                      )}
                    </div>

                    <span style={{ fontSize: "12px", color: "#64748b" }}>额度查询时间：{accountSnapshots[0]?.observed_at ? new Date(accountSnapshots[0].observed_at).toLocaleString() : "尚未查询"}</span>
                    {quotaError && <span className="agy-no-quota">{quotaError === "account_identity_in_use" ? "等待 AGY 空闲后核验"
                      : quotaError === "authentication_required" ? "DevFlow 额度查询凭据需更新" : "额度查询失败，显示上次结果"}</span>}
                    {/* Show the provider's actual quota groups. Argon has no five-hour window. */}
                    <div className="agy-account-quotas-dual">
                      {/* 上方：Gemini 额度 */}
                      <div className="agy-quota-group" data-category="gemini">
                        <span className="agy-quota-group-label gemini">Gemini 额度</span>
                        <div className="agy-quota-bars">
                          {geminiSnapshot ? (
                            <>
                                <CompactQuotaBar snapshot={geminiSnapshot} kind="weekly" now={now} />
                                <CompactQuotaBar snapshot={geminiSnapshot} kind="five_hour" now={now} />
                            </>
                          ) : (
                            <span className="agy-no-quota">
                              {refreshing ? "额度探测中..." : "待实测/不可用"}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 下方：Claude / GPT 额度 */}
                      <div className="agy-quota-group" data-category="other">
                        <span className="agy-quota-group-label other">Claude / GPT 额度</span>
                        <div className="agy-quota-bars">
                          {otherSnapshot ? (
                            <>
                                <CompactQuotaBar snapshot={otherSnapshot} kind="weekly" now={now} />
                                <CompactQuotaBar snapshot={otherSnapshot} kind="five_hour" now={now} />
                            </>
                          ) : (
                            <span className="agy-no-quota">
                              {refreshing ? "额度探测中..." : "待实测/不可用"}
                            </span>
                          )}
                        </div>
                      </div>
                      {argonSnapshot && <div className="agy-quota-group" data-category="argon">
                        <span className="agy-quota-group-label gemini">Gemini 4 Argon</span>
                        <div className="agy-quota-bars">
                          <CompactQuotaBar snapshot={argonSnapshot} kind="weekly" now={now} />
                        </div>
                      </div>}
                    </div>
                  </div>

                  <div className="agy-account-actions">
                    {(account.state === "reauth_required" || account.saved_credential_status === "needs_update") && (
                      <button
                        type="button"
                        className="agy-icon-btn"
                        disabled={!!activeOperation || !serviceFresh}
                        onClick={() => setReauthAccount(account)}
                        title={isActive && identityVerified ? "更新查询凭据" : "重新登录验证"}
                      >
                        {isActive && identityVerified ? "更新查询凭据" : "重新登录"}
                      </button>
                    )}
                    {!isActive && account.saved_credential_status !== "needs_update" && account.state !== "disabled" && (
                      <button type="button" className="agy-icon-btn" disabled={!!activeOperation || !serviceFresh}
                        onClick={() => handleProbeAccount(account)}>核验额度</button>
                    )}
                    {!isActive && account.state !== "reauth_required" && account.saved_credential_status !== "needs_update" && (
                        <button
                          type="button"
                          className="agy-secondary-btn"
                          disabled={!!submittingAccount || !!activeOperation || !serviceFresh}
                          onClick={() => handleSwitchTo(account.id)}
                          title="切换后新命令使用此账号，已启动的命令继续运行"
                        >
                          设为活动
                        </button>
                    )}
                    <button
                      type="button"
                      className="agy-icon-btn danger"
                      onClick={() => handleDeleteAccount(account)}
                      title="移除账号"
                    >
                      移除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {reauthAccount && (
        <div className="agy-modal-overlay">
          <div className="agy-modal-content" role="dialog" aria-modal="true" aria-label="重新登录 AGY 账号">
            <div className="agy-modal-header"><h3>重新登录 {reauthAccount.identity.email}</h3></div>
            <div className="agy-enroll-form">
              <p>{reauthAccount.id === activeAccountId
                ? "核对身份后保存当前账号的新凭据。额度随后查询。"
                : "重新登录会临时占用本机登录位。仅更新保存凭据时，操作结束后恢复原登录。"}</p>
              <p>请先退出正在使用凭据的 Antigravity 桌面端或 AGY 会话。</p>
              <div className="agy-modal-footer">
                <button type="button" className="agy-secondary-btn" disabled={reauthSubmitting}
                  onClick={() => setReauthAccount(null)}>取消</button>
                {reauthAccount.id !== activeAccountId && (
                  <button type="button" className="agy-secondary-btn" disabled={reauthSubmitting}
                    onClick={() => handleReauth("save_only")}>仅更新保存凭据</button>
                )}
                <button type="button" className="agy-primary-btn" disabled={reauthSubmitting}
                  onClick={() => handleReauth("activate")}>
                  {reauthAccount.id === activeAccountId ? "更新当前登录" : "更新并设为活动"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <AgyAccountEnrollment
        isOpen={enrollOpen}
        onClose={() => {
          setEnrollOpen(false);
        }}
        onOperation={(op) => {
          setActiveOperation(op);
          void refresh(op.phase === "completed");
          if (op.phase === "completed") void syncAndRefresh();
        }}
      />
    </div>
  );
});
