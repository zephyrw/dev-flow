import React, { useState, useEffect } from "react";
import type { ArchivedWorkflowSummary } from "../../../../packages/contracts/src/workflow-visibility.js";

export interface ArchivedWorkflowsPanelProps {
  onSelectWorkflow: (workflowId: string) => void;
  onWorkflowRestored?: (workflowId: string) => void;
}

export function ArchivedWorkflowsPanel({
  onSelectWorkflow,
  onWorkflowRestored,
}: ArchivedWorkflowsPanelProps) {
  const [items, setItems] = useState<ArchivedWorkflowSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProject, setSelectedProject] = useState("");
  const [operatingId, setOperatingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchArchives = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (selectedProject) params.set("project_id", selectedProject);
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      params.set("limit", "100");

      const res = await fetch(`/api/archives?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`获取归档列表失败: ${res.statusText}`);
      }
      const data = await res.json();
      setItems(data.items || []);
    } catch (err: any) {
      setError(err?.message || "网络请求失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchArchives();
    }, 200);
    return () => clearTimeout(timer);
  }, [searchQuery, selectedProject]);

  const handleRestore = async (item: ArchivedWorkflowSummary) => {
    setOperatingId(item.workflow_id);
    try {
      // 1. 获取当前最新 visibility revision
      const visRes = await fetch(`/api/workflows/${item.workflow_id}/visibility`);
      const visData = await visRes.json();
      const currentRev = visData.visibility?.revision ?? item.visibility_revision;

      // 2. 发起恢复请求
      const updateRes = await fetch(
        `/api/workflows/${item.workflow_id}/visibility`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: crypto.randomUUID(),
            expected_visibility_revision: currentRev,
            archived: false,
          }),
        },
      );

      if (!updateRes.ok) {
        const errJson = await updateRes.json().catch(() => ({}));
        throw new Error(errJson.message || `恢复失败 (${updateRes.status})`);
      }

      onWorkflowRestored?.(item.workflow_id);
      await fetchArchives();
    } catch (err: any) {
      alert(`恢复任务失败: ${err?.message}`);
    } finally {
      setOperatingId(null);
    }
  };

  // 提取全部出现过的项目 ID
  const projectList = Array.from(new Set(items.map((i) => i.project_id))).filter(
    Boolean,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px", minHeight: "360px" }}>
      {/* 搜索与过滤工具栏 */}
      <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
        <input
          type="text"
          placeholder="搜索任务标题或 ID..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: "6px",
            border: "1px solid var(--color-border, #cbd5e1)",
            fontSize: "13px",
          }}
        />
        {projectList.length > 0 && (
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              border: "1px solid var(--color-border, #cbd5e1)",
              fontSize: "13px",
              background: "white",
            }}
          >
            <option value="">全部项目</option>
            {projectList.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 列表主体 */}
      {loading && items.length === 0 && (
        <div style={{ textAlign: "center", padding: "40px", color: "var(--color-text-muted, #94a3b8)" }}>
          正在加载归档任务...
        </div>
      )}

      {error && (
        <div
          style={{
            padding: "10px 14px",
            background: "#fef2f2",
            color: "#b91c1c",
            borderRadius: "6px",
            border: "1px solid #fecaca",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "50px 20px",
            color: "var(--color-text-muted, #94a3b8)",
            fontSize: "14px",
          }}
        >
          {searchQuery || selectedProject ? "没有匹配的归档任务" : "暂无归档任务"}
        </div>
      )}

      {items.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            maxHeight: "440px",
            overflowY: "auto",
          }}
        >
          {items.map((item) => {
            const isExpanded = expandedId === item.workflow_id;
            return (
              <div
                key={item.workflow_id}
                style={{
                  border: "1px solid var(--color-border, #e2e8f0)",
                  borderRadius: "6px",
                  background: "var(--color-bg-secondary, #f8fafc)",
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, overflow: "hidden" }}>
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: "13px",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={item.title}
                    >
                      {item.title}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        padding: "2px 6px",
                        borderRadius: "4px",
                        background: "#e2e8f0",
                        color: "#475569",
                      }}
                    >
                      {item.project_id}
                    </span>
                    {item.is_running && (
                      <span
                        style={{
                          fontSize: "11px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "#fee2e2",
                          color: "#ef4444",
                          fontWeight: 500,
                        }}
                      >
                        ⚡ 后台运行中
                      </span>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: "12px", padding: "4px 8px" }}
                      onClick={() => onSelectWorkflow(item.workflow_id)}
                      title="打开并在工作台查看详情"
                    >
                      查看
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: "12px", padding: "4px 8px" }}
                      disabled={operatingId === item.workflow_id}
                      onClick={() => handleRestore(item)}
                    >
                      {operatingId === item.workflow_id ? "恢复中..." : "恢复"}
                    </button>
                    <button
                      type="button"
                      style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "12px",
                        color: "#64748b",
                        padding: "2px 4px",
                      }}
                      onClick={() =>
                        setExpandedId(isExpanded ? null : item.workflow_id)
                      }
                      title="展开/收起详情"
                    >
                      {isExpanded ? "▲" : "▼"}
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "12px",
                    color: "var(--color-text-muted, #94a3b8)",
                  }}
                >
                  <span>当前状态：{item.current_state}</span>
                  {item.archived_at && (
                    <span>
                      归档于：{new Date(item.archived_at).toLocaleString("zh-CN")}
                    </span>
                  )}
                </div>

                {isExpanded && (
                  <div
                    style={{
                      marginTop: "6px",
                      paddingTop: "6px",
                      borderTop: "1px dashed #cbd5e1",
                      fontSize: "12px",
                      color: "#475569",
                      lineHeight: "1.6",
                    }}
                  >
                    <div><strong>ID：</strong><code>{item.workflow_id}</code></div>
                    {item.branch && <div><strong>分支：</strong><code>{item.branch}</code></div>}
                    {item.plan_revision !== undefined && (
                      <div><strong>计划修订版本：</strong>v{item.plan_revision}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
