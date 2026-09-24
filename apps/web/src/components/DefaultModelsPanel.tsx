import React, { useEffect, useRef, useState } from "react";
import type {
  ToolProfile,
  RoleBinding,
  RoleOverrides,
} from "../../../../packages/contracts/src/index.js";
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
  type DefaultsSnapshot,
} from "./model-api.js";
import "./model-settings.css";

export interface DefaultModelsPanelProps {
  onDefaultsUpdated?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
  onClose?: () => void;
  onCancel?: () => void;
  onSavingChange?: (saving: boolean) => void;
}

const GLOBAL_TABS: ConfigTabItem[] = [
  { id: "planner", label: "规划" },
  { id: "executor", label: "执行" },
  {
    id: "reviewer",
    label: "复核",
    inheritable: true,
    defaultInheritSource: "planner",
  },
];

export function DefaultModelsPanel({
  onDefaultsUpdated,
  onDirtyChange,
  onClose,
  onCancel,
  onSavingChange,
}: DefaultModelsPanelProps) {
  const [planner, setPlanner] = useState<ToolProfile>(
    blankProfile("planner", "codex"),
  );
  const [executor, setExecutor] = useState<ToolProfile>(
    blankProfile("executor", "agy"),
  );
  const [reviewerBinding, setReviewerBinding] = useState<RoleBinding>({
    mode: "inherit",
  });
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [activeTab, setActiveTab] = useState<ConfigTabId>("planner");

  useEffect(() => { onSavingChange?.(saving); }, [saving, onSavingChange]);

  const requestId = useRef(newRequestId());
  const panelAbort = useRef<AbortController | null>(null);

  const applyDefaults = (defaults: DefaultsSnapshot) => {
    setPlanner(cloneProfile({ ...defaults.plannerProfile, id: "planner" }));
    setExecutor(cloneProfile({ ...defaults.executorProfile, id: "executor" }));
    setReviewerBinding(
      defaults.reviewerBinding
        ? JSON.parse(JSON.stringify(defaults.reviewerBinding))
        : { mode: "inherit" },
    );
    setRevision(defaults.revision);
    onDirtyChange?.(false);
    setHasConflict(false);
    requestId.current = newRequestId();
  };

  const load = () => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setHasConflict(false);

    getModelDefaults(controller.signal)
      .then((defaults) => {
        if (controller.signal.aborted) return;
        applyDefaults(defaults);
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
    panelAbort.current = new AbortController();
    const cleanup = load();
    return () => {
      cleanup();
      panelAbort.current?.abort();
    };
  }, []);

  const verifyDraft = async () => {
    const profilesToVerify: ToolProfile[] = [planner, executor];
    if (
      reviewerBinding.mode === "explicit" &&
      reviewerBinding.profile &&
      reviewerBinding.profile.modelId
    ) {
      profilesToVerify.push(reviewerBinding.profile);
    }

    for (const profile of profilesToVerify) {
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
        reviewer_binding: reviewerBinding,
      });
      onDirtyChange?.(false);
      onDefaultsUpdated?.();
      onClose?.();
    } catch (err) {
      const api = err as ApiError;
      if (
        api.code === "SPEC_VERSION_CONFLICT" ||
        api.code === "DEFAULTS_VERSION_CONFLICT"
      ) {
        setHasConflict(true);
        setError(
          "全局默认配置已在其他位置更新。请点击“重新载入最新配置”后核对编辑。",
        );
        requestId.current = newRequestId();
        return;
      }
      if (api.code === "IDEMPOTENCY_CONFLICT") {
        setError("相同请求标识已有不同内容提交，请稍候重试。");
        requestId.current = newRequestId();
        return;
      }
      if (api.code === "ACCOUNT_BUSY") {
        setError("当前账号正忙或处于排他操作中，请稍候重试。");
        return;
      }
      if (api.status === 409) {
        setHasConflict(true);
        setError(
          api.message || "配置发生冲突，请重新载入最新配置后核对。",
        );
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
    setError(null);
    getModelDefaults()
      .then((defaults) => {
        applyDefaults(defaults);
        setHasConflict(false);
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  };

  const overrides: RoleOverrides = {
    reviewer: reviewerBinding,
    review_fixer: { mode: "inherit" },
    functional_fixer: { mode: "inherit" },
  };

  const handleOverrideChange = (
    role: "reviewer" | "review_fixer" | "functional_fixer",
    mode: "inherit" | "explicit",
    profile?: ToolProfile,
  ) => {
    if (role === "reviewer") {
      onDirtyChange?.(true);
      if (mode === "inherit") {
        setReviewerBinding({ mode: "inherit" });
      } else {
        const nextProfile =
          profile ??
          (reviewerBinding.mode === "explicit" && reviewerBinding.profile
            ? reviewerBinding.profile
            : cloneProfile({ ...planner, id: "reviewer" }));
        setReviewerBinding({
          mode: "explicit",
          profile: nextProfile,
        });
      }
    }
  };

  return (
    <div className="default-models-panel" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {error && (
        <div className="ms-error-bar" role="alert" style={{ marginBottom: "8px" }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="ms-dialog-loading" style={{ padding: "40px 0", textAlign: "center" }}>
          正在读取默认配置…
        </div>
      ) : (
        <ModelConfigTabs
          tabs={GLOBAL_TABS}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          plannerProfile={planner}
          executorProfile={executor}
          overrides={overrides}
          onPlannerChange={(p) => {
            onDirtyChange?.(true);
            setPlanner(p);
          }}
          onExecutorChange={(p) => {
            onDirtyChange?.(true);
            setExecutor(p);
          }}
          onOverrideChange={handleOverrideChange}
          disabled={saving || hasConflict}
        />
      )}

      {/* 底部操作区 */}
      <div
        className="default-models-footer"
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "10px",
          marginTop: "16px",
          paddingTop: "14px",
          borderTop: "1px solid var(--border-color, #e5e7eb)",
        }}
      >
        {hasConflict && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleReload}
            disabled={saving || loading}
          >
            重新载入最新配置
          </button>
        )}

        {onClose && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel ?? onClose}
            disabled={saving}
          >
            取消
          </button>
        )}

        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || loading || hasConflict}
          onClick={handleSave}
        >
          {saving ? "正在保存…" : "保存配置"}
        </button>
      </div>
    </div>
  );
}
