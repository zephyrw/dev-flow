import React, { useState, useEffect, useRef } from "react";
import {
  agyApi,
  requestBody,
  operationLabels,
  type AccountOperationView,
} from "./agy-api.js";

interface Props {
  isOpen: boolean;
  realmRevision: number;
  onClose: () => void;
  onOperation: (op: AccountOperationView) => void;
}

const FRIENDLY_ERRORS: Record<string, string> = {
  agy_cli_not_configured: "未找到 AGY CLI，请检查安装或可执行文件位置",
  interactive_login_capability_unverified:
    "当前环境未开启官方 AGY 交互登录窗口支持，请选择“导入本机当前活动账号”直接导入",
  credential_worker_not_built: "账号安全凭据组件未正确构建或安装",
  external_change: "检测到外部 AGY 会话正在修改凭据，请稍后重试",
  managed_processes_not_stopped: "相关进程尚未完全退出，为保护账号已暂停本次操作",
  network_failed: "无法连接官方服务查询额度，但账号授权凭据已安全保存",
  quota_capability_unavailable: "暂未获取到周额度或五小时额度数据，账号已保存",
  account_identity_unverified: "未能识别当前登录账号的邮箱身份，请确认本机已登录 Antigravity",
  active_credential_missing: "未检测到本机已登录的 Antigravity 账号凭据，请先在客户端完成登录",
  account_identity_mismatch: "当前登录的账号与目标账号邮箱不一致",
  operation_in_progress: "当前已有另一项账号操作正在进行中，请稍候",
};

function formatFriendlyError(raw: string): string {
  if (!raw) return "";
  if (FRIENDLY_ERRORS[raw]) return FRIENDLY_ERRORS[raw];
  if (raw.includes("CLIXML") || raw.includes("GetOwnerSid")) {
    return "系统进程状态检查受限，请直接选用“导入本机当前活动账号”";
  }
  return raw;
}

export function AgyAccountEnrollment({
  isOpen,
  realmRevision,
  onClose,
  onOperation,
}: Props) {
  const [alias, setAlias] = useState("");
  const [mode, setMode] = useState<"capture_current" | "login">("capture_current");
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [currentOp, setCurrentOp] = useState<AccountOperationView | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setCurrentOp(null);
      setError("");
      setSubmitting(false);
      setCancelling(false);
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    }
  }, [isOpen]);

  useEffect(() => {
    if (!currentOp || ["completed", "failed", "cancelled", "blocked"].includes(currentOp.phase)) {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      return;
    }

    async function poll() {
      if (!currentOp) return;
      try {
        const updated = await agyApi<AccountOperationView>(
          `/operations/${currentOp.operation_id}`,
        );
        setCurrentOp(updated);
        onOperation(updated);
      } catch {
        // 忽略单次网络轮询抖动
      }
    }

    const immediateTimer = setTimeout(poll, 200);
    pollTimerRef.current = setInterval(poll, 500);
    return () => {
      clearTimeout(immediateTimer);
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [currentOp, onOperation]);

  if (!isOpen) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
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
      setCurrentOp(op);
      onOperation(op);
    } catch (e: any) {
      const code = e instanceof Error ? e.message : String(e);
      setError(formatFriendlyError(code));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCancel() {
    if (!currentOp) return;
    setCancelling(true);
    try {
      const cancelled = await agyApi<AccountOperationView>(
        `/operations/${currentOp.operation_id}/cancel`,
        {
          method: "POST",
          body: requestBody({
            expected_revision: currentOp.revision,
          }),
        },
      );
      setCurrentOp(cancelled);
      onOperation(cancelled);
    } catch (err: any) {
      setError(formatFriendlyError(err?.message || "取消操作失败"));
    } finally {
      setCancelling(false);
    }
  }

  function getStepIndex(phase: string): number {
    if (["pending", "queued", "started", "quiescing", "capturing", "login_intent", "login_waiting"].includes(phase)) {
      return 1;
    }
    if (["prepared", "captured_pending", "verifying", "enrollment_saved"].includes(phase)) {
      return 2;
    }
    if (["committing", "committed", "completing", "completed"].includes(phase)) {
      return 3;
    }
    return 1;
  }

  function renderWizardProgress() {
    if (!currentOp) return null;
    const phase = currentOp.phase;
    const label = operationLabels[phase] || "正在处理";
    const opError = currentOp.error ? formatFriendlyError(currentOp.error) : "";
    const step = getStepIndex(phase);

    if (phase === "completed") {
      return (
        <div className="agy-wizard-container">
          <div className="agy-wizard-result-card is-success">
            <div className="agy-wizard-result-icon success">✓</div>
            <div className="agy-wizard-result-body">
              <h4>账号导入成功</h4>
              <p>已成功读取本地安全凭据并完成官方双额度核验，账号现已加入受管列表。</p>
            </div>
          </div>
          <div className="agy-modal-footer">
            <button
              type="button"
              className="agy-primary-btn"
              onClick={onClose}
            >
              完成
            </button>
          </div>
        </div>
      );
    }

    if (phase === "failed" || phase === "cancelled" || phase === "blocked") {
      return (
        <div className="agy-wizard-container">
          <div className="agy-wizard-result-card is-error">
            <div className="agy-wizard-result-icon error">!</div>
            <div className="agy-wizard-result-body">
              <h4>{phase === "cancelled" ? "操作已取消" : "账号添加未完成"}</h4>
              <p>{opError || (phase === "cancelled" ? "您已取消本次账号添加操作。" : "未能完成账号凭据核验，请检查登录状态后重试。")}</p>
            </div>
          </div>
          <div className="agy-modal-footer">
            <button
              type="button"
              className="agy-secondary-btn"
              onClick={() => {
                setCurrentOp(null);
                setError("");
              }}
            >
              返回重选
            </button>
            <button
              type="button"
              className="agy-primary-btn"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="agy-wizard-container">
        <div className="agy-wizard-progress-card">
          <div className="agy-wizard-progress-header">
            <span className="agy-wizard-spinner" />
            <div className="agy-wizard-progress-title">
              <h4>{label}</h4>
              <span>
                {mode === "capture_current"
                  ? "正在提取系统当前登录凭据并同步额度，请稍候…"
                  : "请在弹出的 Antigravity 窗口中完成官方登录授权…"}
              </span>
            </div>
          </div>

          <div className="agy-wizard-steps">
            <div className={`agy-wizard-step ${step >= 1 ? "is-active" : ""} ${step > 1 ? "is-done" : ""}`}>
              <span className="agy-wizard-step-dot">{step > 1 ? "✓" : "1"}</span>
              <span className="agy-wizard-step-text">读取安全凭据</span>
            </div>
            <div className="agy-wizard-step-line" />
            <div className={`agy-wizard-step ${step >= 2 ? "is-active" : ""} ${step > 2 ? "is-done" : ""}`}>
              <span className="agy-wizard-step-dot">{step > 2 ? "✓" : "2"}</span>
              <span className="agy-wizard-step-text">核验身份与额度</span>
            </div>
            <div className="agy-wizard-step-line" />
            <div className={`agy-wizard-step ${step >= 3 ? "is-active" : ""}`}>
              <span className="agy-wizard-step-dot">3</span>
              <span className="agy-wizard-step-text">保存至账号池</span>
            </div>
          </div>
        </div>

        <div className="agy-modal-footer">
          <button
            type="button"
            className="agy-secondary-btn"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? "正在取消…" : "取消操作"}
          </button>
        </div>
      </div>
    );
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

        {currentOp ? (
          renderWizardProgress()
        ) : (
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
                disabled={submitting}
              />
            </div>

            <div className="agy-form-item">
              <label className="agy-form-label">添加方式</label>
              <div className="agy-radio-group">
                <label
                  className={`agy-radio-card ${mode === "login" ? "is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="enroll-mode"
                    value="login"
                    checked={mode === "login"}
                    onChange={() => setMode("login")}
                    disabled={submitting}
                  />
                  <div className="agy-radio-meta">
                    <strong>打开官方登录页面</strong>
                    <span>弹出 Antigravity 官方窗口完成账号授权</span>
                  </div>
                </label>

                <label
                  className={`agy-radio-card ${mode === "capture_current" ? "is-selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="enroll-mode"
                    value="capture_current"
                    checked={mode === "capture_current"}
                    onChange={() => setMode("capture_current")}
                    disabled={submitting}
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
                disabled={submitting}
              >
                取消
              </button>
              <button
                type="submit"
                className="agy-primary-btn"
                disabled={submitting}
              >
                {submitting ? "正在受理…" : "开始添加"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
