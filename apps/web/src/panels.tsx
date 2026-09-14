import React, { useState } from "react";
export const taskLabels: Record<string, string> = {
  completed: "已完成",
  active: "进行中",
  pending_check: "待核验",
  needs_changes: "需修改",
  pending: "未开始",
};
export const caseLabels: Record<string, string> = {
  passed: "已通过",
  failed: "失败",
  skipped: "已跳过",
  stale: "待复测",
  not_run: "未运行",
  missing: "未发现",
};
export function TaskTree({ detail }: { detail: any }) {
  const [filter, setFilter] = useState(""),
    [state, setState] = useState("all");
  const leaf = detail.plan?.plan.task_model === "leaf-v1";
  const groups = leaf
    ? detail.plan.plan.modules
    : [{ id: "legacy", title: "工作包" }];
  const tasks = detail.tasks.filter(
    (t: any) =>
      (!filter ||
        `${t.id} ${t.title}`.toLowerCase().includes(filter.toLowerCase())) &&
      (state === "all" || t.implementation_status === state),
  );
  return (
    <>
      <div className="filters">
        <input
          aria-label="搜索任务"
          placeholder="搜索任务"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
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
      {!leaf && <p>尚未建立细项清单 · {detail.tasks.length} 个工作包</p>}
      {groups.map((m: any) => {
        const all = detail.tasks.filter(
            (t: any) => !leaf || t.module_id === m.id,
          ),
          visible = tasks.filter((t: any) => !leaf || t.module_id === m.id);
        if (!visible.length) return null;
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
              {m.title}{" "}
              <span>
                {leaf
                  ? `${all.filter((t: any) => t.completed).length} / ${all.length}`
                  : `${all.length} 个工作包`}
              </span>
            </summary>
            {visible.map((t: any) => (
              <div className="task" key={t.id}>
                <span className={"checkbox " + (t.completed ? "checked" : "")}>
                  {t.completed ? "✓" : ""}
                </span>
                <div>
                  <b>{t.title}</b>
                  <p>{t.summary}</p>
                  <details>
                    <summary>任务详情</summary>
                    <p>
                      {
                        detail.plan?.plan?.tasks?.find(
                          (x: any) => x.id === t.id,
                        )?.implementation
                      }
                    </p>
                    <p>
                      完成条件：
                      {
                        detail.plan?.plan?.tasks?.find(
                          (x: any) => x.id === t.id,
                        )?.completion
                      }
                    </p>
                  </details>
                </div>
                <span className="badge">
                  {taskLabels[t.implementation_status] ?? "未开始"}
                </span>
              </div>
            ))}
          </details>
        );
      })}
      {!tasks.length && <p className="empty">没有符合条件的任务</p>}
    </>
  );
}
export function TestResults({ detail }: { detail: any }) {
  const [state, setState] = useState("all");
  const progress = detail.test_progress ?? { cases: [] };
  const layers: Record<string, string> = {
    unit: "单元测试",
    integration: "集成测试",
    e2e: "浏览器自动测试",
    opentabs: "真实浏览器验收",
  };
  return (
    <>
      <div className="filters">
        <select
          aria-label="测试状态"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="all">全部结果</option>
          {Object.entries(caseLabels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </div>
      {Object.entries(layers).map(([layer, label]) => {
        const all = progress.cases.filter((c: any) => c.layer === layer),
          cases = all.filter((c: any) => state === "all" || c.status === state);
        if (!all.length) return null;
        return (
          <details
            className="task-module"
            key={layer}
            open={all.some((c: any) => c.status === "failed")}
          >
            <summary>
              {label}
              <span>
                {all.filter((c: any) => c.status === "passed").length} /{" "}
                {all.length}
              </span>
            </summary>
            {cases.map((c: any) => (
              <div className="test-case" key={c.test_id + ":" + c.id}>
                <b>{c.id}</b>
                <span className={"badge " + c.status}>
                  {caseLabels[c.status]}
                </span>
                <details>
                  <summary>查看结果</summary>
                  <p>
                    关联任务：
                    {c.task_ids
                      .map(
                        (id: string) =>
                          detail.tasks.find((t: any) => t.id === id)?.title ??
                          id,
                      )
                      .join("、")}
                  </p>
                  {c.evidence_id && (
                    <>
                      {detail.evidence
                        .find((e: any) => e.id === c.evidence_id)
                        ?.files?.map((f: any) => (
                          <a
                            key={f.path}
                            href={`/api/workflows/${detail.workflow.id}/evidence/${c.evidence_id}/files/${detail.evidence.find((e: any) => e.id === c.evidence_id).files.indexOf(f)}`}
                          >
                            {f.path.split(/[\\/]/).at(-1)}
                          </a>
                        ))}
                    </>
                  )}
                </details>
              </div>
            ))}
          </details>
        );
      })}
      {!progress.cases.length && <p className="empty">暂无测试清单</p>}
    </>
  );
}
