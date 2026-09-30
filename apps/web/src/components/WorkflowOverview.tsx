import React from "react";
import type {
  WorkflowOverviewView,
  OverviewTaskView,
  OverviewTestView,
} from "../../../../packages/contracts/src/workflow-overview.js";
import { formatWorkflowState } from "../../../../packages/presentation/src/workflow-status.js";

export interface WorkflowOverviewProps {
  workflow: any;
  overview?: WorkflowOverviewView | null;
  projectName?: string;
  onOpenPlan?: () => void;
  onOpenTasks?: () => void;
  onOpenTests?: () => void;
}

const TASK_STATUS_META: Record<
  OverviewTaskView["status"],
  { label: string; bg: string; color: string; dot: string }
> = {
  blocked: {
    label: "受阻",
    bg: "#fef2f2",
    color: "#b91c1c",
    dot: "#ef4444",
  },
  in_progress: {
    label: "进行中",
    bg: "#eff6ff",
    color: "#1d4ed8",
    dot: "#3b82f6",
  },
  pending: {
    label: "待开始",
    bg: "#f8fafc",
    color: "#475569",
    dot: "#94a3b8",
  },
  completed: {
    label: "已完成",
    bg: "#f0fdf4",
    color: "#15803d",
    dot: "#22c55e",
  },
};

const TEST_STATUS_META: Record<
  OverviewTestView["status"],
  { label: string; bg: string; color: string; dot: string }
> = {
  failed: {
    label: "未通过",
    bg: "#fef2f2",
    color: "#b91c1c",
    dot: "#ef4444",
  },
  stale: {
    label: "待复测",
    bg: "#fffbeb",
    color: "#b45309",
    dot: "#f59e0b",
  },
  pending: {
    label: "待执行",
    bg: "#f8fafc",
    color: "#475569",
    dot: "#94a3b8",
  },
  passed: {
    label: "已通过",
    bg: "#f0fdf4",
    color: "#15803d",
    dot: "#22c55e",
  },
};

export function WorkflowOverview({
  workflow,
  overview,
  projectName,
  onOpenPlan,
  onOpenTasks,
  onOpenTests,
}: WorkflowOverviewProps) {
  const goalSummary =
    (overview?.goal?.status !== "missing" && overview?.goal?.summary) ||
    workflow?.title ||
    "任务概览";
  const bgSummary =
    overview?.background?.status !== "missing"
      ? overview?.background?.summary
      : undefined;
  const bgItems = overview?.background?.items ?? [];
  const findings = overview?.findings ?? [];
  const unresolved = overview?.unresolved ?? [];
  const tasks = overview?.tasks ?? [];
  const tests = overview?.tests ?? [];
  const taskProgress = overview?.progress?.tasks ?? null;
  const testProgress = overview?.progress?.tests ?? null;
  const constraints = overview?.execution_constraints ?? null;

  const visibleTasks = tasks.slice(0, 6);
  const visibleTests = tests.slice(0, 6);
  const hasBackground = Boolean(bgSummary?.trim() || bgItems.length);
  const hasFindings = findings.length > 0 || unresolved.length > 0;

  return (
    <div
      className="workflow-overview-container"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
      }}
    >
      {/* 已提交入库横幅 */}
      {workflow?.state === "COMMITTED" && (
        <div
          className="banner committed-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            background: "var(--color-success-bg, #f6ffed)",
            border: "1px solid var(--color-success-border, #b7eb8f)",
            borderRadius: "var(--radius-md, 8px)",
            padding: "14px 18px",
            color: "var(--color-success-text, #135200)",
          }}
        >
          <span
            style={{
              display: "grid",
              placeItems: "center",
              width: "28px",
              height: "28px",
              borderRadius: "50%",
              background: "var(--color-success, #52c41a)",
              color: "#ffffff",
              fontSize: "16px",
              fontWeight: "bold",
              flexShrink: 0,
            }}
          >
            ✓
          </span>
          <div>
            <div style={{ fontWeight: 700, fontSize: "14px" }}>
              代码已提交至本地仓库
            </div>
          </div>
        </div>
      )}

      {/* 1. 任务目标主卡 */}
      <section
        className="panel overview-goal-card"
        style={{
          padding: "18px 20px",
          borderRadius: "8px",
          border: "1px solid var(--border-color, #e2e8f0)",
          background: "#ffffff",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            marginBottom: "10px",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "16px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span aria-hidden="true">🎯</span>
            <span>任务目标</span>
          </h2>
          {onOpenPlan && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ fontSize: "12px", padding: "4px 10px" }}
              onClick={onOpenPlan}
            >
              查看完整计划
            </button>
          )}
        </div>

        <p
          style={{
            margin: "0 0 12px 0",
            fontSize: "14px",
            lineHeight: "1.6",
            color: "#1e293b",
          }}
        >
          {goalSummary}
        </p>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            paddingTop: "10px",
            borderTop: "1px solid #f1f5f9",
            fontSize: "12px",
            color: "#64748b",
          }}
        >
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
            {projectName && <span>项目：{projectName}</span>}
            <span>当前阶段：{formatWorkflowState(workflow?.state)}</span>
            <span>
              计划：
              {workflow?.plan_revision > 0 ? "已生成" : "未生成"}
            </span>
          </div>

          {workflow?.request && (
            <details style={{ fontSize: "12px" }}>
              <summary style={{ cursor: "pointer", color: "#3b82f6" }}>
                查看原始需求
              </summary>
              <p
                className="request"
                style={{
                  marginTop: "8px",
                  padding: "10px",
                  background: "#f8fafc",
                  borderRadius: "6px",
                  whiteSpace: "pre-wrap",
                  color: "#334155",
                }}
              >
                {workflow.request}
              </p>
            </details>
          )}
        </div>
      </section>

      {/* 2. 背景与约束 & 调研结果 */}
      {(hasBackground || hasFindings) && (
        <div
          className="overview-grid-row"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {hasBackground && (
            <section
              className="panel overview-background-card"
              style={{
                padding: "16px 18px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, #e2e8f0)",
                background: "#ffffff",
              }}
            >
              <h2
                style={{
                  margin: "0 0 10px 0",
                  fontSize: "15px",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span aria-hidden="true">📌</span>
                <span>背景与约束</span>
              </h2>
              {bgSummary?.trim() && (
                <p
                  style={{
                    margin: "0 0 10px 0",
                    fontSize: "13px",
                    lineHeight: "1.6",
                    color: "#334155",
                  }}
                >
                  {bgSummary}
                </p>
              )}
              {bgItems.length > 0 && (
                <ul
                  style={{
                    margin: 0,
                    paddingLeft: "18px",
                    fontSize: "12px",
                    color: "#475569",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                  }}
                >
                  {bgItems.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {hasFindings && (
            <section
              className="panel overview-findings-card"
              style={{
                padding: "16px 18px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, #e2e8f0)",
                background: "#ffffff",
              }}
            >
              <h2
                style={{
                  margin: "0 0 10px 0",
                  fontSize: "15px",
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <span aria-hidden="true">🔍</span>
                <span>调研结果</span>
              </h2>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                }}
              >
                {findings.length > 0 && (
                  <ul
                    style={{
                      margin: 0,
                      paddingLeft: "18px",
                      fontSize: "13px",
                      color: "#334155",
                      display: "flex",
                      flexDirection: "column",
                      gap: "6px",
                    }}
                  >
                    {findings.slice(0, 5).map((f) => (
                      <li key={f.id}>
                        <strong>{f.title}</strong>
                        {f.description && (
                          <span style={{ color: "#64748b", marginLeft: "6px" }}>
                            — {f.description}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {unresolved.length > 0 && (
                  <div
                    style={{
                      padding: "8px 10px",
                      background: "#fffbeb",
                      border: "1px solid #fde68a",
                      borderRadius: "6px",
                      fontSize: "12px",
                      color: "#92400e",
                    }}
                  >
                    <div style={{ fontWeight: 600, marginBottom: "4px" }}>
                      待决问题 ({unresolved.length})：
                    </div>
                    <ul style={{ margin: 0, paddingLeft: "16px" }}>
                      {unresolved.map((u, idx) => (
                        <li key={idx}>{u}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      {/* 3. 主要任务 & 主要测试项 */}
      {(tasks.length > 0 || tests.length > 0) && (
        <div
          className="overview-grid-row"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            gap: "16px",
          }}
        >
          {tasks.length > 0 && (
            <section
              className="panel overview-tasks-card"
              style={{
                padding: "16px 18px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, #e2e8f0)",
                background: "#ffffff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "10px",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span aria-hidden="true">📋</span>
                  <span>主要任务</span>
                </h2>
                {tasks.length > 0 && onOpenTasks && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: "12px", padding: "2px 8px" }}
                    onClick={onOpenTasks}
                  >
                    查看全部 {tasks.length} 项
                  </button>
                )}
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                {visibleTasks.map((t) => {
                  const meta = TASK_STATUS_META[t.status];
                  return (
                    <div
                      key={t.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        padding: "6px 10px",
                        borderRadius: "6px",
                        background: "#f8fafc",
                        fontSize: "13px",
                      }}
                    >
                      <span
                        style={{
                          color: "#1e293b",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={t.title}
                      >
                        {t.title}
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          padding: "2px 8px",
                          borderRadius: "999px",
                          fontSize: "11px",
                          fontWeight: 600,
                          background: meta.bg,
                          color: meta.color,
                          flexShrink: 0,
                        }}
                      >
                        <span
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            background: meta.dot,
                          }}
                        />
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {tests.length > 0 && (
            <section
              className="panel overview-tests-card"
              style={{
                padding: "16px 18px",
                borderRadius: "8px",
                border: "1px solid var(--border-color, #e2e8f0)",
                background: "#ffffff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "10px",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontSize: "15px",
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span aria-hidden="true">🧪</span>
                  <span>主要测试项</span>
                </h2>
                {tests.length > 0 && onOpenTests && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: "12px", padding: "2px 8px" }}
                    onClick={onOpenTests}
                  >
                    查看全部 {tests.length} 项
                  </button>
                )}
              </div>

              <div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                {visibleTests.map((tst) => {
                  const meta = TEST_STATUS_META[tst.status];
                  return (
                    <div
                      key={tst.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        padding: "6px 10px",
                        borderRadius: "6px",
                        background: "#f8fafc",
                        fontSize: "13px",
                      }}
                    >
                      <span
                        style={{
                          color: "#1e293b",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={tst.scenario}
                      >
                        {tst.scenario}
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          padding: "2px 8px",
                          borderRadius: "999px",
                          fontSize: "11px",
                          fontWeight: 600,
                          background: meta.bg,
                          color: meta.color,
                          flexShrink: 0,
                        }}
                      >
                        <span
                          style={{
                            width: "6px",
                            height: "6px",
                            borderRadius: "50%",
                            background: meta.dot,
                          }}
                        />
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}

      {/* 4. 可信状态分布（仅当存在可信统计分母时显示，绝不画假 0% 卡片） */}
      {(taskProgress !== null || testProgress !== null) && (
        <section
          className="panel overview-progress-card"
          style={{
            padding: "14px 18px",
            borderRadius: "8px",
            border: "1px solid var(--border-color, #e2e8f0)",
            background: "#ffffff",
            display: "flex",
            flexWrap: "wrap",
            gap: "24px",
          }}
        >
          {taskProgress !== null && (
            <div style={{ flex: "1 1 240px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "13px",
                  fontWeight: 600,
                  marginBottom: "6px",
                  color: "#334155",
                }}
              >
                <span>任务状态分布</span>
                <span>
                  已完成 {taskProgress.completed} / {taskProgress.total} (
                  {taskProgress.percentage}%)
                </span>
              </div>
              <div
                style={{
                  height: "8px",
                  borderRadius: "999px",
                  background: "#e2e8f0",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${taskProgress.percentage}%`,
                    height: "100%",
                    background: "#22c55e",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          )}

          {testProgress !== null && (
            <div style={{ flex: "1 1 240px" }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: "13px",
                  fontWeight: 600,
                  marginBottom: "6px",
                  color: "#334155",
                }}
              >
                <span>测试验收分布</span>
                <span>
                  已通过 {testProgress.completed} / {testProgress.total} (
                  {testProgress.percentage}%)
                </span>
              </div>
              <div
                style={{
                  height: "8px",
                  borderRadius: "999px",
                  background: "#e2e8f0",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${testProgress.percentage}%`,
                    height: "100%",
                    background: "#3b82f6",
                    transition: "width 0.3s ease",
                  }}
                />
              </div>
            </div>
          )}
        </section>
      )}

      {/* 5. 本版审批附加执行约束（非空时显示） */}
      {constraints && constraints.text.trim().length > 0 && (
        <section
          className="panel overview-constraints-card"
          style={{
            padding: "14px 18px",
            borderRadius: "8px",
            border: "1px solid #bfdbfe",
            background: "#eff6ff",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "6px",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "14px",
                fontWeight: 600,
                color: "#1e40af",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <span aria-hidden="true">🛡️</span>
              <span>执行要求</span>
            </h2>
          </div>
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              color: "#1e3a8a",
              whiteSpace: "pre-wrap",
              lineHeight: "1.5",
            }}
          >
            {constraints.text}
          </p>
        </section>
      )}
    </div>
  );
}
