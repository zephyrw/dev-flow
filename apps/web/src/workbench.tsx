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
            {native ? "工作包已核验" : "验证完成"}
          </span>
          <b className="chip-value">
            {verified}/{total}
          </b>
        </span>
      )}
      {test?.total > 0 && (
        <span className="metric-chip">
          <span className="chip-label">
            {native ? "计划用例已核验" : "已通过测试"}
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
        </span>
      )}
      {test?.failed > 0 && (
        <span className="metric-chip error-chip">
          <span className="error-dot" />
          失败 <b>{test.failed}</b>
        </span>
      )}
      {native && detail.native_progress?.tests.length > 0 && (
        <span className="metric-chip" aria-label="自测执行次数">
          已执行自测 <b>{detail.native_progress.tests.length}</b> 次
        </span>
      )}
      {native && detail.native_progress?.running > 0 && (
        <span className="metric-chip">
          自测运行中 <b>{detail.native_progress.running}</b>
        </span>
      )}
      {native && detail.native_progress?.latest_result && (
        <span className="metric-chip" aria-label="最近自测结果">
          最近自测：
          {detail.native_progress.latest_result.passed !== undefined ? (
            <>
              {detail.native_progress.latest_result.status === "failed"
                ? "命令失败 · "
                : ""}
              通过 <b>{detail.native_progress.latest_result.passed}</b> · 失败{" "}
              <b>{detail.native_progress.latest_result.failed ?? 0}</b>
            </>
          ) : detail.native_progress.latest_result.status === "failed" ? (
            "执行失败"
          ) : (
            "结果待确认"
          )}
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

export function EnvironmentSummary({ detail }: { detail: any }) {
  const env = detail.environment,
    project = detail.project;
  // An exit code and stdout prove only that a script ran. Data validation is
  // reported separately from service health and never inferred from a message.
  const integration =
    detail.test_progress?.cases?.filter(
      (c: any) => c.layer === "integration",
    ) ?? [];
  const tested =
    integration.length > 0 &&
    integration.every((c: any) => c.status === "passed");
  const needsData =
    !!project.data.fixture_command_id || project.data.mode === "external_lock";
  const servicesReady =
    env?.status === "ready" &&
    project.services.length > 0 &&
    project.services.every((s: any) =>
      env.services.some((a: any) => a.id === s.id && a.status === "ready"),
    );
  const ready = servicesReady && (!needsData || tested);
  return (
    <div className="environment-summary">
      <p className="notice-subtle">
        本机验证副本用于运行当前任务的代码和浏览器测试，使用独立数据目录。地址为
        127.0.0.1，端口由本机空闲端口池分配，与工作流控制台分开。
      </p>
      <div
        className={`environment-state-banner ${ready ? "ready" : env?.error ? "error" : "pending"}`}
      >
        <span className="status-indicator-dot" />
        <p className="environment-state">
          {ready
            ? "可进行验收"
            : env?.error
              ? "本机验证副本启动失败"
              : servicesReady
                ? "服务已启动，数据验证尚未完成"
                : env?.status === "starting"
                  ? "正在准备环境…"
                  : "验收环境尚未就绪"}
        </p>
      </div>
      {env?.error && <p className="error">{env.error}</p>}
      <div className="environment-metrics-card">
        {(project.services ?? []).map((s: any) => {
          const actual = env?.services.find((a: any) => a.id === s.id);
          return (
            <div className="metric-row" key={s.id}>
              <span className="metric-title">
                {s.port_pool === "backend" ? "后端服务" : "前端服务"}
              </span>
              <b
                className={`metric-status ${actual?.status === "ready" ? "ready" : ""}`}
              >
                {env?.status === "ready" && actual?.status === "ready"
                  ? "健康检查通过"
                  : env?.status === "starting" && actual?.status === "ready"
                    ? "已启动"
                    : "未就绪"}
              </b>
              {ready && s.port_pool === "frontend" && (
                <a
                  className="btn-link"
                  href={actual.origin}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开验收页面 ↗
                </a>
              )}
            </div>
          );
        })}
        <div className="metric-row">
          <span className="metric-title">测试数据</span>
          <span className="metric-desc">
            {project.data.mode === "external_lock"
              ? "外部测试资源 · 同一资源排队使用"
              : "本任务独立目录"}
          </span>
        </div>
        <div className="metric-row">
          <span className="metric-title">数据与依赖验证</span>
          <b className={`metric-status ${tested ? "ready" : ""}`}>
            {needsData
              ? tested
                ? "本版本集成测试已通过"
                : "尚未通过本版本集成测试"
              : "未配置外部数据准备"}
          </b>
        </div>
      </div>
      <details className="environment-details-box">
        <summary>环境技术详情</summary>
        <div className="details-content">
          <p>外部资源：{project.data.resource_id ?? "无"}</p>
          <pre>{JSON.stringify(env, null, 2)}</pre>
        </div>
      </details>
    </div>
  );
}
