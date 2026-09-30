import React, { useEffect, useState } from "react";
import { agyApi, requestBody, type AccountOperationView } from "./agy-api.js";
interface Entry {
  id: string;
  alias: string;
  email?: string;
  expires_at?: string;
  weekly_remaining?: number | null;
  reason?: string;
}
interface Report {
  generated_at: string;
  evaluation_time?: string;
  evaluated_night_start?: string;
  evaluated_night_end?: string;
  reauth_required_accounts: Entry[];
  expiring_refresh_accounts: Entry[];
  unverified_refresh_accounts: Entry[];
  unknown_refresh_expiry_accounts: Entry[];
  pending_quota_accounts: Entry[];
  night_candidates: Entry[];
  excluded_from_night: Entry[];
}
interface Props {
  isOpen: boolean;
  realmRevision: number;
  canOperate: boolean;
  onClose: () => void;
  onOperation: (op: AccountOperationView) => void;
}
export function AgyMaintenancePanel({
  isOpen,
  realmRevision,
  canOperate,
  onClose,
  onOperation,
}: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (isOpen) {
      setError("");
      void agyApi<Report>("/maintenance")
        .then((r) => {
          setReport(r);
          setSelected([]);
        })
        .catch((e) => setError(e.message));
    }
  }, [isOpen]);
  if (!isOpen) return null;
  async function check() {
    setBusy(true);
    setError("");
    try {
      onOperation(
        await agyApi<AccountOperationView>("/maintenance", {
          method: "POST",
          body: requestBody({
            expected_realm_revision: realmRevision,
            selected_account_ids: selected,
          }),
        }),
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const groups: Array<[string, keyof Omit<Report, "generated_at" | "evaluation_time" | "evaluated_night_start" | "evaluated_night_end">]> = [
    ["需重新认证", "reauth_required_accounts"],
    ["授权将在夜间结束前到期", "expiring_refresh_accounts"],
    ["授权有效期未知", "unknown_refresh_expiry_accounts"],
    ["授权待核验", "unverified_refresh_accounts"],
    ["双额度待补测", "pending_quota_accounts"],
    ["今晚可用候选", "night_candidates"],
    ["夜间排除原因", "excluded_from_night"],
  ];
  const all = report
    ? Array.from(
        new Map(
          groups.flatMap(([, key]) => report[key] ?? []).map((e) => [e.id, e]),
        ).values(),
      )
    : [];
  return (
    <div className="agy-modal-overlay">
      <div className="agy-modal" role="dialog" aria-label="日间维护">
        <h3>日间维护与夜间准备</h3>
        {error && <p role="alert">{error}</p>}
        {report && (
          <>
            <p>
              报告生成时间：{new Date(report.generated_at).toLocaleString()}
            </p>
            {groups.filter(([, key]) => report[key].length > 0).map(([label, key]) => (
              <section key={key}>
                <h4>{label}</h4>
                {report[key].length ? (
                  report[key].map((e) => (
                    <div key={e.id}>
                      {e.email || e.alias}
                      {e.expires_at &&
                        ` · ${new Date(e.expires_at).toLocaleString()}`}
                      {e.reason && ` · ${e.reason}`}
                      {e.weekly_remaining != null &&
                        ` · 周余额 ${Math.round(e.weekly_remaining * 100)}%`}
                    </div>
                  ))
                ) : (
                  <p>无</p>
                )}
              </section>
            ))}
          </>
        )}
        <fieldset>
          <legend>选择需要核验的账号</legend>
          {all.map((e) => (
            <label key={e.id} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={selected.includes(e.id)}
                onChange={(ev) =>
                  setSelected((ids) =>
                    ev.target.checked
                      ? [...ids, e.id]
                      : ids.filter((id) => id !== e.id),
                  )
                }
              />
              {e.email || e.alias}
            </label>
          ))}
        </fieldset>
        <p>
          核验将切换账号，结束后恢复原账号。可在操作进度中取消。
        </p>
        <div className="agy-header-actions">
          <button className="agy-btn" onClick={onClose}>
            关闭
          </button>
          <button
            className="agy-btn agy-btn-primary"
            disabled={busy || !canOperate || !selected.length}
            onClick={() => void check()}
          >
            核验所选账号
          </button>
        </div>
      </div>
    </div>
  );
}
