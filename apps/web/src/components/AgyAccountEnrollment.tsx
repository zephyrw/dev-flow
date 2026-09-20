import React, { useState } from "react";
import { agyApi, requestBody, type AccountOperationView } from "./agy-api.js";
interface Props {
  isOpen: boolean;
  realmRevision: number;
  onClose: () => void;
  onOperation: (op: AccountOperationView) => void;
}
export function AgyAccountEnrollment({
  isOpen,
  realmRevision,
  onClose,
  onOperation,
}: Props) {
  const [alias, setAlias] = useState("");
  const [mode, setMode] = useState("capture_current");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  if (!isOpen) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const op = await agyApi<AccountOperationView>("/enroll", {
        method: "POST",
        body: requestBody({
          alias,
          mode,
          expected_realm_revision: realmRevision,
        }),
      });
      onOperation(op);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="agy-modal-overlay">
      <form className="agy-modal" onSubmit={submit} aria-label="录入账号">
        <h3>录入 AGY 账号</h3>
        {error && <p role="alert">{error}</p>}
        <label className="agy-form-label">
          账号别名
          <input
            className="agy-form-input"
            value={alias}
            maxLength={100}
            onChange={(e) => setAlias(e.target.value)}
          />
        </label>
        <label>
          <input
            type="radio"
            name="enroll-mode"
            checked={mode === "capture_current"}
            onChange={() => setMode("capture_current")}
          />
          导入当前已登录账号
        </label>
        <label>
          <input
            type="radio"
            name="enroll-mode"
            checked={mode === "login"}
            onChange={() => setMode("login")}
          />
          启动官方新登录
        </label>
        <p>
          只在官方窗口输入密码和设备验证。录入提交后可以在操作进度中取消；关闭页面不会取消后台操作。
        </p>
        <div className="agy-header-actions">
          <button type="button" className="agy-btn" onClick={onClose}>
            关闭
          </button>
          <button className="agy-btn agy-btn-primary" disabled={loading}>
            提交录入
          </button>
        </div>
      </form>
    </div>
  );
}
