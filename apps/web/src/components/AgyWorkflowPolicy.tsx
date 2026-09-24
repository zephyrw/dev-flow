import React, { useEffect, useState } from "react";
import type {
  AgyAccountDto,
  AgyAccountPolicy,
} from "../../../../packages/contracts/src/agy-account.js";
import { agyApi, requestBody } from "./agy-api.js";
export function AgyWorkflowPolicy({ workflowId }: { workflowId: string }) {
  const [policy, setPolicy] = useState<AgyAccountPolicy | null>(null);
  const [accounts, setAccounts] = useState<AgyAccountDto[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/workflows/${encodeURIComponent(workflowId)}/agy-account-policy`;
  async function read() {
    const response = await fetch(endpoint);
    const value = await response.json();
    if (!response.ok)
      throw new Error(value.error?.message ?? "读取账号策略失败");
    setPolicy(value);
  }
  useEffect(() => {
    let current = true;
    setPolicy(null);
    setError("");
    setNotice("");
    void Promise.all([
      fetch(endpoint).then(async (response) => {
        const value = await response.json();
        if (!response.ok)
          throw new Error(value.error?.message ?? "读取账号策略失败");
        return value;
      }),
      agyApi<{ accounts: AgyAccountDto[] }>(""),
    ])
      .then(([next, view]) => {
        if (current) {
          setPolicy(next);
          setAccounts(view.accounts);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [endpoint]);
  async function save() {
    if (!policy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: requestBody({
          expected_revision: policy.revision,
          auto_switch: policy.auto_switch,
          allowed_account_ids: policy.allowed_account_ids,
          recreation_policy: policy.recreation_policy,
          night_pool: policy.night_pool,
        }),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error?.message ?? "保存账号策略失败");
      setPolicy(value);
      setNotice("账号策略已保存，仅对后续执行生效；当前运行使用原冻结策略。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="任务 AGY 账号策略">
      <h4>任务 AGY 账号策略</h4>
      <p>
        共享身份切换可能暂时中断其他受管 AGY
        工作。账号变化不修改任务模型或思考强度。
      </p>
      {error && (
        <p role="alert">
          {error}
          <button onClick={() => void read().catch((e) => setError(e.message))}>
            重新读取策略
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {policy && (
        <>
          <label>
            额度错误自动切号
            <select
              value={
                policy.auto_switch === null
                  ? "inherit"
                  : String(policy.auto_switch)
              }
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  auto_switch:
                    e.target.value === "inherit"
                      ? null
                      : e.target.value === "true",
                })
              }
            >
              <option value="inherit">继承账号管理设置</option>
              <option value="true">启用</option>
              <option value="false">关闭</option>
            </select>
          </label>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={policy.allowed_account_ids === null}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  allowed_account_ids: e.target.checked ? null : [],
                })
              }
            />
            允许所有已启用且合格账号
          </label>
          {policy.allowed_account_ids !== null && (
            <fieldset>
              <legend>允许的账号（空集合表示不允许任何账号）</legend>
              {accounts.map((account) => (
                <label key={account.id} style={{ display: "block" }}>
                  <input
                    type="checkbox"
                    checked={policy.allowed_account_ids!.includes(account.id)}
                    onChange={(e) =>
                      setPolicy({
                        ...policy,
                        allowed_account_ids: e.target.checked
                          ? [...policy.allowed_account_ids!, account.id]
                          : policy.allowed_account_ids!.filter(
                              (id) => id !== account.id,
                            ),
                      })
                    }
                  />
                  {account.identity.email}
                </label>
              ))}
            </fieldset>
          )}
          <label>
            原会话不可用时
            <select
              value={policy.recreation_policy}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  recreation_policy: e.target
                    .value as AgyAccountPolicy["recreation_policy"],
                })
              }
            >
              <option value="exact_only">暂停，保持原会话</option>
              <option value="recreate_after_confirmed_unavailable" disabled>
                建立接替会话（能力待验证，当前不可用）
              </option>
            </select>
          </label>
          <p>原会话不可用时，本版本暂停等待处理；已有接替策略仅保留配置意图。</p>
          <label style={{ display: "block" }}>
            夜间候选
            <select
              value={policy.night_pool}
              onChange={(e) =>
                setPolicy({
                  ...policy,
                  night_pool: e.target.value as AgyAccountPolicy["night_pool"],
                })
              }
            >
              <option value="normal">正常策略</option>
              <option value="strict">仅近期实际验证过自动刷新的账号</option>
            </select>
          </label>
          <button disabled={busy} onClick={() => void save()}>
            保存账号策略
          </button>
        </>
      )}
    </section>
  );
}
