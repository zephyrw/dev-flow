import React, { useEffect, useRef, useState } from "react";
import type { ToolProfile } from "../../../../packages/contracts/src/index.js";
import { AppDialog } from "./AppDialog.js";
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
  newRequestId,
  putModelDefaults,
  verifyModelAccess,
  type ApiError,
} from "./model-api.js";
import "./model-settings.css";

export interface ModelSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onDefaultsUpdated?: () => void;
}

const GLOBAL_TABS: ConfigTabItem[] = [
  { id: "planner", label: "规划" },
  { id: "executor", label: "执行" },
];

export function ModelSettingsDialog({
  isOpen,
  onClose,
  onDefaultsUpdated,
}: ModelSettingsDialogProps) {
  const [planner, setPlanner] = useState<ToolProfile>(
    blankProfile("planner", "codex"),
  );
  const [executor, setExecutor] = useState<ToolProfile>(
    blankProfile("executor", "agy"),
  );
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ConfigTabId>("planner");
  const [isDirty, setIsDirty] = useState(false);

  const requestId = useRef(newRequestId());
  const panelAbort = useRef<AbortController | null>(null);

  const applyDefaults = (defaults: {
    plannerProfile: ToolProfile;
    executorProfile: ToolProfile;
    revision: number;
  }) => {
    setPlanner(cloneProfile({ ...defaults.plannerProfile, id: "planner" }));
    setExecutor(cloneProfile({ ...defaults.executorProfile, id: "executor" }));
    setRevision(defaults.revision);
    setIsDirty(false);
    requestId.current = newRequestId();
  };

  const load = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    getModelDefaults(controller.signal)
      .then((defaults) => {
        if (controller.signal.aborted) return;
        applyDefaults({
          plannerProfile: defaults.plannerProfile,
          executorProfile: defaults.executorProfile,
          revision: defaults.revision,
        });
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(formatApiError(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  };

  useEffect(() => {
    if (!isOpen) return;
    panelAbort.current = new AbortController();
    const cleanup = load();
    return () => {
      cleanup();
      panelAbort.current?.abort();
    };
  }, [isOpen]);

  const verifyDraft = async () => {
    for (const profile of [planner, executor]) {
      if (!profile.modelId) continue;
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
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await verifyDraft();
      await putModelDefaults({
        request_id: requestId.current,
        expected_defaults_revision: revision,
        planner_profile: planner,
        executor_profile: executor,
      });
      setIsDirty(false);
      onDefaultsUpdated?.();
      onClose();
    } catch (err) {
      const api = err as ApiError;
      if (api.code === "SPEC_VERSION_CONFLICT" || api.status === 409) {
        setError("全局默认配置已在其他位置更新。当前草稿已保留，请重新载入后核对。");
        requestId.current = newRequestId();
        return;
      }
      setError(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleReload = () => {
    setLoading(true);
    getModelDefaults()
      .then((defaults) => {
        setRevision(defaults.revision);
        setError(null);
        requestId.current = newRequestId();
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  };

  const footer = (
    <>
      {error && error.includes("已在其他位置更新") && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleReload}
          disabled={saving}
        >
          重新载入
        </button>
      )}

      <button
        type="button"
        className="btn btn-secondary"
        onClick={onClose}
        disabled={saving}
      >
        取消
      </button>

      <button
        type="button"
        className="btn btn-primary"
        disabled={saving || loading}
        onClick={handleSave}
      >
        {saving ? "正在保存…" : "保存"}
      </button>
    </>
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      title="默认工具与模型"
      width={720}
      isDirty={isDirty}
      footer={footer}
    >
      {error && !error.includes("已在其他位置更新") && (
        <div className="ms-error-bar" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="ms-dialog-loading">正在读取默认配置…</div>
      ) : (
        <ModelConfigTabs
          tabs={GLOBAL_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          plannerProfile={planner}
          executorProfile={executor}
          onPlannerChange={(p) => {
            setIsDirty(true);
            setPlanner(p);
          }}
          onExecutorChange={(p) => {
            setIsDirty(true);
            setExecutor(p);
          }}
          disabled={saving}
        />
      )}
    </AppDialog>
  );
}
