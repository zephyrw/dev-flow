import React, { useEffect, useState, useCallback } from "react";

export interface RecoveryDto {
  recovery_id: string;
  workflow_id: string;
  manifest_id: string;
  source_run_id: string;
  target_run_id: string | null;
  logical_work_id: string;
  decision: string;
  state: string;
  reason: string | null;
  revision: number;
  budget: {
    execution_budget_ms: number;
    consumed_ms: number;
    remaining_ms: number;
  } | null;
  workspace_complete: boolean;
  delivery_id: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export function AgyRecoveryPanel({
  workflowId,
  onRefresh,
}: {
  workflowId: string;
  onRefresh?: () => Promise<void> | void;
}) {
  const [recoveries, setRecoveries] = useState<RecoveryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchRecoveries = useCallback(async () => {
    if (!workflowId) return;
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/workflows/${workflowId}/agy-recoveries`);
      if (res.ok) {
        const data = await res.json();
        setRecoveries(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void fetchRecoveries();
    const timer = setInterval(() => {
      void fetchRecoveries();
    }, 15000);
    return () => clearInterval(timer);
  }, [fetchRecoveries]);

  const handleCancel = async (item: RecoveryDto) => {
    setCancellingId(item.recovery_id);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/${workflowId}/agy-recoveries/${item.recovery_id}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            expected_revision: item.revision,
          }),
        },
      );
      if (res.status === 409) {
        // 版本冲突，刷新本地状态
        await fetchRecoveries();
        return;
      }
      if (!res.ok && res.status !== 202) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message ?? `取消请求失败 (${res.status})`);
      }
      await fetchRecoveries();
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancellingId(null);
    }
  };

  if (!recoveries.length && !loading && !error) {
    return null;
  }

  const formatBudget = (ms?: number) => {
    if (ms === undefined || ms === null) return "未限制";
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  };

  return (
    <div
      className="agy-recovery-panel"
      style={{
        margin: "12px 0",
        padding: "12px",
        border: "1px solid #e0e0e0",
        borderRadius: "6px",
        backgroundColor: "#fafafa",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h4 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>账号切换恢复管理</h4>
        <button
          onClick={() => void fetchRecoveries()}
          disabled={loading}
          style={{ fontSize: "12px", padding: "2px 8px" }}
        >
          {loading ? "刷新中..." : "刷新"}
        </button>
      </div>

      {error && (
        <div style={{ color: "#d32f2f", fontSize: "12px", marginBottom: "8px" }}>
          提示：{error}
        </div>
      )}

      {recoveries.map((item) => {
        const isActive =
          !["completed", "superseded", "manual_required"].includes(item.state);

        return (
          <div
            key={item.recovery_id}
            style={{
              padding: "8px",
              marginBottom: "8px",
              backgroundColor: "#fff",
              border: "1px solid #ddd",
              borderRadius: "4px",
              fontSize: "12px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <strong>恢复编号:</strong> {item.recovery_id}
                <span style={{ marginLeft: "8px", color: "#666" }}>
                  (目标: {item.target_run_id ?? "待安排"})
                </span>
              </div>
              <span
                style={{
                  padding: "2px 6px",
                  borderRadius: "3px",
                  backgroundColor: isActive ? "#e3f2fd" : "#eee",
                  color: isActive ? "#1565c0" : "#666",
                  fontWeight: 500,
                }}
              >
                {item.state}
              </span>
            </div>

            <div style={{ marginTop: "4px", color: "#555" }}>
              <div>决策类型: {item.decision} · 源运行: {item.source_run_id}</div>
              <div>
                剩余预算: {formatBudget(item.budget?.remaining_ms)} · 工作区材料:{" "}
                {item.workspace_complete ? "完整" : "缺失/不完整"}
              </div>
              {item.reason && <div>原因: {item.reason}</div>}
            </div>

            {isActive && (
              <div style={{ marginTop: "6px", textAlign: "right" }}>
                <button
                  onClick={() => void handleCancel(item)}
                  disabled={cancellingId === item.recovery_id}
                  style={{
                    backgroundColor: "#ffebee",
                    color: "#c62828",
                    border: "1px solid #ef9a9a",
                    borderRadius: "3px",
                    padding: "2px 8px",
                    cursor: "pointer",
                  }}
                >
                  {cancellingId === item.recovery_id ? "取消中..." : "取消此恢复目标"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
