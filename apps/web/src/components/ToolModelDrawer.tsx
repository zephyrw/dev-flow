import React, { useState, useEffect } from "react";

export interface ToolModelDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string;
  workflowState?: string;
  onSpecUpdated?: () => void;
}

const SUPPORTED_TOOLS = [
  { id: "codex", label: "Codex (原生 CLI)" },
  { id: "agy", label: "Antigravity (原生 CLI)" },
  { id: "grok-build", label: "Grok Build (原生 CLI)" },
  { id: "claude-code", label: "Claude Code (原生 CLI)" },
  { id: "kimi-code", label: "Kimi Code (原生 CLI)" },
  { id: "qoder", label: "Qoder (原生 CLI)" },
  { id: "opencode", label: "OpenCode (原生 CLI)" },
  { id: "cursor-agent", label: "Cursor Agent (原生 CLI)" },
];

export function ToolModelDrawer({
  isOpen,
  onClose,
  workflowId,
  workflowState,
  onSpecUpdated,
}: ToolModelDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [currentSpec, setCurrentSpec] = useState<any>(null);

  const [plannerAdapter, setPlannerAdapter] = useState("codex");
  const [executorAdapter, setExecutorAdapter] = useState("codex");
  const [safeInterrupt, setSafeInterrupt] = useState(true);

  const isActive = ["EXECUTING", "VERIFYING", "QUEUED", "REVIEWING", "REVIEW_QUEUED"].includes(
    workflowState ?? "",
  );

  useEffect(() => {
    if (!isOpen || !workflowId) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    fetch(`/api/workflows/${workflowId}`)
      .then((res) => {
        if (!res.ok) throw new Error("读取任务信息失败");
        return res.json();
      })
      .then((data) => {
        const spec = data.spec || data.execution_spec;
        if (spec) {
          setCurrentSpec(spec);
          if (spec.plannerProfile?.adapterId) {
            setPlannerAdapter(spec.plannerProfile.adapterId);
          }
          if (spec.executorProfile?.adapterId) {
            setExecutorAdapter(spec.executorProfile.adapterId);
          }
        }
      })
      .catch((err) => {
        setError(err.message ?? String(err));
      })
      .finally(() => setLoading(false));
  }, [isOpen, workflowId]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const resp = await fetch(`/api/workflows/${workflowId}/execution-spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: `req_spec_${Date.now()}`,
          planner_profile: {
            id: `profile-${plannerAdapter}`,
            revision: 1,
            adapterId: plannerAdapter,
            modelSelection: "native-config",
            options: {},
          },
          executor_profile: {
            id: `profile-${executorAdapter}`,
            revision: 1,
            adapterId: executorAdapter,
            modelSelection: "native-config",
            options: {},
          },
          interrupt_requested: isActive && safeInterrupt,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.message || data.error?.message || `更新失败 (HTTP ${resp.status})`);
      }
      setSuccess("工具配置已安全更新并冻结新版本！");
      setCurrentSpec(data.spec);
      if (onSpecUpdated) onSpecUpdated();
    } catch (err: any) {
      setError(err.message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="drawer-backdrop"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.4)",
        zIndex: 1500,
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={onClose}
    >
      <div
        className="drawer-content"
        style={{
          width: "420px",
          maxWidth: "90vw",
          height: "100%",
          background: "var(--color-canvas, #ffffff)",
          boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          padding: "24px",
          boxSizing: "border-box",
          gap: "16px",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>工具与模型配置</h3>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              cursor: "pointer",
              color: "var(--color-fg-muted, #666)",
            }}
          >
            ✕
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              background: "#ffebe9",
              color: "#cf222e",
              borderRadius: "6px",
              fontSize: "13px",
            }}
          >
            {error}
          </div>
        )}

        {success && (
          <div
            style={{
              padding: "8px 12px",
              background: "#dafbe1",
              color: "#1a7f37",
              borderRadius: "6px",
              fontSize: "13px",
            }}
          >
            {success}
          </div>
        )}

        {loading ? (
          <div style={{ padding: "20px 0", color: "#666", fontSize: "13px" }}>正在读取规格...</div>
        ) : (
          <>
            {currentSpec && (
              <div
                style={{
                  background: "var(--color-canvas-subtle, #f6f8fa)",
                  padding: "12px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <div><strong>配置版本：</strong>v{currentSpec.revision ?? 1}</div>
                <div><strong>执行模式：</strong>{currentSpec.mode ?? "single_tool"}</div>
                <div><strong>规划工具：</strong>{currentSpec.plannerProfile?.adapterId ?? "未指定"}</div>
                <div><strong>实施工具：</strong>{currentSpec.executorProfile?.adapterId ?? "未指定"}</div>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 500 }}>规划模型 / 适配器</label>
              <select
                value={plannerAdapter}
                onChange={(e) => setPlannerAdapter(e.target.value)}
                style={{
                  padding: "8px",
                  borderRadius: "6px",
                  border: "1px solid var(--color-border-default, #d0d7de)",
                  fontSize: "13px",
                }}
              >
                {SUPPORTED_TOOLS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <label style={{ fontSize: "13px", fontWeight: 500 }}>实施模型 / 适配器</label>
              <select
                value={executorAdapter}
                onChange={(e) => setExecutorAdapter(e.target.value)}
                style={{
                  padding: "8px",
                  borderRadius: "6px",
                  border: "1px solid var(--color-border-default, #d0d7de)",
                  fontSize: "13px",
                }}
              >
                {SUPPORTED_TOOLS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            {isActive && (
              <div
                style={{
                  background: "#fff8c5",
                  padding: "10px",
                  borderRadius: "6px",
                  fontSize: "12px",
                  color: "#9a6700",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div>当前任务正在运行中。根据规范，活动 Run 的配置不可被原地篡改。</div>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={safeInterrupt}
                    onChange={(e) => setSafeInterrupt(e.target.checked)}
                  />
                  <span>完成可审计安全暂停后再应用新规格</span>
                </label>
              </div>
            )}

            <div style={{ marginTop: "auto", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                onClick={onClose}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid var(--color-border-default, #d0d7de)",
                  background: "transparent",
                  cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  padding: "6px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "var(--color-btn-primary-bg, #1f883d)",
                  color: "#fff",
                  fontWeight: 500,
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                {saving ? "正在更新..." : "应用新配置"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
