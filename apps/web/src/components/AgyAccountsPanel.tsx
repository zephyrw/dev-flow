import React, { useCallback, useEffect, useState } from "react";
import "./agy-accounts.css";
import {
  formatQuotaWindow,
  formatAccountStateLabel,
} from "../../../../packages/presentation/src/agy-accounts.js";
import type {
  AgyAccountDto,
  AgyAccountSettings,
  AgyQuotaSnapshot,
} from "../../../../packages/contracts/src/agy-account.js";
import { AgyAccountEnrollment } from "./AgyAccountEnrollment.js";
import { AgyMaintenancePanel } from "./AgyMaintenancePanel.js";
import {
  agyApi,
  requestBody,
  terminalOperation,
  operationLabels,
  serviceLabels,
  type AccountOperationView,
} from "./agy-api.js";
type Settings = Omit<AgyAccountSettings, "auth_host_executable">;
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
  settings: Settings | null;
  realm: Realm | null;
  model_id?: string | null;
  required_pool_ids: string[];
  candidates: Array<{
    account_id: string;
    projected_weekly: number;
    is_projected_reset: boolean;
  }>;
  excluded_accounts: Array<{ account_id: string; reason: string }>;
  capability: { supported: boolean; reason?: string };
  next_eligible_at?: string | null;
}
interface ServiceView extends Realm {
  operations: AccountOperationView[];
}
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString() : "未提供";
function QuotaBar({
  window,
}: {
  window: AgyQuotaSnapshot["windows"][number] | undefined;
}) {
  const value = formatQuotaWindow(window);
  return (
    <div>
      <div
        className="agy-progress-bar-wrap"
        role="progressbar"
        aria-label={value.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={
          value.fraction === null ? undefined : Math.round(value.fraction * 100)
        }
        aria-valuetext={`${value.percentageText}，${value.resetText}`}
      >
        <div
          className={`agy-progress-bar-fill ${value.statusClass}`}
          style={{ width: `${(value.fraction ?? 0) * 100}%` }}
        />
      </div>
      <div className="agy-progress-subtext">
        {value.percentageText} · {value.resetText}
      </div>
      <div>重置时间：{date(window?.reset_at)}</div>
    </div>
  );
}
export function AgyAccountsPanel() {
  const [view, setView] = useState<AccountView | null>(null);
  const [service, setService] = useState<ServiceView | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [maintOpen, setMaintOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [history, setHistory] = useState<AgyQuotaSnapshot[] | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [next, srv] = await Promise.all([
      agyApi<AccountView>(""),
      agyApi<ServiceView>("/service"),
    ]);
    setView(next);
    setService(srv);
    setSelectedId((previous) =>
      next.accounts.some((a) => a.id === previous)
        ? previous
        : (srv.active_account_id ?? next.accounts[0]?.id ?? null),
    );
  }, []);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      15000,
    );
    return () => clearInterval(timer);
  }, [refresh]);
  const operations = service?.operations ?? [];
  const activeOperation = operations.find((op) => !terminalOperation(op.phase));
  useEffect(() => {
    if (!activeOperation) return;
    const timer = setInterval(
      () => void refresh().catch((e) => setError(e.message)),
      2000,
    );
    return () => clearInterval(timer);
  }, [activeOperation?.operation_id, refresh]);
  const running = service?.service_state === "running";
  const canOperate = !!running && !busy && !activeOperation;
  const selected = view?.accounts.find((a) => a.id === selectedId);
  const pools = view?.required_pool_ids ?? [];
  const snapFor = (id: string) =>
    view?.snapshots.filter(
      (s) =>
        s.account_id === id &&
        (pools.length ? pools.includes(s.pool_id) : false),
    ) ?? [];
  async function attempt(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const accepted = (op: AccountOperationView) => {
    setNotice(
      `操作已受理：${op.operation_id}。${operationLabels[op.phase] ?? op.phase}`,
    );
    void refresh().catch((e) => setError(e.message));
  };
  async function operate(path: string, value: object, method = "POST") {
    accepted(
      await agyApi<AccountOperationView>(path, {
        method,
        body: requestBody(value),
      }),
    );
  }
  function switchTo(accountId?: string) {
    void attempt(() =>
      operate("/switch", {
        selection: accountId
          ? { mode: "explicit", account_id: accountId }
          : { mode: "auto" },
        model_id: view?.settings?.standalone_model_id ?? undefined,
        expected_epoch: service?.auth_epoch ?? 0,
        expected_settings_revision: view?.settings?.revision ?? 0,
      }),
    );
  }
  async function loadHistory(more = false) {
    if (!selected) return;
    const result = await agyApi<{
      items: AgyQuotaSnapshot[];
      next_cursor: string | null;
    }>(
      `/${encodeURIComponent(selected.id)}/history?limit=50${more && historyCursor ? `&after=${encodeURIComponent(historyCursor)}` : ""}`,
    );
    setHistory((items) =>
      more ? [...(items ?? []), ...result.items] : result.items,
    );
    setHistoryCursor(result.next_cursor);
  }
  useEffect(() => {
    setHistory(null);
    setHistoryCursor(null);
  }, [selectedId]);
  return (
    <div className="agy-accounts-container">
      <div className="agy-accounts-header">
        <div>
          <h2>AGY 账号与额度管理</h2>
          <p>
            管理状态：
            <strong>
              {serviceLabels[service?.service_state ?? "stopped"] ??
                service?.service_state}
            </strong>{" "}
            · 活动账号：
            {view?.accounts.find((a) => a.id === service?.active_account_id)
              ?.alias ?? "未激活"}
          </p>
          <p>
            目标模型：
            {view?.settings?.standalone_model_id ?? "请先配置目标模型"}
          </p>
        </div>
        <div className="agy-header-actions">
          <button
            className="agy-btn"
            disabled={busy}
            onClick={() => {
              setDraft(view?.settings ?? null);
              setSettingsOpen(true);
            }}
          >
            配置
          </button>
          {running ? (
            <button
              className="agy-btn"
              disabled={busy}
              onClick={() =>
                void attempt(() =>
                  operate("/service/stop", {
                    expected_control_generation:
                      service?.control_generation ?? 0,
                  }),
                )
              }
            >
              停止管理
            </button>
          ) : (
            <button
              className="agy-btn agy-btn-primary"
              disabled={busy || service?.service_state === "stopping"}
              onClick={() =>
                void attempt(() =>
                  operate("/service/start", {
                    expected_settings_revision: view?.settings?.revision ?? 0,
                  }),
                )
              }
            >
              启动管理
            </button>
          )}
          <button
            className="agy-btn"
            disabled={!canOperate}
            onClick={() => setEnrollOpen(true)}
          >
            录入账号
          </button>
          <button className="agy-btn" onClick={() => setMaintOpen(true)}>
            日间维护
          </button>
          <button
            className="agy-btn agy-btn-primary"
            disabled={
              !canOperate ||
              !view?.settings?.standalone_model_id ||
              !view?.capability.supported
            }
            onClick={() => switchTo()}
          >
            自动选择并切换
          </button>
        </div>
      </div>
      <p>
        备用账号显示上次实测余额；浏览、刷新和倒计时不会联网探测备用账号。切换后新启动的
        AGY CLI 使用新身份。
      </p>
      <p>
        工作流自动切号：
        {view?.settings?.workflow_auto_switch
          ? "已启用，仅对受管工作流的可信额度/认证错误生效"
          : "已停用"}
        。手动切换
        {view?.settings?.pause_managed_for_manual_switch
          ? "可按原恢复策略暂时中断本模块管理的 AGY 任务"
          : "遇受管任务占用时等待"}
        ，外部 CLI 必须先退出。
      </p>
      {view && !view.capability.supported && (
        <p className="agy-notice" role="status">
          能力暂不可用：{view.capability.reason ?? "当前官方 CLI 能力尚未确认"}
        </p>
      )}
      {error && (
        <div className="agy-notice agy-notice-danger" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {activeOperation && (
        <section aria-label="当前操作">
          <h3>
            当前操作：
            {operationLabels[activeOperation.phase] ?? activeOperation.phase}
          </h3>
          <p>{activeOperation.operation_id}</p>
          {activeOperation.deadline_at && (
            <p>本次操作截止：{date(activeOperation.deadline_at)}</p>
          )}
          {activeOperation.external_processes?.map((p) => (
            <p key={p.pid}>
              请退出外部 AGY：PID {p.pid} · {p.exe_path}
            </p>
          ))}
          <button
            className="agy-btn"
            disabled={
              busy || activeOperation.phase === "cancellation_requested"
            }
            onClick={() =>
              void attempt(() =>
                operate(
                  `/operations/${encodeURIComponent(activeOperation.operation_id)}/cancel`,
                  { expected_revision: activeOperation.revision },
                ),
              )
            }
          >
            取消当前操作
          </button>
        </section>
      )}
      <table className="agy-accounts-table">
        <thead>
          <tr>
            <th>账号 / 状态</th>
            <th>目标池双额度（上次实测）</th>
            <th>候选与排除原因</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {view?.accounts.map((account) => {
            const snapshots = snapFor(account.id);
            const rank = view.candidates.findIndex(
              (c) => c.account_id === account.id,
            );
            const excluded = view.excluded_accounts.find(
              (c) => c.account_id === account.id,
            );
            return (
              <tr
                key={account.id}
                onClick={() => setSelectedId(account.id)}
                aria-selected={account.id === selectedId}
              >
                <td>
                  <strong>{account.alias}</strong>
                  <div>{account.identity.email}</div>
                  <div>
                    {account.id === service?.active_account_id
                      ? "当前活动 · "
                      : ""}
                    {formatAccountStateLabel(account.state)}
                  </div>
                </td>
                <td>
                  {snapshots.length
                    ? snapshots.map((s) => (
                        <div key={s.id}>
                          <div>额度池：{s.pool_id}</div>
                          <strong>周额度</strong>
                          <QuotaBar
                            window={s.windows.find((w) => w.kind === "weekly")}
                          />
                          <strong>五小时额度</strong>
                          <QuotaBar
                            window={s.windows.find(
                              (w) => w.kind === "five_hour",
                            )}
                          />
                          <small>
                            上次实测：{date(s.observed_at)} · {s.source}
                            {Date.now() - Date.parse(s.observed_at) >
                            (view.settings?.local_snapshot_stale_hours ?? 24) *
                              3600000
                              ? " · 记录陈旧，激活后核验"
                              : ""}
                          </small>
                        </div>
                      ))
                    : "目标池待补测 / 尚未配置模型"}
                </td>
                <td>
                  {rank >= 0
                    ? `候选第 ${rank + 1} 名${view.candidates[rank]?.is_projected_reset ? "（预计已重置，待核验）" : ""}`
                    : (excluded?.reason ?? "尚未具备候选资格")}
                </td>
                <td>
                  <button
                    className="agy-btn"
                    disabled={
                      !canOperate ||
                      !view.settings?.standalone_model_id ||
                      !!excluded ||
                      !view.capability.supported
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      switchTo(account.id);
                    }}
                  >
                    切换到此账号
                  </button>
                  <button
                    className="agy-btn"
                    onClick={() => setSelectedId(account.id)}
                  >
                    查看详情
                  </button>
                </td>
              </tr>
            );
          })}
          {!view?.accounts.length && (
            <tr>
              <td colSpan={4}>
                尚未录入账号。启动管理后可逐一录入，无需创建项目或工作流。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {view?.next_eligible_at && (
        <p>
          预计最早可核验：{date(view.next_eligible_at)}
          。手动操作不会在到时后自行切换。
        </p>
      )}
      {selected && (
        <section aria-label="账号详情">
          <h3>账号详情：{selected.alias}</h3>
          <p>
            访问令牌到期：{date(selected.auth.access_expires_at)}，激活后由官方
            CLI 按需刷新。
          </p>
          <p>
            刷新授权到期：
            {selected.auth.refresh_expires_at
              ? date(selected.auth.refresh_expires_at)
              : "未提供固定到期，不能保证永久有效"}
          </p>
          <p>
            最近访问成功：{date(selected.auth.last_authenticated_request_at)}
            ；最近刷新证实：
            {selected.auth.last_refresh_verified_at
              ? date(selected.auth.last_refresh_verified_at)
              : "尚未验证"}
          </p>
          <div className="agy-header-actions">
            <button
              className="agy-btn"
              disabled={!canOperate}
              onClick={() =>
                void attempt(() =>
                  operate(`/${encodeURIComponent(selected.id)}/probe`, {
                    expected_account_revision: selected.revision,
                  }),
                )
              }
            >
              补测
            </button>
            <button
              className="agy-btn"
              disabled={!canOperate}
              onClick={() =>
                void attempt(() =>
                  operate(`/${encodeURIComponent(selected.id)}/reauth`, {
                    expected_account_revision: selected.revision,
                    expected_identity: selected.identity.email,
                  }),
                )
              }
            >
              重新认证
            </button>
            <button
              className="agy-btn"
              disabled={busy || !!activeOperation}
              onClick={() =>
                void attempt(() =>
                  agyApi(`/${encodeURIComponent(selected.id)}`, {
                    method: "PATCH",
                    body: requestBody({
                      expected_revision: selected.revision,
                      enabled: selected.state === "disabled",
                    }),
                  }),
                )
              }
            >
              {selected.state === "disabled" ? "启用" : "停用"}
            </button>
            <button
              className="agy-btn"
              onClick={() => void attempt(() => loadHistory())}
            >
              历史
            </button>
            <button
              className="agy-btn agy-btn-danger"
              disabled={
                !canOperate || selected.id === service?.active_account_id
              }
              onClick={() =>
                void attempt(() =>
                  operate(
                    `/${encodeURIComponent(selected.id)}`,
                    { expected_revision: selected.revision },
                    "DELETE",
                  ),
                )
              }
            >
              删除本地备用授权
            </button>
          </div>
          {history && (
            <div>
              <h4>额度历史</h4>
              {history.map((s) => (
                <p key={s.id}>
                  {date(s.observed_at)} · {s.pool_id} · 周{" "}
                  {
                    formatQuotaWindow(
                      s.windows.find((w) => w.kind === "weekly"),
                    ).percentageText
                  }{" "}
                  · 五小时{" "}
                  {
                    formatQuotaWindow(
                      s.windows.find((w) => w.kind === "five_hour"),
                    ).percentageText
                  }
                </p>
              ))}
              {historyCursor && (
                <button
                  className="agy-btn"
                  onClick={() => void attempt(() => loadHistory(true))}
                >
                  更多历史
                </button>
              )}
            </div>
          )}
        </section>
      )}
      {!!operations.length && (
        <section aria-label="操作历史">
          <h3>操作历史</h3>
          {operations.slice(0, 20).map((op) => (
            <div key={op.operation_id}>
              <strong>{operationLabels[op.phase] ?? op.phase}</strong> ·{" "}
              {op.kind} · {op.trigger} · {date(op.created_at)} ·{" "}
              {op.operation_id}
              {(op.before_account_id || op.target_account_id) && (
                <p>
                  {view?.accounts.find((a) => a.id === op.before_account_id)
                    ?.alias ??
                    op.before_account_id ??
                    "未激活"}{" "}
                  →{" "}
                  {view?.accounts.find((a) => a.id === op.target_account_id)
                    ?.alias ??
                    op.target_account_id ??
                    "候选待定"}
                </p>
              )}
              {op.error && <p role="alert">{op.error}</p>}
              {op.result?.message && <p>{op.result.message}</p>}
              {op.phase === "completed" && op.kind === "switch" && (
                <p>
                  活动身份已确认。新启动的 AGY CLI
                  将使用该账号；外部会话不会自动恢复。
                </p>
              )}
            </div>
          ))}
        </section>
      )}
      {settingsOpen && (
        <div className="agy-modal-overlay">
          <form
            className="agy-modal"
            aria-label="账号配置"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft) return;
              void attempt(async () => {
                const {
                  realm_id: _realm,
                  revision,
                  updated_at: _updated,
                  ...patch
                } = draft;
                await agyApi("/settings", {
                  method: "PUT",
                  body: requestBody({ ...patch, expected_revision: revision }),
                });
                setSettingsOpen(false);
              });
            }}
          >
            <h3>账号管理配置</h3>
            {draft ? (
              <>
                <label className="agy-form-label">
                  目标模型
                  <input
                    className="agy-form-input"
                    required
                    value={draft.standalone_model_id ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        standalone_model_id: e.target.value,
                      })
                    }
                  />
                </label>
                <p>
                  填写官方 AGY 的模型标识。服务器只接受已核实的模型额度池映射。
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.workflow_auto_switch}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        workflow_auto_switch: e.target.checked,
                      })
                    }
                  />
                  受管工作流自动切号
                </label>
                <label style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={draft.pause_managed_for_manual_switch}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        pause_managed_for_manual_switch: e.target.checked,
                      })
                    }
                  />
                  允许手动切号暂停受管 AGY 任务并按原策略恢复
                </label>
                {(
                  [
                    ["timezone", "时区"],
                    ["local_report_time", "日间本地报告时间"],
                    ["night_start", "夜间开始"],
                    ["night_end", "夜间结束"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="agy-form-label">
                    {label}
                    <input
                      className="agy-form-input"
                      value={draft.maintenance[key]}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          maintenance: {
                            ...draft.maintenance,
                            [key]: e.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ))}
                <label className="agy-form-label">
                  刷新验证最长间隔（小时）
                  <input
                    className="agy-form-input"
                    type="number"
                    min={1}
                    value={draft.maintenance.refresh_verified_max_age_hours}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maintenance: {
                          ...draft.maintenance,
                          refresh_verified_max_age_hours: Number(
                            e.target.value,
                          ),
                        },
                      })
                    }
                  />
                </label>
              </>
            ) : (
              <p>配置尚未加载，请稍后重试。</p>
            )}
            <div className="agy-header-actions">
              <button
                type="button"
                className="agy-btn"
                onClick={() => setSettingsOpen(false)}
              >
                关闭
              </button>
              <button
                className="agy-btn agy-btn-primary"
                disabled={busy || !draft}
              >
                保存配置
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </form>
        </div>
      )}
      <AgyAccountEnrollment
        isOpen={enrollOpen}
        realmRevision={service?.revision ?? 0}
        onClose={() => setEnrollOpen(false)}
        onOperation={accepted}
      />
      <AgyMaintenancePanel
        isOpen={maintOpen}
        realmRevision={service?.revision ?? 0}
        canOperate={canOperate}
        onClose={() => setMaintOpen(false)}
        onOperation={accepted}
      />
    </div>
  );
}
