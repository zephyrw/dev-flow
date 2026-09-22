import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  RoleOverrides,
  ToolProfile,
} from "../../../../packages/contracts/src/index.js";
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
  getExecutionSpec,
  inheritOverrides,
  isRouteMissing,
  isTerminalState,
  newRequestId,
  OVERRIDE_ROLES,
  postExecutionSpec,
  postModelSwitch,
  type ApiError,
  type ExecutionSpecPayload,
  verifyModelAccess,
} from "./model-api.js";
import "./model-settings.css";

export interface ToolModelDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workflowId: string;
  workflowState?: string;
  focusRole?: string;
  onSpecUpdated?: () => void;
}

function specProfiles(data: ExecutionSpecPayload): {
  planner: ToolProfile;
  executor: ToolProfile;
  overrides: RoleOverrides;
  revision: number;
} {
  const spec = data.spec ?? ({} as ExecutionSpecPayload["spec"]);
  const planner =
    spec.plannerProfile ||
    (data.resolved_roles?.planner?.profile as ToolProfile | undefined);
  const executor =
    spec.executorProfile ||
    (data.resolved_roles?.executor?.profile as ToolProfile | undefined);
  return {
    planner: cloneProfile(
      planner
        ? { ...planner, id: "planner" }
        : blankProfile("planner", "codex"),
    ),
    executor: cloneProfile(
      executor
        ? { ...executor, id: "executor" }
        : blankProfile("executor", "agy"),
    ),
    overrides: spec.roleOverrides ?? inheritOverrides(),
    revision: Number(data.spec_revision ?? spec.revision ?? 0),
  };
}

export function ToolModelDialog({
  isOpen,
  onClose,
  workflowId,
  workflowState,
  focusRole,
  onSpecUpdated,
}: ToolModelDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<ExecutionSpecPayload | null>(null);
  const [planner, setPlanner] = useState<ToolProfile>(
    blankProfile("planner", "codex"),
  );
  const [executor, setExecutor] = useState<ToolProfile>(
    blankProfile("executor", "agy"),
  );
  const [overrides, setOverrides] = useState<RoleOverrides>(inheritOverrides());
  const [revision, setRevision] = useState(0);
  const [workflowVersion, setWorkflowVersion] = useState(0);
  const [activeTab, setActiveTab] = useState<ConfigTabId>("planner");
  const [isDirty, setIsDirty] = useState(false);

  const initialProfilesRef = useRef<{
    planner: ToolProfile;
    executor: ToolProfile;
    overrides: RoleOverrides;
  } | null>(null);

  const requestId = useRef(newRequestId());
  const panelAbort = useRef<AbortController | null>(null);

  const readonly =
    isTerminalState(workflowState) || payload?.can_edit === false;

  // 根据任务实际情况确定 Tab 列表
  const tabs: ConfigTabItem[] = useMemo(() => {
    const baseTabs: ConfigTabItem[] = [
      { id: "planner", label: "规划" },
      { id: "executor", label: "执行" },
    ];

    const currentOverrides = payload?.spec.roleOverrides;
    const activeRole = payload?.active_run?.role;

    if (activeRole === "reviewer" || currentOverrides?.reviewer?.mode === "explicit") {
      baseTabs.push({
        id: "reviewer",
        label: "代码审查",
        inheritable: true,
        defaultInheritSource: "planner",
      });
    }
    if (activeRole === "review_fixer" || currentOverrides?.review_fixer?.mode === "explicit") {
      baseTabs.push({
        id: "review_fixer",
        label: "审查修复",
        inheritable: true,
        defaultInheritSource: "executor",
      });
    }
    if (activeRole === "functional_fixer" || currentOverrides?.functional_fixer?.mode === "explicit") {
      baseTabs.push({
        id: "functional_fixer",
        label: "功能修复",
        inheritable: true,
        defaultInheritSource: "executor",
      });
    }

    return baseTabs;
  }, [payload]);

  const applySpec = (data: ExecutionSpecPayload, keepDraft: boolean) => {
    setPayload(data);
    setWorkflowVersion(data.workflow_version);
    if (keepDraft) return;

    const next = specProfiles(data);
    setPlanner(next.planner);
    setExecutor(next.executor);
    setOverrides(next.overrides);
    setRevision(next.revision);
    initialProfilesRef.current = {
      planner: cloneProfile(next.planner),
      executor: cloneProfile(next.executor),
      overrides: JSON.parse(JSON.stringify(next.overrides)),
    };
    setIsDirty(false);
    requestId.current = newRequestId();

    // 确定初始 Tab
    const activeRole = data.active_run?.role;
    if (focusRole && (focusRole === "planner" || focusRole === "executor" || OVERRIDE_ROLES.includes(focusRole as any))) {
      setActiveTab(focusRole as ConfigTabId);
    } else if (activeRole && (activeRole === "planner" || activeRole === "executor")) {
      setActiveTab(activeRole as ConfigTabId);
    } else {
      setActiveTab("planner");
    }
  };

  const load = (keepStatus = false, keepDraft = false) => {
    if (!workflowId) return;
    const controller = new AbortController();
    setLoading(true);
    if (!keepStatus) setError(null);

    getExecutionSpec(workflowId, controller.signal)
      .then((data) => {
        applySpec(data, keepDraft);
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));

    return () => controller.abort();
  };

  useEffect(() => {
    if (!isOpen || !workflowId) return;
    panelAbort.current = new AbortController();
    const cleanup = load();
    return () => {
      cleanup?.();
      panelAbort.current?.abort();
    };
  }, [isOpen, workflowId]);

  const writeBody = () => ({
    request_id: requestId.current,
    expected_spec_revision: revision,
    planner_profile: planner,
    executor_profile: executor,
    role_overrides: overrides,
  });

  const verifyDraft = async () => {
    const targets: ToolProfile[] = [planner, executor];
    for (const role of OVERRIDE_ROLES) {
      const binding = overrides[role];
      if (binding && binding.mode === "explicit") targets.push(binding.profile);
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

  const handleSave = async (resumeAfterSwitch = false) => {
    setSaving(true);
    setError(null);
    try {
      await verifyDraft();
      if (resumeAfterSwitch) {
        const receipt = await postModelSwitch(workflowId, {
          ...writeBody(),
          expected_workflow_version: workflowVersion,
          expected_run_id: payload?.active_run?.run_id ?? null,
          resume_after_switch: true,
        });
        if (receipt.resume_status === "failed") {
          setError(`已保存新配置，但恢复执行未完成：${receipt.resume_error ?? "未知错误"}。原恢复点已保留，请核实后继续。`);
          setIsDirty(false);
          onSpecUpdated?.();
          return;
        }
      } else {
        await postExecutionSpec(workflowId, writeBody());
      }
      setIsDirty(false);
      onSpecUpdated?.();
      onClose();
    } catch (err) {
      const api = err as ApiError;
      if (api.code === "SPEC_VERSION_CONFLICT") {
        setError("配置版本已变化。当前草稿已保留，请重新载入后核对。");
        requestId.current = newRequestId();
        return;
      }
      setError(formatApiError(err));
      if (api.status === 409) requestId.current = newRequestId();
    } finally {
      setSaving(false);
    }
  };

  const handleReload = () => {
    if (!workflowId) return;
    setLoading(true);
    getExecutionSpec(workflowId)
      .then((data) => {
        applySpec(data, true);
        setRevision(specProfiles(data).revision);
        setError(null);
        requestId.current = newRequestId();
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  };

  const handleOverrideChange = (
    role: "reviewer" | "review_fixer" | "functional_fixer",
    mode: "inherit" | "explicit",
    profile?: ToolProfile,
  ) => {
    setIsDirty(true);
    setOverrides((prev) => {
      const next = { ...prev };
      if (mode === "inherit") {
        next[role] = { mode: "inherit" };
      } else if (profile) {
        next[role] = { mode: "explicit", profile };
      }
      return next;
    });
  };

  // 根据当前运行角色解析修改前后的有效 Profile，精确比较实质变更
  const hasActiveRun = Boolean(payload?.active_run);
  const activeRole = payload?.active_run?.role;

  const resolveEffective = (
    role: string | undefined,
    p: ToolProfile,
    e: ToolProfile,
    ov: RoleOverrides,
  ): ToolProfile | null => {
    if (!role) return null;
    if (role === "planner") return p;
    if (role === "executor") return e;
    if (role === "reviewer") {
      return ov.reviewer?.mode === "explicit" ? ov.reviewer.profile : p;
    }
    if (role === "review_fixer") {
      return ov.review_fixer?.mode === "explicit" ? ov.review_fixer.profile : e;
    }
    if (role === "functional_fixer") {
      return ov.functional_fixer?.mode === "explicit" ? ov.functional_fixer.profile : e;
    }
    return e;
  };

  const isProfileChanged = (a: ToolProfile | null, b: ToolProfile | null): boolean => {
    if (!a || !b) return a !== b;
    return (
      a.adapterId !== b.adapterId ||
      a.modelId !== b.modelId ||
      JSON.stringify(a.reasoning) !== JSON.stringify(b.reasoning) ||
      a.executableRef !== b.executableRef ||
      a.nativeConfigProfile !== b.nativeConfigProfile
    );
  };

  const initialEffective = initialProfilesRef.current
    ? resolveEffective(
        activeRole,
        initialProfilesRef.current.planner,
        initialProfilesRef.current.executor,
        initialProfilesRef.current.overrides,
      )
    : null;
  const currentEffective = resolveEffective(activeRole, planner, executor, overrides);
  const isEditingActiveRole = hasActiveRun && isProfileChanged(initialEffective, currentEffective);

  const footer = (
    <>
      {error && error.includes("配置版本已变化") && (
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
        {readonly ? "关闭" : "取消"}
      </button>

      {!readonly && isEditingActiveRole ? (
        <>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving || loading}
            onClick={() => handleSave(false)}
          >
            {saving ? "正在保存…" : "保存供后续使用"}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || loading}
            onClick={() => handleSave(true)}
          >
            {saving ? "正在切换…" : "切换并继续"}
          </button>
        </>
      ) : !readonly ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || loading}
          onClick={() => handleSave(false)}
        >
          {saving ? "正在保存…" : "保存"}
        </button>
      ) : null}
    </>
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      title="工具与模型"
      width={720}
      isDirty={isDirty}
      footer={footer}
    >
      {error && !error.includes("配置版本已变化") && (
        <div className="ms-error-bar" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="ms-dialog-loading">正在读取配置…</div>
      ) : (
        <ModelConfigTabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          plannerProfile={planner}
          executorProfile={executor}
          overrides={overrides}
          onPlannerChange={(p) => {
            setIsDirty(true);
            setPlanner(p);
          }}
          onExecutorChange={(p) => {
            setIsDirty(true);
            setExecutor(p);
          }}
          onOverrideChange={handleOverrideChange}
          disabled={readonly || saving}
        />
      )}
    </AppDialog>
  );
}
