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
import { classifyAttachmentReadMode } from "../../../../packages/contracts/src/attachment-capabilities.js";
import "./model-settings.css";

export type DraftAttachment = {
  clientId: string;
  draftId: string;
  fileId?: string;
  displayName: string;
  size: number;
  mime: string;
  status: "uploading" | "ready" | "failed";
  previewUrl?: string;
  error?: string;
  file?: File;
  abortController?: AbortController;
};

type AttachmentDraft = {
  id: string;
  active: boolean;
  committed: boolean;
  cancelled: boolean;
  closing: boolean;
  items: Map<string, DraftAttachment>;
};

async function cancelAttachmentDraft(draftId: string, clientId?: string): Promise<void> {
  const base = `/api/workflows/${encodeURIComponent(draftId)}/conversation-files`;
  const response = await fetch(clientId ? `${base}/requests/${encodeURIComponent(clientId)}` : base, {
    method: "DELETE",
    keepalive: true,
  });
  if (!response.ok) throw new Error("未能回收草稿附件，请重试");
}

function releaseAttachmentPreview(item: DraftAttachment): void {
  item.abortController?.abort();
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

export function checkPlannerImageSupport(adapterId: string, mime: string): { supported: boolean; reason?: string } {
  const norm = mime.split(";")[0]!.trim().toLowerCase();
  const isImage = norm.startsWith("image/");
  if (!isImage) return { supported: false, reason: "仅支持图片格式文件" };
  if (classifyAttachmentReadMode(norm) !== "image") {
    return { supported: false, reason: "此图片格式尚未接入，请使用 PNG、JPEG、GIF 或 WebP" };
  }
  if (adapterId === "agy") {
    if (norm === "image/png" || norm === "image/jpeg" || norm === "image/jpg") {
      return { supported: true };
    }
    return { supported: false, reason: "AGY 当前支持 PNG/JPEG 图片，此格式尚未接入" };
  }
  if (["claude", "claude-code", "codex", "opencode"].includes(adapterId)) {
    return { supported: true };
  }
  return { supported: false, reason: `当前规划工具 (${adapterId}) 不支持图片附件` };
}

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
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const attachmentDraft = useRef<AttachmentDraft | null>(null);
  const attachmentActionPending = useRef(false);
  const [cancellingAttachments, setCancellingAttachments] = useState(false);
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
    if (!isOpen) {
      setAttachments([]);
      return;
    }
    setTitle("");
    setWorkspaceRoot(defaultWorkspaceRoot);
    setWorkspaceMode("new_worktree");
    setError(null);
    setSubmitting(false);
    requestId.current = newRequestId();
    const draft: AttachmentDraft = {
      id: `draft-${requestId.current}`,
      active: true,
      committed: false,
      cancelled: false,
      closing: false,
      items: new Map(),
    };
    attachmentDraft.current = draft;
    attachmentActionPending.current = false;
    setCancellingAttachments(false);
    setDirty(false);
    setAttachments([]);
    const controller = new AbortController();
    panelAbort.current = controller;
    const cleanup = loadDefaults(true);
    return () => {
      cleanup();
      controller.abort();
      draft.active = false;
      for (const item of draft.items.values()) releaseAttachmentPreview(item);
      if (!draft.committed && !draft.cancelled && draft.items.size > 0) {
        void cancelAttachmentDraft(draft.id).catch(() => {});
      }
      draft.items.clear();
      if (attachmentDraft.current === draft) attachmentDraft.current = null;
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
  const attachmentEditsBlocked = submitting || cancellingAttachments || !!attachmentDraft.current?.closing;

  const changePlanner = (next: ToolProfile) => {
    setDirty(true);
    setPlanner(next);
    for (const a of attachments) {
      const check = checkPlannerImageSupport(next.adapterId, a.mime);
      if (!check.supported) {
        setError(`规划模型已切换为 ${next.adapterId}，${check.reason || "不支持当前附件"}`);
        break;
      }
    }
  };

  const publishAttachments = (draft: AttachmentDraft) => {
    if (draft.active && attachmentDraft.current === draft) {
      setAttachments([...draft.items.values()]);
    }
  };

  const uploadDraftFile = async (file: File, draft = attachmentDraft.current) => {
    if (!draft?.active) return;
    const clientId = newRequestId();
    const previewUrl = URL.createObjectURL(file);
    const draftId = draft.id;
    const abortController = new AbortController();
    const initialItem: DraftAttachment = {
      clientId,
      draftId,
      displayName: file.name || `image_${Date.now()}.png`,
      size: file.size,
      mime: file.type || "image/png",
      status: "uploading",
      previewUrl,
      file,
      abortController,
    };
    draft.items.set(clientId, initialItem);
    publishAttachments(draft);

    const patchItem = (patch: Partial<DraftAttachment>) => {
      if (!draft.active || abortController.signal.aborted) return;
      const item = draft.items.get(clientId);
      if (!item) return;
      draft.items.set(clientId, { ...item, ...patch });
      publishAttachments(draft);
    };

    try {
      const metaResp = await fetch(`/api/workflows/${encodeURIComponent(draftId)}/conversation-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          request_id: clientId,
          display_name: initialItem.displayName,
          size: initialItem.size,
          declared_mime: initialItem.mime,
        }),
      });
      if (!metaResp.ok) {
        const errJson = await metaResp.json().catch(() => ({}));
        throw new Error(errJson.error?.message || errJson.message || `创建文件元数据失败 (${metaResp.status})`);
      }
      const meta = await metaResp.json();
      const fileId = meta.file_id;
      if (!draft.active || abortController.signal.aborted) return;
      patchItem({ fileId });

      const uploadPath = meta.upload_path || `/api/workflows/${encodeURIComponent(draftId)}/conversation-files/${encodeURIComponent(fileId)}/content`;

      const uploadResp = await fetch(uploadPath, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        signal: abortController.signal,
        body: file,
      });
      if (!uploadResp.ok) {
        const errJson = await uploadResp.json().catch(() => ({}));
        throw new Error(errJson.error?.message || errJson.message || `上传内容失败 (${uploadResp.status})`);
      }
      patchItem({ fileId, status: "ready" });
    } catch (err: any) {
      if (err.name === "AbortError") return;
      patchItem({ status: "failed", error: err.message || String(err) });
    }
  };

  const handlePasteImages = async (files: File[]) => {
    if (!files.length || submitting || attachmentActionPending.current || attachmentDraft.current?.closing) return;
    const maxFiles = 10;
    const maxFileBytes = 20 * 1024 * 1024;
    const maxTotalBytes = 100 * 1024 * 1024;

    const currentAttachments = [...(attachmentDraft.current?.items.values() ?? [])];
    if (currentAttachments.length + files.length > maxFiles) {
      setError(`每条消息最多 ${maxFiles} 个附件`);
      return;
    }

    const currentTotal = currentAttachments.reduce((sum, a) => sum + a.size, 0);
    const incomingTotal = files.reduce((sum, f) => sum + f.size, 0);
    if (currentTotal + incomingTotal > maxTotalBytes) {
      setError("附件总量超过 100 MiB");
      return;
    }

    for (const file of files) {
      if (file.size > maxFileBytes) {
        setError(`单个附件超过 20 MiB: ${file.name}`);
        return;
      }
      const check = checkPlannerImageSupport(planner.adapterId, file.type || "image/png");
      if (!check.supported) {
        setError(check.reason || "当前规划模型不支持此图片格式");
        return;
      }
    }

    setError(null);
    for (const file of files) {
      void uploadDraftFile(file);
    }
  };

  const handleRemoveAttachment = async (clientId: string) => {
    await cancelAttachment(clientId, false);
  };

  const cancelAttachment = async (clientId: string, retry: boolean) => {
    if (submitting || attachmentActionPending.current) return;
    const draft = attachmentDraft.current;
    const item = draft?.items.get(clientId);
    if (!draft?.active || draft.closing || !item || (retry && !item.file)) return;
    attachmentActionPending.current = true;
    setCancellingAttachments(true);
    setError(null);
    // Identity-based cancellation also covers metadata whose response was lost.
    const cancellation = cancelAttachmentDraft(item.draftId, item.clientId);
    item.abortController?.abort();
    try {
      await cancellation;
      releaseAttachmentPreview(item);
      draft.items.delete(clientId);
      publishAttachments(draft);
      if (retry && draft.active) void uploadDraftFile(item.file!, draft);
    } catch (err: any) {
      draft.items.set(clientId, { ...item, status: "failed", error: err.message || String(err) });
      publishAttachments(draft);
      if (draft.active) setError(err.message || String(err));
    } finally {
      if (draft.active && attachmentDraft.current === draft) {
        attachmentActionPending.current = false;
        setCancellingAttachments(false);
      }
    }
  };

  const handleRetryAttachment = async (clientId: string) => cancelAttachment(clientId, true);

  const handleClose = async () => {
    if (submitting || attachmentActionPending.current) return;
    const draft = attachmentDraft.current;
    if (!draft?.active) return;
    draft.closing = true;
    attachmentActionPending.current = true;
    setCancellingAttachments(true);
    setError(null);
    const cancellation = draft.items.size ? cancelAttachmentDraft(draft.id) : Promise.resolve();
    for (const item of draft.items.values()) item.abortController?.abort();
    try {
      await cancellation;
      if (!draft.active || attachmentDraft.current !== draft) return;
      draft.cancelled = true;
      draft.active = false;
      for (const item of draft.items.values()) releaseAttachmentPreview(item);
      draft.items.clear();
      setAttachments([]);
      onClose();
    } catch {
      for (const [clientId, item] of draft.items) {
        draft.items.set(clientId, { ...item, status: "failed", error: "草稿回收尚未确认，请再次关闭重试" });
      }
      publishAttachments(draft);
      if (draft.active) setError("未能确认草稿附件已回收，请再次关闭重试");
    } finally {
      if (draft.active && attachmentDraft.current === draft) {
        attachmentActionPending.current = false;
        setCancellingAttachments(false);
      }
    }
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
    if (submitting) return;
    if (attachmentActionPending.current || attachmentDraft.current?.closing) {
      throw new Error("草稿附件正在回收，请稍候或再次关闭重试");
    }
    if (!title.trim() || Array.from(title.trim()).length > 20 || !workspaceRoot.trim()) {
      const message = !workspaceRoot.trim() ? "工作区真实路径必填" : "请填写任务名称，最多 20 字";
      setError(message);
      throw new Error(message);
    }
    // R09: 冻结当前附件快照，全链路使用同一快照
    const draft = attachmentDraft.current;
    const createRequestId = requestId.current;
    const snapshotAttachments = [...(draft?.items.values() ?? [])];
    if (snapshotAttachments.some((a) => a.status === "uploading")) {
      const msg = "附件正在上传中，请稍候";
      setError(msg);
      throw new Error(msg);
    }
    const failedItem = snapshotAttachments.find((a) => a.status === "failed");
    if (failedItem) {
      const msg = `附件上传失败: ${failedItem.error || failedItem.displayName}，请重试或移除`;
      setError(msg);
      throw new Error(msg);
    }
    for (const a of snapshotAttachments) {
      const check = checkPlannerImageSupport(planner.adapterId, a.mime);
      if (!check.supported) {
        const msg = check.reason || "当前规划模型不支持此图片附件";
        setError(msg);
        throw new Error(msg);
      }
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
      if (!draft?.active || attachmentDraft.current !== draft) {
        throw new Error("草稿已关闭，请重新创建");
      }
      const readyFileIds = snapshotAttachments.filter((a) => a.status === "ready" && a.fileId).map((a) => a.fileId!);
      const draftId = draft.id;
      const resp = await fetch("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: createRequestId,
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
          attachment_ids: readyFileIds.length > 0 ? readyFileIds : undefined,
          draft_id: readyFileIds.length > 0 ? draftId : undefined,
        }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.message || `创建失败 (HTTP ${resp.status})`);
      }
      const data = await resp.json();
      draft.committed = true;
      if (!draft.active || attachmentDraft.current !== draft) return;
      onCreated(data.workflow.id);
      onClose();
    } catch (err: any) {
      if (draft?.active && attachmentDraft.current === draft) {
        setError(err.message ?? formatApiError(err));
      }
      throw err;
    } finally {
      if (draft?.active && attachmentDraft.current === draft) setSubmitting(false);
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
          <button type="button" className="ms-link" disabled={submitting || cancellingAttachments} onClick={handleClose}>
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
          {attachments.length > 0 && (
            <div
              className="draft-attachments-list"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                marginBottom: "8px",
                padding: "8px",
                background: "#f6f8fa",
                borderRadius: "6px",
                border: "1px solid #d0d7de",
              }}
            >
              {attachments.map((att) => (
                <div
                  key={att.clientId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    background: "#ffffff",
                    border: `1px solid ${att.status === "failed" ? "#cf222e" : "#d0d7de"}`,
                    borderRadius: "4px",
                    padding: "4px 8px",
                    fontSize: "12px",
                  }}
                >
                  {att.previewUrl && (
                    <img
                      src={att.previewUrl}
                      alt={att.displayName}
                      style={{ width: "24px", height: "24px", objectFit: "cover", borderRadius: "2px" }}
                    />
                  )}
                  <span style={{ maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {att.displayName}
                  </span>
                  <span style={{ color: "#57606a", fontSize: "11px" }}>
                    ({(att.size / 1024).toFixed(0)} KB)
                  </span>
                  {att.status === "uploading" && <span style={{ color: "#0969da" }}>上传中...</span>}
                  {att.status === "failed" && (
                    <>
                      <span style={{ color: "#cf222e" }} title={att.error}>失败</span>
                      <button
                        type="button"
                        disabled={attachmentEditsBlocked}
                        onClick={() => handleRetryAttachment(att.clientId)}
                        style={{ border: "none", background: "transparent", color: attachmentEditsBlocked ? "#8c959f" : "#0969da", cursor: attachmentEditsBlocked ? "not-allowed" : "pointer", padding: "0 2px" }}
                      >
                        重试
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    disabled={attachmentEditsBlocked}
                    onClick={() => handleRemoveAttachment(att.clientId)}
                    style={{ border: "none", background: "transparent", cursor: attachmentEditsBlocked ? "not-allowed" : "pointer", color: attachmentEditsBlocked ? "#8c959f" : "#57606a", fontWeight: "bold" }}
                    aria-label="移除附件"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <RequirementComposer
            placeholder="输入完整业务需求... 输入 @ 引用文件或目录，可直接 Ctrl+V 粘贴图片"
            onSubmit={handleSubmit}
            onPasteImages={handlePasteImages}
            disabled={attachmentEditsBlocked}
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
