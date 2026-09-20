import React, { useEffect, useRef, useState } from "react";
import type { FunctionalIssueView } from "../../../../packages/contracts/src/index.js";
import {
  RepairModelPicker,
  defaultRepairPicker,
  type RepairPickerValue,
} from "./RepairModelPicker.js";
import {
  formatApiError,
  confirmFunctionalIssue,
  getExecutionSpec,
  getFunctionalIssueViews,
  isRouteMissing,
  postRepairAssignment,
  profileFromRepairSelection,
  profileSummary,
  purposeRoundLabel,
  ROLE_LABELS,
  toolLabel,
  effortCaption,
  newRequestId,
  verifyModelAccess,
  type ApiError,
  type ExecutionSpecPayload,
} from "./model-api.js";
import "./model-settings.css";

export function WorkflowActivity({
  workflow,
  refresh,
  detail,
}: {
  workflow: any;
  refresh: () => Promise<void>;
  detail?: any;
}) {
  const [issues, setIssues] = useState<any[]>([]),
    [viewsById, setViewsById] = useState<Record<string, FunctionalIssueView>>(
      {},
    ),
    [spec, setSpec] = useState<ExecutionSpecPayload | null>(null),
    [error, setError] = useState(""),
    [tick, setTick] = useState(0),
    [repairByIssue, setRepairByIssue] = useState<
      Record<string, RepairPickerValue>
    >({});
  const panelAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    panelAbort.current = controller;
    return () => controller.abort();
  }, [workflow.id]);
  const runs = Array.isArray(detail?.runs) ? detail.runs : [];
  useEffect(() => {
    setIssues([]);
    setViewsById({});
    setSpec(null);
    setError("");
    setRepairByIssue({});
  }, [workflow.id]);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      fetch("/api/workflows/" + workflow.id + "/functional-issues", {
        signal: abort.signal,
      }).then(async (r) => {
        if (!r.ok) throw new Error("无法读取任务反馈");
        const value = await r.json();
        if (!Array.isArray(value))
          throw new Error("任务反馈响应格式无效，请刷新重试");
        return value;
      }),
      getFunctionalIssueViews(workflow.id, abort.signal).catch((err) => {
        if (isRouteMissing(err as ApiError)) return [];
        throw err;
      }),
      getExecutionSpec(workflow.id, abort.signal).catch(() => null),
    ])
      .then(([nextIssues, views, nextSpec]) => {
        if (abort.signal.aborted) return;
        setIssues(nextIssues ?? []);
        setViewsById(indexIssueViews(views));
        setSpec(nextSpec);
        setError("");
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [workflow.id, workflow.version, tick]);
  useEffect(() => {
    const refreshActivity = () => setTick((t) => t + 1);
    window.addEventListener("devflow-activity", refreshActivity);
    return () =>
      window.removeEventListener("devflow-activity", refreshActivity);
  }, []);
  async function act(path: string, body: any) {
    try {
      const r = await fetch("/api/workflows/" + workflow.id + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await r.json();
      if (!r.ok) throw new Error(value.message ?? "操作失败");
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  const pickerFor = (issueId: string) =>
    repairByIssue[issueId] ??
    (viewsById[issueId]?.explicit_profile
      ? {
          selection: {
            mode: "custom" as const,
            profile: viewsById[issueId].explicit_profile!,
          },
          rememberForTask: false,
        }
      : defaultRepairPicker());
  async function submitAssignment(
    issue: any,
    picker: RepairPickerValue,
  ): Promise<ExecutionSpecPayload> {
    const view = viewsById[issue.issue_id];
    const batchId = view?.batch_id ?? issue.batch_id;
    if (!batchId) {
      throw {
        message: "该问题没有关联的修复批次，无法提交处理者",
        status: 422,
      } satisfies ApiError;
    }
    const currentSpec = spec;
    if (!currentSpec)
      throw {
        message: "配置尚未载入，请稍后重试",
        status: 422,
      } satisfies ApiError;
    await assertRepairSelectionAccess(
      picker,
      currentSpec,
      panelAbort.current?.signal,
    );
    await postRepairAssignment(workflow.id, {
      request_id: newRequestId(),
      batch_id: batchId,
      expected_assignment_revision:
        view?.assignment_revision ?? issue.assignment_revision ?? 0,
      expected_spec_revision: currentSpec.spec_revision,
      selection: picker.selection,
      remember_for_task: picker.rememberForTask,
    });
    return currentSpec;
  }
  async function failIssue(issue: any) {
    try {
      // No edit means keep the batch assignment across a failed retest.
      const picker = repairByIssue[issue.issue_id];
      const view = viewsById[issue.issue_id];
      if (picker) {
        if (!spec || !view?.batch_id)
          throw {
            message: "配置或修复批次尚未载入，请稍后重试",
            status: 422,
          } satisfies ApiError;
        await assertRepairSelectionAccess(
          picker,
          spec,
          panelAbort.current?.signal,
        );
      }
      await confirmFunctionalIssue(workflow.id, issue.issue_id, {
        request_id: newRequestId(),
        expected_version: workflow.version,
        delivery_revision_id: issue.fix_delivery_id,
        passed: false,
        feedback: "复测仍然存在：" + issue.description,
        ...(picker
          ? {
              repair_model: picker.selection,
              remember_for_task: picker.rememberForTask,
              batch_id: view!.batch_id!,
              expected_assignment_revision: view!.assignment_revision ?? 0,
              expected_spec_revision: spec!.spec_revision,
            }
          : {}),
      });
      clearPicker(issue.issue_id);
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      setError(formatApiError(e));
    }
  }
  function clearPicker(issueId: string) {
    setRepairByIssue((current) => {
      const next = { ...current };
      delete next[issueId];
      return next;
    });
  }
  async function saveHandler(issue: any) {
    try {
      await submitAssignment(issue, pickerFor(issue.issue_id));
      clearPicker(issue.issue_id);
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      setError(formatApiError(e));
    }
  }
  async function clearHandler(issue: any) {
    try {
      await submitAssignment(issue, {
        selection: { mode: "task-default" },
        rememberForTask: false,
      });
      clearPicker(issue.issue_id);
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      setError(formatApiError(e));
    }
  }
  if (!issues.length && !runs.length && !error) return null;
  return (
    <div aria-label="任务反馈记录">
      {runs.length > 0 && (
        <details open>
          <summary>运行模型记录</summary>
          {runs
            .slice()
            .reverse()
            .map((run: any) => (
              <article key={run.id} className="ms-card">
                <p>{runSnapshotText(run)}</p>
                {runObservedText(run)}
              </article>
            ))}
        </details>
      )}
      {issues.length > 0 && (
        <details open>
          <summary>功能问题与复测</summary>
          {issues.map((i) => {
            const view = viewsById[i.issue_id];
            return (
              <article key={i.issue_id}>
                <p>
                  {i.description} ·{" "}
                  {i.status === "ready_for_retest"
                    ? `由 ${fixerLabel(i, view)} 修复，等待你复测`
                    : (
                        {
                          open: "等待修复",
                          queued: "修复排队",
                          fixing: "修复中",
                          confirmed: "已确认",
                        } as any
                      )[i.status]}
                </p>
                {issuePickerVisible(i, workflow) && (
                  <div className="actions">
                    <RepairModelPicker
                      name={`repair-${i.issue_id}`}
                      value={pickerFor(i.issue_id)}
                      plannerProfile={spec?.spec?.plannerProfile}
                      executorProfile={spec?.spec?.executorProfile}
                      currentAssignment={view?.explicit_profile}
                      inheritedProfile={view?.inherited_profile ?? undefined}
                      onChange={(next) =>
                        setRepairByIssue((current) => ({
                          ...current,
                          [i.issue_id]: next,
                        }))
                      }
                    />
                    {i.status === "ready_for_retest" ? (
                      <>
                        <button
                          onClick={() =>
                            void act(
                              "/functional-issues/" + i.issue_id + "/confirm",
                              {
                                request_id: crypto.randomUUID(),
                                expected_version: workflow.version,
                                delivery_revision_id: i.fix_delivery_id,
                                passed: true,
                              },
                            )
                          }
                        >
                          复测通过
                        </button>
                        <button onClick={() => void failIssue(i)}>
                          仍有问题，继续修复
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => void saveHandler(i)}
                        >
                          保存处理者
                        </button>
                        <button
                          type="button"
                          onClick={() => void clearHandler(i)}
                        >
                          清除覆盖
                        </button>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

async function assertRepairSelectionAccess(
  picker: RepairPickerValue,
  spec: ExecutionSpecPayload,
  signal?: AbortSignal,
) {
  if (picker.selection.mode === "task-default") return;
  const profile = profileFromRepairSelection(
    picker.selection,
    spec.spec.plannerProfile,
    spec.spec.executorProfile,
  );
  if (!profile) return;
  const access = await verifyModelAccess(profile, signal);
  if (access.status !== "verified") {
    throw {
      message: access.message,
      status: 422,
      code: access.status,
    } satisfies ApiError;
  }
}

function indexIssueViews(
  views: FunctionalIssueView[],
): Record<string, FunctionalIssueView> {
  const next: Record<string, FunctionalIssueView> = {};
  for (const view of views) {
    next[view.issue.issue_id] = view;
  }
  return next;
}

function issuePickerVisible(issue: any, workflow: any): boolean {
  if (issue.status === "confirmed") return false;
  if (issue.status === "ready_for_retest") {
    return workflow.state === "HUMAN_PENDING";
  }
  return true;
}

function runSnapshotText(run: any): string {
  const binding = run.model_binding;
  const profile = binding?.effective_invocation
    ? {
        adapterId: binding.effective_invocation.adapterId,
        modelId: binding.effective_invocation.modelId,
        reasoning: binding.effective_invocation.reasoning,
      }
    : run.profile;
  const adapter = profile?.adapterId ?? run.adapter;
  const model = profile?.modelId ?? "未记录模型";
  const effort =
    profile?.reasoning?.mode === "explicit"
      ? effortCaption(profile.reasoning.value)
      : profile?.reasoning?.mode === "native-default"
        ? "原生默认"
        : "";
  const round = purposeRoundLabel(
    run.purpose,
    run.routing_role ?? binding?.routing_role,
  );
  const role = (run.routing_role ??
    binding?.routing_role ??
    "executor") as keyof typeof ROLE_LABELS;
  const revision =
    run.execution_spec_revision ?? binding?.execution_spec_revision ?? 0;
  const source = ROLE_LABELS[role] ?? role;
  return `本轮${round}由 ${toolLabel(adapter)} / ${model}${effort ? " / " + effort : ""} 执行，来自任务${source}配置 r${revision}`;
}

function runObservedText(run: any) {
  const observedModel = run.model_binding?.observed_model ?? run.observed_model;
  const observedEffort =
    run.model_binding?.observed_effort ?? run.observed_effort;
  if (!observedModel && !observedEffort) {
    return <p className="ms-observed">实际观察：尚未从运行报告确认</p>;
  }
  return (
    <p className="ms-observed">
      实际观察：{observedModel ?? "未报告模型"}
      {observedEffort ? ` / ${observedEffort}` : ""}
    </p>
  );
}

function fixerLabel(issue: any, view?: FunctionalIssueView): string {
  const profile =
    view?.last_fixer_profile ??
    view?.explicit_profile ??
    view?.inherited_profile ??
    issue.repair_profile;
  if (profile) return profileSummary(profile);
  if (issue.fixer_label) return issue.fixer_label;
  return "任务配置";
}
