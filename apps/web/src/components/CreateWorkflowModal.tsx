import React, { useEffect, useRef, useState } from "react";
import type {
  RoleBinding,
  RoleOverrides,
  ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import {
  RequirementComposer,
  type ReferenceItem,
} from "./RequirementComposer.js";
import {
  ModelConfigTabs,
  type ConfigTabId,
  type ConfigTabItem,
} from "./ModelConfigTabs.js";
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
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ConfigTabId>("planner");
  const [moreOpen, setMoreOpen] = useState(false);
  const requestId = useRef(newRequestId());
  const [preview, setPreview] = useState<{
    key: string;
    digest?: string;
    error?: string;
    repositories?: { repo_id: string; source_root: string; source_branch: string; target_path: string }[];
  }>();
  const previewKey = JSON.stringify([workspaceRoot.trim(), workspaceMode, requestId.current]);
  const currentPreview = preview?.key === previewKey ? preview : undefined;
  const panelAbort = useRef<AbortController | null>(null);

  const applyDefaults = (
    nextPlanner: ToolProfile,
    nextExecutor: ToolProfile,
    revision: number,
    reviewerBinding?: RoleBinding,
  ) => {
    setPlanner(cloneProfile({ ...nextPlanner, id: "planner" }));
    setExecutor(cloneProfile({ ...nextExecutor, id: "executor" }));
    const baseOverrides = inheritOverrides();
    if (reviewerBinding) {
      baseOverrides.reviewer =
        reviewerBinding.mode === "explicit" && reviewerBinding.profile
          ? {
              mode: "explicit",
              profile: cloneProfile(reviewerBinding.profile),
            }
          : { mode: "inherit" };
    }
    setOverrides(baseOverrides);
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
          defaults.reviewerBinding,
        );
      })
      .catch((err) => {
        if (!isRouteMissing(err as ApiError)) setError(formatApiError(err));
      });
    return () => controller.abort();
  };

  // A background project refresh must not reset the user's open draft.
  // Capture the latest default when opening a new draft only.
  useEffect(() => {
    if (!isOpen) return;
    setTitle("");
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
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onFocus = () => loadDefaults(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isOpen, dirty, loadedRevision]);

  useEffect(() => {
    if (!isOpen || !workspaceRoot.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/workspaces/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            workspace_root: workspaceRoot.trim(),
            workspace_mode: workspaceMode,
            request_id: requestId.current,
          }),
        });
        const result = await response.json();
        if (!controller.signal.aborted) setPreview(response.ok
          ? { key: previewKey, digest: result.preview_digest, repositories: result.repositories }
          : { key: previewKey, error: result.message ?? "无法识别项目仓库" });
      } catch {
        if (!controller.signal.aborted) setPreview({ key: previewKey, error: "无法读取项目仓库预览" });
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [isOpen, workspaceRoot, workspaceMode, previewKey]);

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
    setOverrides((current: RoleOverrides) => ({
      ...current,
      [role]: explicit
        ? {
            mode: "explicit",
            profile: blankProfile(role, planner.adapterId),
          }
        : { mode: "inherit" },
    }));
  };

  const handleOverrideChange = (
    role: "reviewer" | "review_fixer" | "functional_fixer",
    mode: "inherit" | "explicit",
    profile?: ToolProfile,
  ) => {
    setDirty(true);
    setOverrides((current: RoleOverrides) => ({
      ...current,
      [role]:
        mode === "explicit"
          ? {
              mode: "explicit",
              profile: profile
                ? cloneProfile(profile)
                : (current[role]?.mode === "explicit" && current[role]?.profile
                    ? cloneProfile(current[role]!.profile!)
                    : blankProfile(role, planner.adapterId)),
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
          false,
          "workspace:" + workspaceRoot.trim(),
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
    if (!title.trim() || Array.from(title.trim()).length > 20 || !workspaceRoot.trim()) {
      const message = !workspaceRoot.trim() ? "工作区真实路径必填" : "请填写任务名称，最多 20 字";
      setError(message);
      throw new Error(message);
    }
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
          title: title.trim(),
          workspace_root: workspaceRoot.trim(),
          preview_digest: currentPreview?.digest,
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
          <label htmlFor="create-task-title">任务名称 <span className="required-marker" aria-hidden="true">*</span></label>
          <input id="create-task-title" aria-label="任务名称" required maxLength={20}
            value={title} onChange={(event) => setTitle(event.target.value)} placeholder="请输入任务名称，最多 20 字" />
        </div>
        <div className="ms-field">
          <label htmlFor="create-workspace-root">工作区真实路径 <span className="required-marker" aria-hidden="true">*</span></label>
          <input
            id="create-workspace-root"
            required
            type="text"
            aria-label="工作区真实路径"
            value={workspaceRoot}
            onChange={(e) => setWorkspaceRoot(e.target.value)}
          />
        </div>
        {currentPreview?.error && <p role="status">{currentPreview.error}</p>}
        {currentPreview?.repositories?.length ? (
          <div aria-label="识别到的仓库">
            <p>识别到 {currentPreview.repositories.length} 个 Git 仓库</p>
            <ul>{currentPreview.repositories.map(repo => (
              <li key={repo.repo_id}>
                <code>{repo.source_root}</code> · {repo.source_branch}
                {workspaceMode === "new_worktree" && <> → <code>{repo.target_path}</code></>}
              </li>
            ))}</ul>
          </div>
        ) : null}
        <div style={{ margin: "16px 0" }}>
          <ModelConfigTabs
            catalogScope={workspaceRoot.trim() ? "workspace:" + workspaceRoot.trim() : undefined}
            tabs={[
              { id: "planner", label: "规划" },
              { id: "executor", label: "执行" },
              {
                id: "reviewer",
                label: "代码审查",
                inheritable: true,
                defaultInheritSource: "planner",
              },
            ]}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            plannerProfile={planner}
            executorProfile={executor}
            overrides={overrides}
            onPlannerChange={changePlanner}
            onExecutorChange={changeExecutor}
            onOverrideChange={handleOverrideChange}
          />
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
            工作区方式 <span className="required-marker" aria-hidden="true">*</span>
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
                各仓库使用独立的任务分支和工作树。
              </div>
            )}
          </div>
        </div>
        <div>
          <label>完整需求与 @ 引用 <span className="required-marker" aria-hidden="true">*</span></label>
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
