import React, { useCallback, useEffect, useState } from "react";
import "./agy-accounts.css";
import {
  formatQuotaWindow,
  formatAccountStateLabel,
} from "../../../../packages/presentation/src/agy-accounts.js";
import type {
  AgyAccountDto,
  AgyQuotaSnapshot,
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

interface Realm {
  revision: number;
  control_generation: number;
  auth_epoch: number;
  active_account_id?: string | null;
  service_state: string;
  desired_enabled: boolean;
}

interface AccountView {
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
  window,
}: {
  window: AgyQuotaSnapshot["windows"][number] | undefined;
}) {
  if (!window) return null;
  const value = formatQuotaWindow(window);
  const percent = value.fraction !== null ? Math.round(value.fraction * 100) : null;

  return (
    <div className="agy-compact-quota" title={`${value.label}：${value.percentageText}，${value.resetText}`}>
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
    </div>
  );
}

export function AgyAccountsPanel({ onDismiss }: { onDismiss?: () => void }) {
  const [view, setView] = useState<AccountView | null>(null);
  const [service, setService] = useState<ServiceView | null>(null);
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
    }
  }, []);

  useEffect(() => {
    void refresh();
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

  const handleSwitchTo = async (accountId: string) => {
    setError("");
    try {
      await agyApi<AccountOperationView>("/switch", {
        method: "POST",
        body: requestBody({
          selection: { mode: "explicit", account_id: accountId },
          expected_epoch: service?.auth_epoch ?? 0,
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "切换账号失败");
    }
  };

  const handleReauth = async (account: AgyAccountDto) => {
    setError("");
    try {
      await agyApi<AccountOperationView>(`/${encodeURIComponent(account.id)}/reauth`, {
        method: "POST",
        body: requestBody({
          expected_account_revision: account.revision,
          expected_identity: account.identity.email,
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "重新认证失败");
    }
  };

  const handleDeleteAccount = async (account: AgyAccountDto) => {
    if (!window.confirm(`确定要移除账号 ${account.alias || account.identity.email} 吗？`)) {
      return;
    }
    setError("");
    try {
      await agyApi<AccountOperationView>(`/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        body: requestBody({
          expected_revision: account.revision,
        }),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "移除账号失败");
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
        </div>

        <button
          type="button"
          className="agy-primary-btn"
          onClick={() => setEnrollOpen(true)}
        >
          + 添加管理账号
        </button>
      </div>

      {/* 正在进行中的操作提示卡片 */}
      {activeOperation && (
        <div className="agy-active-op-card">
          <div className="agy-active-op-info">
            <span className="agy-op-spinner" />
            <span>
              正在执行：{operationLabels[activeOperation.phase] ?? activeOperation.phase}
            </span>
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
          <span>已管理账号 ({accounts.length})</span>
        </div>

        {accounts.length === 0 ? (
          <div className="agy-empty-state">
            <span className="agy-empty-icon">👥</span>
            <p>暂无管理的 AGY 账号</p>
            <button
              type="button"
              className="agy-secondary-btn"
              onClick={() => setEnrollOpen(true)}
            >
              立即添加第一个账号
            </button>
          </div>
        ) : (
          <div className="agy-accounts-grid">
            {accounts.map((account) => {
              const isActive = account.id === activeAccountId;
              const snapshot = view?.snapshots.find((s) => s.account_id === account.id);
              const weeklyWindow = snapshot?.windows.find(
                (w) => w.duration_minutes === 10080 || w.kind === "weekly",
              );
              const shortWindow = snapshot?.windows.find(
                (w) => w.duration_minutes === 300 || w.kind === "five_hour",
              );

              return (
                <div
                  key={account.id}
                  className={`agy-account-row ${isActive ? "is-active-account" : ""}`}
                >
                  <div className="agy-account-main-info">
                    <div className="agy-account-title-line">
                      <span className="agy-account-email">{account.identity.email}</span>
                      {account.alias && (
                        <span className="agy-account-alias">({account.alias})</span>
                      )}
                      {isActive ? (
                        <span className="agy-badge active">当前使用中</span>
                      ) : (
                        <span className="agy-badge ready">
                          {formatAccountStateLabel(account.state)}
                        </span>
                      )}
                    </div>

                    {/* 紧凑额度条 */}
                    <div className="agy-account-quotas">
                      {weeklyWindow ? (
                        <CompactQuotaBar window={weeklyWindow} />
                      ) : (
                        <span className="agy-no-quota">周额度待实测</span>
                      )}
                      {shortWindow ? (
                        <CompactQuotaBar window={shortWindow} />
                      ) : null}
                    </div>
                  </div>

                  <div className="agy-account-actions">
                    {!isActive && (
                      <button
                        type="button"
                        className="agy-secondary-btn"
                        onClick={() => handleSwitchTo(account.id)}
                        title="切换为当前活动账号"
                      >
                        设为活动
                      </button>
                    )}
                    <button
                      type="button"
                      className="agy-icon-btn"
                      onClick={() => handleReauth(account)}
                      title="重新登录验证"
                    >
                      重新登录
                    </button>
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
        onClose={() => setEnrollOpen(false)}
        onOperation={(op) => {
          setActiveOperation(op);
          void refresh();
        }}
      />
    </div>
  );
}
