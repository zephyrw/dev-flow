import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
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
import { AgyAccountEnrollment } from "./AgyAccountEnrollment.js";
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
  model_id?: string | null;
  active_category?: "gemini" | "other" | "unknown" | null;
  selection_context?: AgyManagementSelectionContext;
  accounts: AgyAccountDto[];
  snapshots: AgyQuotaSnapshot[];
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

interface ServiceView extends Realm {
  operations: AccountOperationView[];
  automation?: {
    enabled: boolean;
    service_state: string;
    can_toggle: boolean;
  };
}

function CompactQuotaBar({
  snapshot,
  kind,
}: {
  snapshot: AgyQuotaSnapshot | undefined;
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
  const tooltip = value.shortResetText
    ? `${value.label}：${value.percentageText}，${value.resetText}`
    : `${value.label}：${value.percentageText}`;

  return (
    <div className="agy-compact-quota" title={tooltip}>
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
  { onDismiss?: () => void }
>(function AgyAccountsPanel({ onDismiss }, ref) {
  const [view, setView] = useState<AccountView | null>(null);
  const [service, setService] = useState<ServiceView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [togglingAutomation, setTogglingAutomation] = useState(false);
  const [activeOperation, setActiveOperation] = useState<AccountOperationView | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [accountsData, serviceData] = await Promise.all([
        agyApi<AccountView>(""),
        agyApi<ServiceView>("/service"),
      ]);
      setView(accountsData);
      setService(serviceData);

      const runningOp = serviceData.operations.find(
        (op) => !terminalOperation(op.phase),
      );
      setActiveOperation(runningOp ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const syncAndRefresh = useCallback(async () => {
    setError("");
    setRefreshing(true);
    try {
      const [updatedView, serviceData] = await Promise.all([
        agyApi<AccountView>("/sync-refresh", {
          method: "POST",
          body: requestBody({}),
        }),
        agyApi<ServiceView>("/service"),
      ]);
      setView(updatedView);
      setService(serviceData);

      const runningOp = serviceData.operations.find(
        (op) => !terminalOperation(op.phase),
      );
      setActiveOperation(runningOp ?? null);
      setNotice(updatedView.refresh_scope === "active_only"
        ? "AGY 正在运行，已仅刷新当前账号；其他账号保留上次额度结果"
        : "已刷新账号额度");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "刷新账号与额度失败";
      setError(msg);
      throw e;
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      syncAndRefresh,
    }),
    [refresh, syncAndRefresh],
  );

  useEffect(() => {
    void agyApi("/sync-active", { method: "POST", body: requestBody({}) })
      .catch(() => {})
      .finally(() => {
        void refresh();
        // 打开面板后在后台静默对齐一次当前账号最新实测额度，防止额度因近期会话消耗后界面仍停留于旧快照
        void agyApi<AccountView>("/sync-refresh", {
          method: "POST",
          body: requestBody({}),
        })
          .then((updatedView) => {
            setView(updatedView);
            if (updatedView.refresh_scope === "active_only")
              setNotice("AGY 正在运行，已仅刷新当前账号；其他账号保留上次额度结果");
          })
          .catch(() => {});
      });
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

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
      domain_lock_acquire_failed: "未能获取系统账号锁，可能有其他进程正在使用",
    };
    return friendlyMap[raw] || (raw ? `${fallback}: ${raw}` : fallback);
  };

  const handleSwitchTo = async (accountId: string) => {
    setError("");
    try {
      const op = await agyApi<AccountOperationView>("/switch", {
        method: "POST",
        body: requestBody({
          selection: { mode: "explicit", account_id: accountId },
          expected_epoch: service?.auth_epoch ?? 0,
        }),
      });
      setActiveOperation(op);
      setNotice("已发起切换账号操作");
      setTimeout(() => setNotice(""), 3000);
      await refresh();
    } catch (e) {
      setError(formatErrorMsg(e, "切换账号失败"));
    }
  };

  const handleReauth = async (account: AgyAccountDto) => {
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

  const handleDeleteAccount = async (account: AgyAccountDto) => {
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
  const activeAccountId = service?.active_account_id;

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
              disabled={togglingAutomation}
              onChange={handleToggleAutomation}
            />
            <span className="agy-switch-slider" />
            <span className="agy-switch-text">自动切换账号</span>
          </label>
          <span className="agy-switch-desc">
            {isAutomationOn ? "额度耗尽时自动选择最佳账号" : "已停用自动切换，当前仅执行手动切换"}
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
      {error && (
        <div className="agy-alert-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>✕</button>
        </div>
      )}

      {/* 成功反馈 */}
      {notice && (
        <div className="agy-alert-success" role="status">
          {notice}
        </div>
      )}

      {/* 账号列表 */}
      <div className="agy-accounts-list-wrap">
        <div className="agy-list-header">
          <span>已管理账号 {loading && !view ? "" : `(${accounts.length})`}</span>
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
              
              // 严格独立提取两组快照，严禁互借补位
              const geminiSnapshot = accountSnapshots.find(
                (s) => s.pool_id === "Gemini Models" || s.pool_id.toLowerCase().includes("gemini"),
              );
              const otherSnapshot = accountSnapshots.find(
                (s) =>
                  s.pool_id === "Claude and GPT models" ||
                  s.pool_id.toLowerCase().includes("claude") ||
                  s.pool_id.toLowerCase().includes("gpt"),
              );

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

                    {/* 双组额度分别展示，不按当前模型隐藏另一组 */}
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
                          onClick={() => handleSwitchTo(account.id)}
                          title="切换为当前活动账号"
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
