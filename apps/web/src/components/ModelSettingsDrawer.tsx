import React, { useEffect, useRef, useState } from "react";
import type { ToolProfile } from "../../../../packages/contracts/src/index.js";
import { TOOL_DISPLAY_ORDER } from "../../../../packages/contracts/src/index.js";
import { ModelProfileEditor } from "./ModelProfileEditor.js";
import {
  type AccessState,
  type ApiError,
  blankProfile,
  cloneProfile,
  discoverTools,
  formatApiError,
  getModelDefaults,
  getModelTools,
  isRouteMissing,
  newRequestId,
  putModelDefaults,
  refreshAdapterModels,
  verifyModelAccess,
} from "./model-api.js";
import "./model-settings.css";

export function ModelSettingsDrawer({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [planner, setPlanner] = useState<ToolProfile>(
    blankProfile("planner", "codex"),
  );
  const [executor, setExecutor] = useState<ToolProfile>(
    blankProfile("executor", "agy"),
  );
  const [revision, setRevision] = useState(0);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tools, setTools] = useState<any[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [plannerAccess, setPlannerAccess] = useState<AccessState | null>(null);
  const [executorAccess, setExecutorAccess] = useState<AccessState | null>(
    null,
  );
  const [conflict, setConflict] = useState<string | null>(null);
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const [pendingDraft, setPendingDraft] = useState(false);
  const requestId = useRef(newRequestId());
  const revisionRef = useRef(0);
  const dirtyRef = useRef(false);
  const panelAbort = useRef<AbortController | null>(null);

  const verified =
    plannerAccess?.status === "verified" &&
    executorAccess?.status === "verified";

  const applyDefaults = (defaults: {
    plannerProfile: ToolProfile;
    executorProfile: ToolProfile;
    revision: number;
    source?: string;
  }) => {
    setPlanner(cloneProfile({ ...defaults.plannerProfile, id: "planner" }));
    setExecutor(cloneProfile({ ...defaults.executorProfile, id: "executor" }));
    setRevision(defaults.revision);
    revisionRef.current = defaults.revision;
    setSource(defaults.source ?? "");
    dirtyRef.current = false;
    setConflict(null);
    requestId.current = newRequestId();
  };

  const loadInitial = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSuccess(null);
    setConflict(null);
    Promise.all([
      getModelDefaults(controller.signal),
      getModelTools(controller.signal).catch(() => []),
    ])
      .then(([defaults, summaries]) => {
        if (controller.signal.aborted) return;
        applyDefaults(
          defaults.pendingDraft
            ? {
                ...defaults,
                plannerProfile: defaults.pendingDraft.plannerProfile,
                executorProfile: defaults.pendingDraft.executorProfile,
              }
            : defaults,
        );
        setPendingDraft(Boolean(defaults.pendingDraft));
        dirtyRef.current = Boolean(defaults.pendingDraft);
        setTools(summaries);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(formatApiError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  };

  const keepDraftReload = async () => {
    try {
      const defaults = await getModelDefaults(panelAbort.current?.signal);
      setRevision(defaults.revision);
      revisionRef.current = defaults.revision;
      requestId.current = newRequestId();
      setConflict(null);
      setError(null);
      setSuccess("已读取最新版本，当前草稿已保留");
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const refreshToolData = async () => {
    const summaries = await getModelTools();
    setTools(summaries);
    setCatalogEpoch((current) => current + 1);
    const defaults = await getModelDefaults();
    if (defaults.revision !== revisionRef.current && dirtyRef.current) {
      setConflict("系统默认配置已在其他页面更新。当前草稿已保留，不会被覆盖。");
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);
  useEffect(() => {
    if (!isOpen) return;
    panelAbort.current = new AbortController();
    dirtyRef.current = false;
    const cleanup = loadInitial();
    return () => {
      cleanup();
      panelAbort.current?.abort();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      if (!verified) {
        const [nextPlanner, nextExecutor] = await Promise.all([
          verifyModelAccess(planner, panelAbort.current?.signal),
          verifyModelAccess(executor, panelAbort.current?.signal),
        ]);
        setPlannerAccess(nextPlanner);
        setExecutorAccess(nextExecutor);
        if (
          nextPlanner.status !== "verified" ||
          nextExecutor.status !== "verified"
        ) {
          throw {
            message: [nextPlanner, nextExecutor]
              .filter((item) => item.status !== "verified")
              .map((item) => item.message)
              .join("；"),
            status: 422,
          } satisfies ApiError;
        }
      }
      const receipt = await putModelDefaults({
        request_id: requestId.current,
        expected_defaults_revision: revision,
        planner_profile: planner,
        executor_profile: executor,
      });
      const nextRevision = Number(receipt.entity_revision ?? revision + 1);
      setRevision(nextRevision);
      revisionRef.current = nextRevision;
      dirtyRef.current = false;
      setConflict(null);
      setSource("user");
      setPendingDraft(false);
      setSuccess("默认配置已保存，只影响以后新建的任务");
      requestId.current = newRequestId();
    } catch (err) {
      const api = err as ApiError;
      if (api.code === "DEFAULTS_VERSION_CONFLICT") {
        setError("默认配置版本已变化，请重新载入后再保存。当前草稿已保留。");
        requestId.current = newRequestId();
      } else {
        setError(formatApiError(err));
        if (api.status === 409) requestId.current = newRequestId();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ms-drawer-backdrop" onClick={onClose}>
      <div
        className="ms-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ms-head">
          <h2 id="model-settings-title">工具与模型</h2>
          <button
            type="button"
            className="ms-link"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ✕
          </button>
        </div>
        <p className="ms-banner">此处修改只影响以后新建的任务</p>
        {pendingDraft && (
          <p className="ms-banner">
            已载入安装时选择的待验证配置；验证并保存后才替换当前默认值。
          </p>
        )}
        <p className="ms-muted">
          存储来源：当前 DevFlow 实例
          {source ? ` · ${source}` : ""}
          {revision ? ` · r${revision}` : ""}
        </p>
        {conflict && (
          <p className="ms-error" role="alert">
            {conflict}
            <button
              type="button"
              className="ms-link"
              onClick={() => void keepDraftReload()}
            >
              重新载入并保留草稿
            </button>
          </p>
        )}
        {error && (
          <p className="ms-error" role="alert">
            {error}
            {error.includes("草稿已保留") && (
              <button
                type="button"
                className="ms-link"
                onClick={() => void keepDraftReload()}
              >
                重新载入并保留草稿
              </button>
            )}
          </p>
        )}
        {success && <p className="ms-success">{success}</p>}
        {loading ? (
          <p className="ms-muted">正在读取默认配置…</p>
        ) : (
          <>
            <section className="ms-card">
              <h3>默认规划配置</h3>
              <ModelProfileEditor
                profile={planner}
                toolLabel="规划工具"
                reloadToken={catalogEpoch}
                onChange={(next) => {
                  dirtyRef.current = true;
                  requestId.current = newRequestId();
                  setPlanner(next);
                }}
                onAccessChange={setPlannerAccess}
              />
            </section>
            <section className="ms-card">
              <h3>默认执行配置</h3>
              <ModelProfileEditor
                profile={executor}
                toolLabel="执行工具"
                reloadToken={catalogEpoch}
                onChange={(next) => {
                  dirtyRef.current = true;
                  requestId.current = newRequestId();
                  setExecutor(next);
                }}
                onAccessChange={setExecutorAccess}
              />
            </section>
            <div className="ms-actions">
              <button
                type="button"
                className="ms-btn-primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving
                  ? "正在保存…"
                  : verified
                    ? "保存默认配置"
                    : "验证并保存默认配置"}
              </button>
            </div>
            <details
              open={toolsOpen}
              onToggle={(event) =>
                setToolsOpen((event.target as HTMLDetailsElement).open)
              }
            >
              <summary>已检测工具与授权状态</summary>
              <div className="ms-tools">
                {TOOL_DISPLAY_ORDER.map((item) => {
                  const row = tools.find(
                    (tool) => tool.adapterId === item.adapterId,
                  );
                  return (
                    <div className="ms-tool-row" key={item.adapterId}>
                      <div>
                        <strong>
                          {item.label}（{item.adapterId}）
                        </strong>
                        <div className="ms-muted">
                          {row?.probeStatus ?? "尚未检测"}
                          {row?.catalogUpdatedAt
                            ? ` · 更新于 ${row.catalogUpdatedAt}`
                            : ""}
                          {row?.cliVersion ? ` · ${row.cliVersion}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="ms-btn-secondary"
                        onClick={() =>
                          void refreshAdapterModels(
                            item.adapterId,
                            panelAbort.current?.signal,
                          )
                            .then(() => refreshToolData())
                            .catch((err) => setError(formatApiError(err)))
                        }
                      >
                        刷新
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="ms-btn-secondary"
                  onClick={() =>
                    void discoverTools(
                      TOOL_DISPLAY_ORDER.map((item) => item.adapterId),
                      panelAbort.current?.signal,
                    )
                      .then(() => refreshToolData())
                      .catch((err) => {
                        if (!isRouteMissing(err as ApiError)) {
                          setError(formatApiError(err));
                        }
                      })
                  }
                >
                  重新检测工具
                </button>
              </div>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
