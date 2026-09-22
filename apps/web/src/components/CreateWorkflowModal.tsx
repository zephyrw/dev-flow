import React, { useEffect, useRef, useState } from "react";
import type {
  RoleOverrides,
  ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import {
  RequirementComposer,
  type ReferenceItem,
} from "./RequirementComposer.js";
import { ModelProfileEditor } from "./ModelProfileEditor.js";
import {
  blankProfile,
  cloneProfile,
  formatApiError,
  getModelDefaults,
  inheritOverrides,
  inheritSummary,
  isRouteMissing,
  newRequestId,
  OVERRIDE_ROLES,
  type ApiError,
  type OverrideRoleId,
  verifyModelAccess,
} from "./model-api.js";
import "./model-settings.css";

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
  const [planner, setPlanner] = useState<ToolProfile>(
    blankProfile("planner", "codex"),
  );
  const [executor, setExecutor] = useState<ToolProfile>(
    blankProfile("executor", "agy"),
  );
  const [overrides, setOverrides] = useState<RoleOverrides>(inheritOverrides());
  const [loadedRevision, setLoadedRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const requestId = useRef(newRequestId());
  const panelAbort = useRef<AbortController | null>(null);

  const applyDefaults = (
    nextPlanner: ToolProfile,
    nextExecutor: ToolProfile,
    revision: number,
  ) => {
    setPlanner(cloneProfile({ ...nextPlanner, id: "planner" }));
    setExecutor(cloneProfile({ ...nextExecutor, id: "executor" }));
    setOverrides(inheritOverrides());
    setLoadedRevision(revision);
    setDirty(false);
    setStale(false);
  };

  const loadDefaults = (force = false) => {
    const controller = new AbortController();
    getModelDefaults(controller.signal)
      .then((defaults) => {
        if (!force && dirty) {
          if (defaults.revision !== loadedRevision) setStale(true);
          return;
        }
        applyDefaults(
          defaults.plannerProfile,
          defaults.executorProfile,
          defaults.revision,
        );
      })
      .catch((err) => {
        if (!isRouteMissing(err as ApiError)) setError(formatApiError(err));
      });
    return () => controller.abort();
  };

  useEffect(() => {
    if (!isOpen) return;
    setWorkspaceRoot(defaultWorkspaceRoot);
    setWorkspaceMode("new_worktree");
    setError(null);
    setSubmitting(false);
    requestId.current = newRequestId();
    setDirty(false);
    const controller = new AbortController();
    panelAbort.current = controller;
    const cleanup = loadDefaults(true);
    return () => {
      cleanup();
      controller.abort();
    };
  }, [isOpen, defaultWorkspaceRoot]);

  useEffect(() => {
    if (!isOpen) return;
    const onFocus = () => loadDefaults(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isOpen, dirty, loadedRevision]);

  if (!isOpen) return null;

  const changePlanner = (next: ToolProfile) => {
    setDirty(true);
    setPlanner(next);
  };
  const changeExecutor = (next: ToolProfile) => {
    setDirty(true);
    setExecutor(next);
  };

  const setOverrideMode = (role: OverrideRoleId, explicit: boolean) => {
    setDirty(true);
    setOverrides((current) => ({
      ...current,
      [role]: explicit
        ? {
            mode: "explicit",
            profile: blankProfile(role, planner.adapterId),
          }
        : { mode: "inherit" },
    }));
  };

  const verifyNeeded = async () => {
    const targets: ToolProfile[] = [planner, executor];
    for (const role of OVERRIDE_ROLES) {
      const binding = overrides[role];
      if (binding.mode === "explicit") targets.push(binding.profile);
    }
    for (const profile of targets) {
      if (!profile.modelId) continue;
      try {
        const access = await verifyModelAccess(
          profile,
          panelAbort.current?.signal,
        );
        if (access.status !== "verified") {
          throw {
            message: access.message,
            status: 422,
            code: access.status,
          } satisfies ApiError;
        }
      } catch (err) {
        if (isRouteMissing(err as ApiError)) continue;
        throw err;
      }
    }
  };

  const handleSubmit = async (text: string, refs: ReferenceItem[]) => {
    setSubmitting(true);
    setError(null);
    try {
      const latest = await getModelDefaults().catch((err) => {
        if (isRouteMissing(err as ApiError)) return null;
        throw err;
      });
      if (latest && latest.revision !== loadedRevision) {
        setStale(true);
      }
      await verifyNeeded();
      const resp = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: requestId.current,
          workspace_root: workspaceRoot,
          request_text: text,
          refs,
          workspace_mode: workspaceMode,
          planner_profile: planner,
          executor_profile: executor,
          role_overrides: overrides,
          source_defaults_revision: loadedRevision,
          planner_profile_id: `profile-${planner.adapterId}`,
          executor_profile_id: `profile-${executor.adapterId}`,
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
      setError(err.message ?? formatApiError(err));
      throw err;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop ms-modal-backdrop">
      <div
        className="modal-dialog ms-modal"
        role="dialog"
        aria-labelledby="create-workflow-title"
      >
        <div className="ms-head">
          <h3 id="create-workflow-title">新建 DevFlow 任务</h3>
          <button type="button" className="ms-link" onClick={onClose}>
            ×
          </button>
        </div>
        {error && (
          <div className="ms-error" role="alert">
            {error}
          </div>
        )}
        {stale && (
          <div className="ms-banner">
            默认配置已有更新
            <button
              type="button"
              className="ms-link"
              onClick={() => loadDefaults(true)}
            >
              重新载入
            </button>
          </div>
        )}
        <p className="ms-muted">来自系统默认</p>
        <div className="ms-field">
          <label htmlFor="create-workspace-root">工作区真实路径</label>
          <input
            id="create-workspace-root"
            type="text"
            aria-label="工作区真实路径"
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRoot(e.target.value)}
          />
        </div>
        <section className="ms-card">
          <h4>规划配置</h4>
          <ModelProfileEditor
            profile={planner}
            toolLabel="规划工具"
            onChange={changePlanner}
          />
        </section>
        <section className="ms-card">
          <h4>执行配置</h4>
          <ModelProfileEditor
            profile={executor}
            toolLabel="执行工具"
            onChange={changeExecutor}
          />
        </section>
        <button
          type="button"
          className="ms-btn-secondary"
          onClick={() => loadDefaults(true)}
        >
          恢复系统默认
        </button>
        <details
          open={moreOpen}
          onToggle={(event) =>
            setMoreOpen((event.target as HTMLDetailsElement).open)
          }
        >
          <summary>更多角色配置</summary>
          {OVERRIDE_ROLES.map((role) => {
            const binding = overrides[role];
            const inheritText = inheritSummary(role, planner, executor);
            return (
              <div className="ms-role-row" key={role}>
                <strong>{roleTitle(role)}</strong>
                <label>
                  <input
                    type="radio"
                    name={`override-${role}`}
                    aria-label={`${roleTitle(role)}跟随默认`}
                    checked={binding.mode === "inherit"}
                    onChange={() => setOverrideMode(role, false)}
                  />
                  跟随默认（{inheritText}）
                </label>
                <label>
                  <input
                    type="radio"
                    name={`override-${role}`}
                    aria-label={`${roleTitle(role)}单独指定`}
                    checked={binding.mode === "explicit"}
                    onChange={() => setOverrideMode(role, true)}
                  />
                  单独指定
                </label>
                {binding.mode === "explicit" && (
                  <ModelProfileEditor
                    profile={binding.profile}
                    toolLabel={roleTitle(role)}
                    onChange={(profile) => {
                      setDirty(true);
                      setOverrides((current) => ({
                        ...current,
                        [role]: { mode: "explicit", profile },
                      }));
                    }}
                  />
                )}
              </div>
            );
          })}
        </details>
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
          <label>完整需求与 @ 引用</label>
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

function roleTitle(role: OverrideRoleId): string {
  if (role === "reviewer") return "代码审查";
  if (role === "review_fixer") return "审查修复";
  return "人工问题修复";
}
