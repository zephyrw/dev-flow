import React from "react";

export function DeliveryStrip({ detail }: { detail: any }) {
  const leaf = detail.plan?.plan.task_model === "leaf-v1";
  const native = detail.plan?.plan.task_model === "native-v2";
  const total = detail.task_counts?.total ?? detail.tasks.length,
    completed =
      detail.task_counts?.developed ??
      detail.tasks.filter(
        (t: any) =>
          t.development_status === "completed" || t.status === "verified",
      ).length;
  const verified =
    detail.task_counts?.verified ??
    detail.tasks.filter((t: any) => t.status === "verified").length;

  const test = detail.test_progress;
  const unreported = test?.unreported ?? test?.cases?.filter((c: any) => c.status === "unreported").length ?? 0;
  const awaitingResults = native && test?.total > 0 && unreported === test.total;
  const taskPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const testPercent =
    test?.total > 0 ? Math.round((test.passed / test.total) * 100) : 0;

  return (
    <div className="delivery-strip" aria-label="交付进度">
      {["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(
        detail.workflow.state,
      ) && (
        <span className="metric-chip pending-chip">
          <small>待批准清单</small>
        </span>
      )}
      {detail.workflow?.state === "QUALITY_REVIEW" && (
        <span className="metric-chip pending-chip">
          <span className="chip-label">质量审查</span>
          <b className="chip-value">规划模型审查中</b>
        </span>
      )}
      {detail.workflow?.state === "PLANNER_TAKEOVER" && (
        <span className="metric-chip error-chip">
          <span className="chip-label">质量关卡</span>
          <b className="chip-value">规划模型已接管修复</b>
        </span>
      )}
      {["HUMAN_PENDING", "HUMAN_VERIFY"].includes(detail.workflow?.state) && (
        <span className="metric-chip pending-chip">
          <span className="chip-label">功能核验</span>
          <b className="chip-value">待人工核验场景</b>
        </span>
      )}
      {detail.workflow?.state === "INTEGRATING" && (
        <span className="metric-chip">
          <span className="chip-label">Git 整合</span>
          <b className="chip-value">吸收主分支最新提交中</b>
        </span>
      )}
      {detail.workflow?.state === "CLEANUP_PENDING" && (
        <span className="metric-chip error-chip">
          <span className="chip-label">清理待重试</span>
          <b className="chip-value">工作树清理异常</b>
        </span>
      )}
      {["COMMITTED", "COMPLETED"].includes(detail.workflow?.state) && (
        <span className="metric-chip success-chip">
          <span className="chip-label">交付结果</span>
          <b className="chip-value">已提交至仓库</b>
        </span>
      )}

      {!leaf && !native ? (
        <span className="metric-chip empty-chip">尚未生成细项清单</span>
      ) : (
        <span className="metric-chip">
          <span className="chip-label">
            {native ? "工作包已开展" : "开发完成"}
          </span>
          <b className="chip-value">
            {native ? (detail.task_counts?.started ?? 0) : completed}/{total}
          </b>
          {!native && <span className="chip-percent">{taskPercent}%</span>}
          <progress
            aria-label={native ? "工作包开展进度" : "开发完成进度"}
            value={native ? (detail.task_counts?.started ?? 0) : completed}
            max={total || 1}
          />
        </span>
      )}
      {(leaf || native) && (
        <span className="metric-chip">
          <span className="chip-label">
            {native ? "工作包已交付" : "验证完成"}
          </span>
          <b className="chip-value">
            {verified}/{total}
          </b>
        </span>
      )}
      {test?.total > 0 && (
        <span className="metric-chip">
          {awaitingResults ? <>
            <span className="chip-label">测试进度：</span>
            <span>尚未收到逐项结果</span>
          </> : <>
          <span className="chip-label">
            {native ? "计划用例报告通过" : "已通过测试"}
          </span>
          <b className="chip-value">
            {test.passed}/{test.total}
          </b>
          <span className="chip-percent">{testPercent}%</span>
          <progress
            aria-label="测试通过进度"
            value={test.passed}
            max={test.total}
          />
          {native && unreported > 0 && <span> · {unreported} 项未回传</span>}
          </>}
        </span>
      )}
      {test?.failed > 0 && (
        <span className="metric-chip error-chip">
          <span className="error-dot" />
          失败 <b>{test.failed}</b>
        </span>
      )}
      {test?.previously_passed > 0 && (
        <span className="metric-chip stale-chip">
          曾通过待复测 <b>{test.previously_passed}</b>
        </span>
      )}
    </div>
  );
}

export function AcceptanceAccess({ detail, onReleaseEnvironment, onLockBrowser, onReleaseBrowser }: {
  detail: any;
  onReleaseEnvironment: () => void;
  onLockBrowser: () => void;
  onReleaseBrowser: () => void;
}) {
  if (!["HUMAN_PENDING", "HUMAN_VERIFY"].includes(detail.workflow?.state)) return null;
  const env = detail.environment;
  const links = env?.status === "ready" ? (detail.project?.services ?? []).flatMap((service: any) => {
    const actual = env.services?.find((entry: any) => entry.id === service.id);
    return service.port_pool === "frontend" && actual?.status === "ready" && /^https?:\/\//i.test(actual.origin ?? "")
      ? [{ id: service.id, origin: actual.origin }] : [];
  }) : [];
  return (
    <section className="panel" id={`human-acceptance-${detail.workflow.id}`} tabIndex={-1} aria-label="人工验收">
      <h2>人工验收</h2>
      <p>请按计划中的验收场景实际操作，确认结果后点击“验收通过，启动复核”。</p>
      <div className="actions">
        {links.map((link: { id: string; origin: string }) => <a key={link.id} className="btn-link" href={link.origin} target="_blank" rel="noreferrer">打开验收页面 ↗</a>)}
        {env && <>
          <button onClick={onReleaseEnvironment}>释放环境</button>
          <button onClick={onLockBrowser}>占用人工核验浏览器</button>
          <button onClick={onReleaseBrowser}>释放人工核验浏览器</button>
        </>}
      </div>
    </section>
  );
}
