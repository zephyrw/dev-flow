import React, { useEffect, useRef, useState } from "react";
import type {
  RepairBatchView,
  RoleOverrides,
  ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import { ModelProfileEditor } from "./ModelProfileEditor.js";
import {
  RepairModelPicker,
  defaultRepairPicker,
  type RepairPickerValue,
} from "./RepairModelPicker.js";
import {
  blankProfile,
  cloneProfile,
  formatApiError,
  getExecutionSpec,
  getRepairBatches,
  inheritOverrides,
  inheritSummary,
  isRouteMissing,
  isTerminalState,
  newRequestId,
  OVERRIDE_ROLES,
  postExecutionSpec,
  postModelSwitch,
  postRepairAssignment,
  profileFromRepairSelection,
  profileSummary,
  resumeContinueLabel,
  type ApiError,
  type ExecutionSpecPayload,
  type OverrideRoleId,
  verifyModelAccess,
} from "./model-api.js";
import "./model-settings.css";
import { AgyWorkflowPolicy } from "./AgyWorkflowPolicy.js";

export interface ToolModelDrawerProps {
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

export function ToolModelDrawer({
  isOpen,
  onClose,
  workflowId,
  workflowState,
  focusRole,
  onSpecUpdated,
}: ToolModelDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
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
  const [moreOpen, setMoreOpen] = useState(false);
  const [batches, setBatches] = useState<RepairBatchView[]>([]);
  const [pickerByBatch, setPickerByBatch] = useState<
    Record<string, RepairPickerValue>
  >({});
  const requestId = useRef(newRequestId());
  const panelAbort = useRef<AbortController | null>(null);
  const readonly =
    isTerminalState(workflowState) || payload?.can_edit === false;

  const applySpec = (data: ExecutionSpecPayload, keepDraft: boolean) => {
    setPayload(data);
    setWorkflowVersion(data.workflow_version);
    if (keepDraft) return;
    const next = specProfiles(data);
    setPlanner(next.planner);
    setExecutor(next.executor);
    setOverrides(next.overrides);
    setRevision(next.revision);
    requestId.current = newRequestId();
    if (focusRole && OVERRIDE_ROLES.includes(focusRole as OverrideRoleId)) {
      setMoreOpen(true);
    }
  };

  const loadBatches = (signal?: AbortSignal) => {
    if (!workflowId) return;
    getRepairBatches(workflowId, signal)
      .then(setBatches)
      .catch((err) => {
        if (!isRouteMissing(err as ApiError)) setError(formatApiError(err));
      });
  };

  const load = (keepStatus = false, keepDraft = false) => {
    if (!workflowId) return;
    const controller = new AbortController();
    setLoading(true);
    if (!keepStatus) {
      setError(null);
      setSuccess(null);
    }
    getExecutionSpec(workflowId, controller.signal)
      .then((data) => {
        applySpec(data, keepDraft);
        loadBatches(controller.signal);
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
    return () => controller.abort();
  };

  useEffect(() => {
    if (!isOpen || !workflowId) return;
    panelAbort.current = new AbortController();
    setPickerByBatch({});
    const cleanup = load();
    return () => {
      cleanup?.();
      panelAbort.current?.abort();
    };
  }, [isOpen, workflowId]);

  if (!isOpen) return null;

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

  const afterSave = (hasActiveRun: boolean) => {
    setSuccess(
      hasActiveRun
        ? "已保存；当前轮继续使用原配置。下次派发使用新配置。"
        : "已保存；下次继续/派发时使用",
    );
    requestId.current = newRequestId();
    onSpecUpdated?.();
    load(true, false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyDraft();
      await postExecutionSpec(workflowId, writeBody());
      afterSave(Boolean(payload?.active_run));
    } catch (err) {
      handleSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const handleSwitch = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await verifyDraft();
      await postModelSwitch(workflowId, {
        ...writeBody(),
        expected_workflow_version: workflowVersion,
        expected_run_id: payload?.active_run?.run_id ?? null,
      });
      setSuccess("已暂停并保存；按新配置继续前请确认当前阶段已停止。");
      requestId.current = newRequestId();
      onSpecUpdated?.();
      load(true, false);
    } catch (err) {
      handleSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveError = (err: unknown) => {
    const api = err as ApiError;
    if (api.code === "SPEC_VERSION_CONFLICT") {
      setError("配置版本已变化。当前草稿已保留，请对照后重新保存。");
      requestId.current = newRequestId();
      return;
    }
    setError(formatApiError(err));
    if (api.status === 409) requestId.current = newRequestId();
  };

  const keepDraftReload = () => {
    if (!workflowId) return;
    setLoading(true);
    getExecutionSpec(workflowId)
      .then((data) => {
        applySpec(data, true);
        setRevision(specProfiles(data).revision);
        setError(null);
        setSuccess("已读取最新版本，当前草稿已保留");
        requestId.current = newRequestId();
        loadBatches();
      })
      .catch((err) => setError(formatApiError(err)))
      .finally(() => setLoading(false));
  };

  const pickerForBatch = (batchId: string, view: RepairBatchView) =>
    pickerByBatch[batchId] ?? pickerFromBatch(view);

  const saveBatchSelection = async (
    view: RepairBatchView,
    picker: RepairPickerValue,
  ) => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const current = payload;
      if (!current)
        throw {
          message: "配置尚未载入，请稍后重试",
          status: 422,
        } satisfies ApiError;
      if (picker.selection.mode !== "task-default") {
        const profile =
          profileFromRepairSelection(
            picker.selection,
            current.spec.plannerProfile,
            current.spec.executorProfile,
          ) ?? view.inherited_profile;
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
      await postRepairAssignment(workflowId, {
        request_id: newRequestId(),
        batch_id: view.batch.id,
        expected_assignment_revision: view.assignment?.revision ?? 0,
        expected_spec_revision: current.spec_revision,
        selection: picker.selection,
        remember_for_task: picker.rememberForTask,
      });
      setPickerByBatch((currentPickers) => {
        const next = { ...currentPickers };
        delete next[view.batch.id];
        return next;
      });
      setSuccess("已保存处理者；只影响后续修复轮次，不会改当前运行。");
      onSpecUpdated?.();
      load(true, true);
    } catch (err) {
      handleSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const copyForNewTask = async () => {
    const text = [
      `规划：${profileSummary(planner)}`,
      `执行：${profileSummary(executor)}`,
      ...OVERRIDE_ROLES.map((role) => {
        const binding = overrides[role];
        return binding.mode === "explicit"
          ? `${role}：${profileSummary(binding.profile)}`
          : `${role}：${inheritSummary(role, planner, executor)}`;
      }),
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setSuccess("已复制到剪贴板，可粘贴到新任务说明中。不会改写历史配置。");
  };

  const active = payload?.active_run;
  const requested = active?.requested;
  const observed = active?.observed;

  return (
    <div className="drawer-backdrop ms-drawer-backdrop" onClick={onClose}>
      <div
        className="drawer-content ms-drawer"
        role="dialog"
        aria-labelledby="tool-model-drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ms-head">
          <h3 id="tool-model-drawer-title">工具与模型配置</h3>
          <button type="button" className="ms-link" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && (
          <div className="ms-error" role="alert">
            {error}
            {error.includes("草稿已保留") && (
              <button
                type="button"
                className="ms-link"
                onClick={() => keepDraftReload()}
              >
                重新载入
              </button>
            )}
          </div>
        )}
        {success && <div className="ms-success">{success}</div>}
        {loading ? (
          <div className="ms-muted">正在读取规格...</div>
        ) : (
          <>
            <section className="ms-card" aria-label="当前轮">
              <h4>当前轮</h4>
              {active ? (
                <>
                  <p>
                    角色：{active.role} · 配置 r{active.bound_spec_revision}
                  </p>
                  <p>请求配置：{profileSummary(active.profile)}</p>
                  {requested?.modelId && (
                    <p className="ms-muted">
                      绑定请求：{requested.adapterId} / {requested.modelId}
                      {requested.reasoning?.mode === "explicit"
                        ? ` / ${requested.reasoning.value}`
                        : ""}
                      （不是服务端确认）
                    </p>
                  )}
                  {observed?.model || observed?.effort ? (
                    <p className="ms-observed">
                      实际观察：{observed?.model ?? "未报告模型"}
                      {observed?.effort ? ` / ${observed.effort}` : ""}
                    </p>
                  ) : (
                    <p className="ms-observed">实际观察：尚未从运行报告确认</p>
                  )}
                </>
              ) : (
                <p className="ms-muted">当前没有已绑定的运行轮次</p>
              )}
            </section>

            {batches.length > 0 ? (
              <section className="ms-card" aria-label="本次指派">
                <h4>本次修复指派</h4>
                <p className="ms-hint">
                  本次人工指定覆盖自动分配。保存只影响后续 Run，不会改当前运行。
                </p>
                {batches.map((view) => {
                  const picker = pickerForBatch(view.batch.id, view);
                  const kindLabel =
                    view.batch.kind === "quality" ? "质量修复" : "功能修复";
                  return (
                    <div className="ms-role-row" key={view.batch.id}>
                      <strong>
                        {kindLabel}
                        {view.batch.phase ? ` · ${view.batch.phase}` : ""}
                        {view.assignment
                          ? ` · r${view.assignment.revision}`
                          : " · 尚未指定覆盖"}
                      </strong>
                      <p className="ms-muted">
                        {view.assignment
                          ? profileSummary(view.assignment.profile)
                          : `跟随：${profileSummary(view.inherited_profile)}`}
                      </p>
                      <RepairModelPicker
                        name={`batch-${view.batch.id}`}
                        value={picker}
                        plannerProfile={payload?.spec.plannerProfile}
                        executorProfile={payload?.spec.executorProfile}
                        currentAssignment={view.assignment?.profile}
                        inheritedProfile={view.inherited_profile}
                        disabled={readonly || !view.can_edit}
                        repairKind={view.batch.kind}
                        onChange={(next) =>
                          setPickerByBatch((current) => ({
                            ...current,
                            [view.batch.id]: next,
                          }))
                        }
                      />
                      {!readonly && view.can_edit && (
                        <div className="ms-actions">
                          <button
                            type="button"
                            className="ms-btn-secondary"
                            disabled={saving}
                            onClick={() =>
                              void saveBatchSelection(view, {
                                selection: { mode: "task-default" },
                                rememberForTask: false,
                              })
                            }
                          >
                            清除覆盖
                          </button>
                          <button
                            type="button"
                            className="ms-btn-primary"
                            disabled={saving}
                            onClick={() =>
                              void saveBatchSelection(view, picker)
                            }
                          >
                            保存处理者
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ) : null}

            <section className="ms-card" aria-label="后续分配">
              <h4>后续分配</h4>
              <p className="ms-muted">配置版本 r{revision}</p>
              <ModelProfileEditor
                profile={planner}
                toolLabel="规划工具"
                disabled={readonly}
                onChange={setPlanner}
              />
              <ModelProfileEditor
                profile={executor}
                toolLabel="执行工具"
                disabled={readonly}
                onChange={setExecutor}
              />
              <details
                open={moreOpen}
                onToggle={(event) =>
                  setMoreOpen((event.target as HTMLDetailsElement).open)
                }
              >
                <summary>更多角色配置</summary>
                {OVERRIDE_ROLES.map((role) => {
                  const binding = overrides[role];
                  return (
                    <div className="ms-role-row" key={role}>
                      <strong>{roleTitle(role)}</strong>
                      <label>
                        <input
                          type="radio"
                          name={`task-override-${role}`}
                          disabled={readonly}
                          aria-label={`${roleTitle(role)}跟随默认`}
                          checked={binding.mode === "inherit"}
                          onChange={() =>
                            setOverrides((current) => ({
                              ...current,
                              [role]: { mode: "inherit" },
                            }))
                          }
                        />
                        跟随默认（{inheritSummary(role, planner, executor)}）
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`task-override-${role}`}
                          disabled={readonly}
                          aria-label={`${roleTitle(role)}单独指定`}
                          checked={binding.mode === "explicit"}
                          onChange={() =>
                            setOverrides((current) => ({
                              ...current,
                              [role]: {
                                mode: "explicit",
                                profile: blankProfile(role, planner.adapterId),
                              },
                            }))
                          }
                        />
                        单独指定
                      </label>
                      {binding.mode === "explicit" && (
                        <ModelProfileEditor
                          profile={binding.profile}
                          toolLabel={roleTitle(role)}
                          disabled={readonly}
                          onChange={(profile) =>
                            setOverrides((current) => ({
                              ...current,
                              [role]: { mode: "explicit", profile },
                            }))
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </details>
            </section>

            {workflowState === "STOPPED" && (
              <p className="ms-banner">
                {resumeContinueLabel(payload?.resume_target ?? null)}
              </p>
            )}

            {workflowId && <AgyWorkflowPolicy workflowId={workflowId} />}

            <div className="ms-actions">
              {readonly ? (
                <button
                  type="button"
                  className="ms-btn-secondary"
                  onClick={() => void copyForNewTask()}
                >
                  用于新任务
                </button>
              ) : (
                <>
                  {payload?.active_run && (
                    <button
                      type="button"
                      className="ms-btn-secondary"
                      disabled={saving}
                      onClick={() => void handleSwitch()}
                    >
                      暂停后应用
                    </button>
                  )}
                  <button
                    type="button"
                    className="ms-btn-secondary"
                    onClick={onClose}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="ms-btn-primary"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? "正在保存…" : "保存，下次派发生效"}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function pickerFromBatch(view: RepairBatchView): RepairPickerValue {
  if (view.assignment) {
    return {
      selection: { mode: "custom", profile: view.assignment.profile },
      rememberForTask: false,
    };
  }
  return defaultRepairPicker();
}

function roleTitle(role: OverrideRoleId): string {
  if (role === "reviewer") return "代码审查";
  if (role === "review_fixer") return "审查修复";
  return "人工问题修复";
}
