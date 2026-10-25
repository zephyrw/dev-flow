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
  service_state: string;
  desired_enabled: boolean;
}

interface AccountView {
  refresh_scope?: "all" | "active_only";
  refresh_errors?: Array<{ account_id: string }>;
  model_id?: string | null;
  active_category?: "gemini" | "other" | "mixed" | "unknown" | null;
  selection_context?: AgyManagementSelectionContext;
  accounts: Array<Pick<AgyAccountDto, "id" | "revision" | "identity" | "state">>;
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
  refresh: { status: "running" | "succeeded" | "failed" | "cancelled"; account_id?: string } | null;
}

interface ServiceView extends Realm {
  operations: AccountOperationView[];
  automation?: {
    enabled: boolean;
    service_state: string;
    can_toggle: boolean;
  };
}

// Keep only public snapshots across dialog mounts; never replace known data with
// an empty list because a request failed.
let accountSnapshot: { value: AccountView; observedAt: number } | null = null;
let serviceSnapshot: ServiceView | null = null;
let switchIntent: { accountId: string; body: string } | null = null;

function CompactQuotaBar({
  snapshot,
  kind,
}: {
  snapshot: AccountView["snapshots"][number] | undefined;
  kind: AgyQuotaSnapshot["windows"][number]["kind"];
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
  const value = formatSnapshotQuotaWindow(snapshot, kind);
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
  const [view, setView] = useState<AccountView | null>(accountSnapshot?.value ?? null);
  const [service, setService] = useState<ServiceView | null>(serviceSnapshot);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [dismissedOperationId, setDismissedOperationId] = useState("");
  const [notice, setNotice] = useState("");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [togglingAutomation, setTogglingAutomation] = useState(false);
  const [activeOperation, setActiveOperation] = useState<AccountOperationView | null>(null);

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
        const operation = next.service.operations.find(op => !terminalOperation(op.phase)) ?? null;
        setActiveOperation(operation);
        const running = next.refresh?.status === "running";
        busy.current = running || !!operation;
        readFailed.current = false;
        scheduleFallback.current();
        setRefreshing(running);
        setQuotaWarning(next.refresh?.status === "failed" ? "额度更新失败，已保留上次结果（可能已过期）" : "");
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

  const syncAndRefresh = useCallback((force = true): Promise<void> => {
    if (quotaRequest.current) return quotaRequest.current;
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted) return Promise.resolve();
    setRefreshing(true);
    const pending = (async () => {
      try {
        await agyApi("/refresh", {
          method: "POST", body: requestBody({ force }), signal: controller.signal,
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
    const visibility = () => { if (visible()) void refresh(true); schedule(); };
    document.addEventListener("visibilitychange", visibility);
    void refresh().then(() => { if (!controller.signal.aborted && visible()) void syncAndRefresh(false); });
    connect(); schedule();
    return () => {
      controller.abort(); readAbort.current?.abort(); socket?.close();
      clearTimeout(retry); clearTimeout(notification); clearTimeout(fallback);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh, syncAndRefresh]);

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
      operation_in_progress: "当前已有另一项账号操作正在进行中，请先等待其完成或点击取消",
      account_in_use: "该账号当前正在使用中，无法移除，请先切换至其他账号",
      external_change: "检测到外部 AGY 正在修改凭据，请稍后重试",
      identity_mismatch: "切换期间检测到账号身份变化，请刷新账号后重试",
      identity_unverified: "当前账号身份暂未核对成功，请刷新账号后重试；无需因此重新登录",
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

  const handleReauth = async (account: AccountView["accounts"][number]) => {
    setError("");
    try {
      const op = await agyApi<AccountOperationView>(`/${encodeURIComponent(account.id)}/reauth`, {
        method: "POST",
        body: requestBody({
          expected_account_revision: account.revision,
          expected_identity: account.identity.email,
        }),
      });
      setActiveOperation(op);
      await refresh();
    } catch (e) {
      setError(formatErrorMsg(e, "重新认证失败"));
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
    try {
      await agyApi<AccountOperationView>(`/operations/${encodeURIComponent(op.operation_id)}/cancel`, {
        method: "POST",
        body: requestBody({
          expected_revision: op.revision,
        }),
      });
      await refresh();
    } catch (e) {
      await refresh();
      setError(e instanceof Error ? e.message : "取消操作失败");
    }
  };

  const isAutomationOn = Boolean(
    service?.automation?.enabled ??
    (service?.service_state === "running" || service?.desired_enabled)
  );

  const accounts = view?.accounts ?? [];
  const latestOperation = service?.operations[0];
  const operationError = latestOperation && latestOperation.operation_id !== dismissedOperationId &&
    ["failed", "blocked", "cancelled"].includes(latestOperation.phase) && latestOperation.error &&
    latestOperation.error !== "operation_cancelled"
    ? formatFriendlyError(latestOperation.error) : "";
  const activeAccountId = serviceFresh ? service?.active_account_id : view?.realm?.active_account_id;

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
            <span className="agy-op-spinner" />
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span>
                正在执行：{operationLabels[activeOperation.phase] ?? activeOperation.phase}
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
          <button
            type="button"
            className="agy-text-btn danger"
            onClick={() => handleCancelOperation(activeOperation)}
          >
            取消操作
          </button>
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
                        <span className="agy-badge active">当前使用中</span>
                      ) : (
                        <span className="agy-badge ready">
                          {formatAccountStateLabel(account.state)}
                        </span>
                      )}
                    </div>

                    <span style={{ fontSize: "12px", color: "#64748b" }}>额度查询时间：{accountSnapshots[0]?.observed_at ? new Date(accountSnapshots[0].observed_at).toLocaleString() : "尚未查询"}</span>
                    {/* Show the provider's actual quota groups. Argon has no five-hour window. */}
                    <div className="agy-account-quotas-dual">
                      {/* 上方：Gemini 额度 */}
                      <div className="agy-quota-group" data-category="gemini">
                        <span className="agy-quota-group-label gemini">Gemini 额度</span>
                        <div className="agy-quota-bars">
                          {geminiSnapshot ? (
                            <>
                              <CompactQuotaBar snapshot={geminiSnapshot} kind="weekly" />
                              <CompactQuotaBar snapshot={geminiSnapshot} kind="five_hour" />
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
                              <CompactQuotaBar snapshot={otherSnapshot} kind="weekly" />
                              <CompactQuotaBar snapshot={otherSnapshot} kind="five_hour" />
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
                          <CompactQuotaBar snapshot={argonSnapshot} kind="weekly" />
                        </div>
                      </div>}
                    </div>
                  </div>

                  <div className="agy-account-actions">
                    {account.state === "reauth_required" ? (
                      <button
                        type="button"
                        className="agy-icon-btn"
                        onClick={() => handleReauth(account)}
                        title="重新登录验证"
                      >
                        重新登录
                      </button>
                    ) : (
                      !isActive && (
                        <button
                          type="button"
                          className="agy-secondary-btn"
                          disabled={!!submittingAccount || !!activeOperation || !serviceFresh}
                          onClick={() => handleSwitchTo(account.id)}
                          title="切换后新命令使用此账号，已启动的命令继续运行"
                        >
                          设为活动
                        </button>
                      )
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

      {/* 添加账号弹窗 */}
      <AgyAccountEnrollment
        isOpen={enrollOpen}
        realmRevision={view?.realm?.revision ?? 0}
        onClose={() => {
          setEnrollOpen(false);
          void syncAndRefresh().catch(() => {});
        }}
        onOperation={(op) => {
          setActiveOperation(op);
          void refresh();
        }}
      />
    </div>
  );
});
