import React, { useState } from "react";
import {
  RequirementComposer,
  type ReferenceItem,
} from "./RequirementComposer.js";

export interface CreateWorkflowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
  defaultWorkspaceRoot?: string;
  fetchReferences?: (
    query: string,
    workspaceRoot: string,
  ) => Promise<ReferenceItem[]>;
}

export function CreateWorkflowModal({
  isOpen,
  onClose,
  onCreated,
  defaultWorkspaceRoot = "",
  fetchReferences,
}: CreateWorkflowModalProps) {
  const [workspaceRoot, setWorkspaceRoot] = useState(defaultWorkspaceRoot);
  const [workspaceMode, setWorkspaceMode] = useState<
    "new_worktree" | "existing_workspace"
  >("existing_workspace");
  const [plannerAdapter, setPlannerAdapter] = useState("agy");
  const [executorAdapter, setExecutorAdapter] = useState("agy");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (text: string, refs: ReferenceItem[]) => {
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          workspace_root: workspaceRoot,
          request_text: text,
          refs,
          workspace_mode: workspaceMode,
          planner_profile_id: `profile-${plannerAdapter}`,
          executor_profile_id: `profile-${executorAdapter}`,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.message || `创建失败 (HTTP ${resp.status})`);
      }
      const data = await resp.json();
      onCreated(data.workflow.id);
      onClose();
    } catch (err: any) {
      setError(err.message ?? String(err));
      throw err;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0, 0, 0, 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 2000,
      }}
    >
      <div
        className="modal-dialog"
        style={{
          background: "var(--color-canvas, #ffffff)",
          borderRadius: "8px",
          width: "560px",
          maxWidth: "90vw",
          padding: "20px",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.2)",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
            新建 DevFlow 任务
          </h3>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: "18px",
            }}
          >
            ×
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              background: "#ffebe9",
              color: "#cf222e",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            {error}
          </div>
        )}

        <div>
          <label
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 500,
              marginBottom: "4px",
            }}
          >
            工作区真实路径
          </label>
          <input
            type="text"
            aria-label="工作区真实路径"
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRoot(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "6px 10px",
              fontSize: "13px",
              borderRadius: "6px",
              border: "1px solid var(--color-border, #d0d7de)",
            }}
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px",
          }}
        >
          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 500,
                marginBottom: "4px",
              }}
            >
              规划工具 (Planner)
            </label>
            <select
              aria-label="规划工具"
              value={plannerAdapter}
              onChange={(e) => setPlannerAdapter(e.target.value)}
              style={{
                width: "100%",
                padding: "6px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #d0d7de",
              }}
            >
              <option value="agy">Antigravity CLI (agy)</option>
              <option value="codex">Codex CLI</option>
              <option value="claude-code">Claude Code</option>
              <option value="kimi-code">Kimi Code</option>
              <option value="grok-build">Grok Build</option>
              <option value="qoder">Qoder CLI</option>
              <option value="opencode">OpenCode</option>
              <option value="cursor-agent">Cursor Agent CLI</option>
            </select>
          </div>

          <div>
            <label
              style={{
                display: "block",
                fontSize: "12px",
                fontWeight: 500,
                marginBottom: "4px",
              }}
            >
              执行工具 (Executor)
            </label>
            <select
              aria-label="执行工具"
              value={executorAdapter}
              onChange={(e) => setExecutorAdapter(e.target.value)}
              style={{
                width: "100%",
                padding: "6px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #d0d7de",
              }}
            >
              <option value="agy">Antigravity CLI (agy)</option>
              <option value="codex">Codex CLI</option>
              <option value="claude-code">Claude Code</option>
              <option value="kimi-code">Kimi Code</option>
              <option value="grok-build">Grok Build</option>
              <option value="qoder">Qoder CLI</option>
              <option value="opencode">OpenCode</option>
              <option value="cursor-agent">Cursor Agent CLI</option>
            </select>
          </div>
        </div>

        <div>
          <label
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 500,
              marginBottom: "4px",
            }}
          >
            工作区方式
          </label>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="workspaceMode"
                value="existing_workspace"
                checked={workspaceMode === "existing_workspace"}
                onChange={() => setWorkspaceMode("existing_workspace")}
              />
              现有工作区 (默认，直接在项目当前目录执行，保留修改)
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "4px",
                cursor: "pointer",
              }}
            >
              <input
                type="radio"
                name="workspaceMode"
                value="new_worktree"
                checked={workspaceMode === "new_worktree"}
                onChange={() => setWorkspaceMode("new_worktree")}
              />
              独立工作树 (在项目 .worktrees/ 下创建隔离工作树)
            </label>
            {workspaceMode === "new_worktree" && (
              <div
                style={{
                  fontSize: "12px",
                  color: "#57606a",
                  padding: "4px 8px",
                  background: "#f6f8fa",
                  borderRadius: "4px",
                }}
              >
                路径位置：将按项目约定缺省在 <code>{workspaceRoot || "<source_root>"}/.worktrees/&lt;任务ID&gt;/main</code> 下创建，自动通过 Git 本地 exclude 忽略，任务完成不自动删除。
              </div>
            )}
          </div>
        </div>

        <div>
          <label
            style={{
              display: "block",
              fontSize: "12px",
              fontWeight: 500,
              marginBottom: "4px",
            }}
          >
            完整需求与 @ 引用
          </label>
          <RequirementComposer
            placeholder="输入完整业务需求... 输入 @ 引用文件或目录"
            onSubmit={handleSubmit}
            disabled={submitting}
            submitLabel={submitting ? "正在创建..." : "创建并开始规划"}
            fetchReferences={
              fetchReferences
                ? (query) => fetchReferences(query, workspaceRoot)
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
