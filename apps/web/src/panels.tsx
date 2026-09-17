import React, { useState } from "react";
import { CommandPreview } from "./command-preview.js";
import type { NativeTestRun } from "../../../packages/presentation/src/native-progress.js";
export const taskLabels: Record<string, string> = {
  completed: "开发完成",
  active: "进行中",
  pending_check: "待核验",
  needs_changes: "需修改",
  check_failed: "自检未通过",
  needs_recheck: "等待前置核验",
  pending: "未开始",
  unobserved: "等待进度同步",
};
export const caseLabels: Record<string, string> = {
  passed: "已通过",
  failed: "失败",
  skipped: "已跳过",
  stale: "待复测",
  not_run: "未运行",
  missing: "未发现",
};
export function TaskTree({ detail, title }: { detail: any; title?: string }) {
  const [filter, setFilter] = useState(""),
    [state, setState] = useState("all");
  const leaf = detail.plan?.plan.task_model === "leaf-v1";
  const native = detail.plan?.plan.task_model === "native-v2";
  const structured =
    leaf ||
    native ||
    (detail.plan?.plan?.modules && detail.plan.plan.modules.length > 0);
  const submitted = detail.tasks.filter(
    (t: any) => t.has_implementation,
  ).length;
  const groups = structured
    ? detail.plan.plan.modules
    : [{ id: "legacy", title: "工作包" }];
  const tasks = detail.tasks.filter(
    (t: any) =>
      (!filter ||
        `${t.id} ${t.title}`.toLowerCase().includes(filter.toLowerCase())) &&
      (state === "all" ||
        (t.development_status ?? t.implementation_status) === state),
  );
  return (
    <div className="task-tree-container">
      <div className="panel-toolbar-header">
        <h2>{title ?? "任务进度"}</h2>
        <div className="filters">
          <div className="search-input-wrapper">
            <svg
              className="search-icon"
              viewBox="0 0 20 20"
              fill="currentColor"
              width="16"
              height="16"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
                clipRule="evenodd"
              />
            </svg>
            <input
              aria-label="搜索任务"
              placeholder="搜索任务名称或编号…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <div className="select-wrapper">
            <select
              aria-label="任务状态"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="all">全部状态</option>
              {Object.entries(taskLabels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {leaf && submitted > 0 && (
        <p className="notice-subtle" aria-label="实现记录">
          已提交实现 {submitted}/{detail.tasks.length}
          。基础测试未通过会标为“自检未通过”，实现记录保留；完成统计按当前测试结果计算。
        </p>
      )}
      {native && (
        <p className="notice-subtle" aria-label="原生执行">
          根据实际文件变更和执行记录同步进度；执行模型自主安排开发与自测，工作包完成情况另行核验。
        </p>
      )}
      {!leaf && !native && (
        <p className="notice-subtle">
          尚未建立细项清单 · {detail.tasks.length} 个工作包
        </p>
      )}
      <div className="task-modules-list">
        {groups.map((m: any) => {
          const all = detail.tasks.filter(
              (t: any) => !structured || t.module_id === m.id,
            ),
            visible = tasks.filter(
              (t: any) => !structured || t.module_id === m.id,
            );
          if (!visible.length) return null;
          const completedCount = all.filter(
            (t: any) =>
              t.development_status === "completed" || t.status === "verified",
          ).length;
          const isAllDone = all.length > 0 && completedCount === all.length;
          return (
            <details
              className="task-module"
              key={m.id}
              open={
                groups.length === 1 ||
                all.some((t: any) => t.implementation_status === "active")
              }
            >
              <summary>
                <span className="summary-left">
                  <span className="chevron-icon">▸</span>
                  <span className="module-title">{m.title}</span>
                </span>
                <span className={`module-badge ${isAllDone ? "all-done" : ""}`}>
                  {native
                    ? `已开展 ${all.filter((t: any) => ["active", "completed", "pending_check"].includes(t.development_status)).length} / ${all.length} · 已交付 ${all.filter((t: any) => t.status === "verified").length} / ${all.length}`
                    : leaf
                      ? `开发 ${completedCount} / ${all.length} · 验证 ${all.filter((t: any) => t.status === "verified").length} / ${all.length}`
                      : `${all.length} 个工作包`}
                </span>
              </summary>
              <div className="module-tasks-body">
                {visible.map((t: any) => (
                  <div className={`task ${t.implementation_status}`} key={t.id}>
                    <span
                      className={
                        "checkbox " + (t.status === "verified" ? "checked" : "")
                      }
                    >
                      {t.status === "verified" ? "✓" : ""}
                    </span>
                    <div className="task-main">
                      <div className="task-header-row">
                        <b className="task-title">{t.title}</b>
                        <span className={`badge ${t.implementation_status}`}>
                          {taskLabels[
                            t.development_status ?? t.implementation_status
                          ] ?? "未开始"}
                        </span>
                        <span className="validation-status">
                          {native ? "交付记录：" : "验证："}
                          {
                            (
                              {
                                passed: "已通过",
                                failed: "失败",
                                stale: "需重测",
                                not_run: "未验证",
                              } as Record<string, string>
                            )[
                              t.validation_status ??
                                (t.status === "verified" ? "passed" : "not_run")
                            ]
                          }
                        </span>
                      </div>
                      {t.summary && (
                        <p className="task-summary">
                          {native && t.status === "verified"
                            ? "已收到实现与测试交付记录；质量审核和人工验收分别记录。"
                            : t.summary}
                        </p>
                      )}
                      {t.recheck_reason && (
                        <p className="notice-subtle">{t.recheck_reason}</p>
                      )}
                      <details className="task-inner-details">
                        <summary>查看实现细节与完成条件</summary>
                        <div className="task-spec-box">
                          {detail.plan?.plan?.tasks?.find(
                            (x: any) => x.id === t.id,
                          )?.implementation && (
                            <div className="spec-field">
                              <span className="field-label">实现指引：</span>
                              <p className="field-value">
                                {
                                  detail.plan?.plan?.tasks?.find(
                                    (x: any) => x.id === t.id,
                                  )?.implementation
                                }
                              </p>
                            </div>
                          )}
                          {detail.plan?.plan?.tasks?.find(
                            (x: any) => x.id === t.id,
                          )?.completion && (
                            <div className="spec-field">
                              <span className="field-label">完成条件：</span>
                              <p className="field-value">
                                {
                                  detail.plan?.plan?.tasks?.find(
                                    (x: any) => x.id === t.id,
                                  )?.completion
                                }
                              </p>
                            </div>
                          )}
                        </div>
                      </details>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
      {!tasks.length && <p className="empty">没有符合条件的任务</p>}
    </div>
  );
}
export function TestResults({
  detail,
  title,
}: {
  detail: any;
  title?: string;
}) {
  const [state, setState] = useState("all");
  const native = detail.plan?.plan?.task_model === "native-v2";
  const labels: Record<string, string> = native
    ? { ...caseLabels, passed: "报告通过" }
    : caseLabels;
  const progress = detail.test_progress ?? { cases: [] };
  const evidence = [
    ...(detail.evidence ?? []),
    ...(detail.development_evidence ?? []),
  ];
  const layers: Record<string, string> = {
    unit: "单元测试",
    integration: "集成测试",
    e2e: "浏览器自动测试",
    opentabs: "E2E（历史浏览器用例）",
  };
  return (
    <div className="test-results-container">
      <div className="panel-toolbar-header">
        <h2>{title ?? "测试结果"}</h2>
        <div className="filters">
          <div className="select-wrapper">
            <select
              aria-label="测试状态"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="all">全部结果</option>
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      {detail.native_progress && (
        <section className="native-test-progress" aria-label="原生自测进度">
          <h3>实时自测</h3>
          <p className="notice-subtle">
            这里显示测试工具返回的运行状态和用例数量；计划用例按提交的对应关系统计报告结果，两种数量分别统计。
          </p>
          {detail.native_progress.tests.length === 0 && (
            <p className="empty">
              尚未观察到测试命令；执行记录更新后自动同步。
            </p>
          )}
          {detail.native_progress.latest.map((run: NativeTestRun) => (
            <article className="native-test-run" key={run.key}>
              <div className="test-case-row">
                <b>
                  {
                    {
                      running: "测试运行中",
                      passed: "自测通过",
                      failed: "自测失败",
                      returned: "自测已执行，用例数量待确认",
                      interrupted: "执行已结束，未收到最终测试结果",
                    }[run.status]
                  }
                </b>
                {run.passed !== undefined && (
                  <span>
                    通过 {run.passed} · 失败 {run.failed ?? 0} · 跳过{" "}
                    {run.skipped ?? 0}
                  </span>
                )}
                <time>{new Date(run.created_at).toLocaleTimeString()}</time>
              </div>
              <CommandPreview command={run.command} cwd={run.cwd} />
            </article>
          ))}
          <details className="activity-details">
            <summary>
              查看近期测试执行记录（{detail.native_progress.tests.length} 次）
            </summary>
            {detail.native_progress.tests.map((run: NativeTestRun) => (
              <div key={run.key} className="native-test-run">
                <span>
                  {new Date(run.created_at).toLocaleTimeString()} ·{" "}
                  {
                    {
                      running: "运行中",
                      passed: "通过",
                      failed: "失败",
                      returned: "结果待确认",
                      interrupted: "已中断",
                    }[run.status]
                  }
                </span>
                <CommandPreview command={run.command} cwd={run.cwd} />
              </div>
            ))}
          </details>
          <h3>计划用例报告结果</h3>
        </section>
      )}
      {native && (
        <p className="notice-subtle">
          报告通过表示关联测试的报告结果；是否满足原计划由现有质量审核判断，人工验收单独确认。
        </p>
      )}
      <div className="test-layers-list">
        {Object.entries(layers).map(([layer, label]) => {
          const all = progress.cases.filter((c: any) => c.layer === layer),
            cases = all.filter(
              (c: any) => state === "all" || c.status === state,
            );
          if (!all.length) return null;
          const passedCount = all.filter(
            (c: any) => c.status === "passed",
          ).length;
          const hasFailed = all.some((c: any) => c.status === "failed");
          return (
            <details
              className="task-module test-layer-module"
              key={layer}
              open={hasFailed}
            >
              <summary>
                <span className="summary-left">
                  <span className="chevron-icon">▸</span>
                  <span className="module-title">{label}</span>
                </span>
                <span
                  className={`module-badge ${hasFailed ? "has-failed" : passedCount === all.length ? "all-done" : ""}`}
                >
                  {passedCount} / {all.length} 通过
                </span>
              </summary>
              <div className="module-tasks-body">
                {cases.map((c: any) => (
                  <div
                    className={`test-case ${c.status}`}
                    key={c.test_id + ":" + c.id}
                  >
                    <div className="test-case-row">
                      <b className="test-case-id">{c.id}</b>
                      <span className={"badge " + c.status}>
                        {labels[c.status]}
                      </span>
                    </div>
                    <details className="test-case-details">
                      <summary>查看结果证据与关联</summary>
                      <div className="test-spec-box">
                        <p className="associated-tasks">
                          关联任务：
                          {c.task_ids
                            .map(
                              (id: string) =>
                                detail.tasks.find((t: any) => t.id === id)
                                  ?.title ?? id,
                            )
                            .join("、")}
                        </p>
                        {c.evidence_id && (
                          <div className="evidence-files">
                            <span className="evidence-label">证据文件：</span>
                            {evidence
                              .find((e: any) => e.id === c.evidence_id)
                              ?.files?.map((f: any) => (
                                <a
                                  key={f.path}
                                  className="evidence-file-link"
                                  href={`/api/workflows/${detail.workflow.id}/evidence/${c.evidence_id}/files/${evidence.find((e: any) => e.id === c.evidence_id).files.indexOf(f)}`}
                                >
                                  📄 {f.path.split(/[\\/]/).at(-1)}
                                </a>
                              ))}
                          </div>
                        )}
                      </div>
                    </details>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
      {!progress.cases.length && <p className="empty">暂无测试清单</p>}
    </div>
  );
}
