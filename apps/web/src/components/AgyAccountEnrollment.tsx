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
  const [mode, setMode] = useState<"capture_current" | "login">("login");
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
          alias: alias.trim(),
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
    <div className="agy-modal-overlay" onClick={onClose}>
      <div
        className="agy-modal-content"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="添加 AGY 管理账号"
      >
        <div className="agy-modal-header">
          <h3>添加 AGY 管理账号</h3>
          <button type="button" className="agy-modal-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="agy-enroll-form">
          {error && (
            <div className="agy-alert-error" role="alert">
              <span>{error}</span>
            </div>
          )}

          <div className="agy-form-item">
            <label className="agy-form-label" htmlFor="agy-alias-input">
              账号别名（可选）
            </label>
            <input
              id="agy-alias-input"
              className="agy-form-input"
              value={alias}
              maxLength={100}
              placeholder="例如：主账号 / 团队账号"
              onChange={(e) => setAlias(e.target.value)}
              disabled={loading}
            />
          </div>

          <div className="agy-form-item">
            <label className="agy-form-label">添加方式</label>
            <div className="agy-radio-group">
              <label className={`agy-radio-card ${mode === "login" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="enroll-mode"
                  value="login"
                  checked={mode === "login"}
                  onChange={() => setMode("login")}
                  disabled={loading}
                />
                <div className="agy-radio-meta">
                  <strong>打开官方登录页面</strong>
                  <span>弹出 Antigravity 官方窗口完成账号授权</span>
                </div>
              </label>

              <label className={`agy-radio-card ${mode === "capture_current" ? "is-selected" : ""}`}>
                <input
                  type="radio"
                  name="enroll-mode"
                  value="capture_current"
                  checked={mode === "capture_current"}
                  onChange={() => setMode("capture_current")}
                  disabled={loading}
                />
                <div className="agy-radio-meta">
                  <strong>导入本机当前活动账号</strong>
                  <span>直接保存系统当前已登录的凭据作为管理账号</span>
                </div>
              </label>
            </div>
          </div>

          <div className="agy-modal-footer">
            <button
              type="button"
              className="agy-secondary-btn"
              onClick={onClose}
              disabled={loading}
            >
              取消
            </button>
            <button
              type="submit"
              className="agy-primary-btn"
              disabled={loading}
            >
              {loading ? "正在处理…" : "开始添加"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
