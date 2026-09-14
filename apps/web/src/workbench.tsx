import React from "react";

export function DeliveryStrip({ detail }: { detail: any }) {
  const leaf = detail.plan?.plan.task_model === "leaf-v1";
  const total = detail.tasks.length,
    completed = detail.tasks.filter((t: any) => t.completed).length;
  const test = detail.test_progress;
  return (
    <div className="delivery-strip" aria-label="交付进度">
      {["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(
        detail.workflow.state,
      ) && <small>待批准清单</small>}
      {!leaf ? (
        <span>尚未生成细项清单</span>
      ) : (
        <span>
          已完成任务{" "}
          <b>
            {completed}/{total}
          </b>
          <progress
            aria-label="任务完成进度"
            value={completed}
            max={total || 1}
          />
        </span>
      )}
      {test?.total > 0 && (
        <span>
          已通过测试{" "}
          <b>
            {test.passed}/{test.total}
          </b>
          <progress
            aria-label="测试通过进度"
            value={test.passed}
            max={test.total}
          />
        </span>
      )}
      {test?.failed > 0 && <span className="error">失败 {test.failed}</span>}
      {test?.stale > 0 && <span>待复测 {test.stale}</span>}
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
      <p className="environment-state">
        {ready
          ? "可进行验收"
          : env?.error
            ? "环境启动失败"
            : servicesReady
              ? "服务已启动，数据验证尚未完成"
              : env?.status === "starting"
                ? "正在准备环境"
                : "验收环境尚未就绪"}
      </p>
      {env?.error && <p className="error">{env.error}</p>}
      {(project.services ?? []).map((s: any) => {
        const actual = env?.services.find((a: any) => a.id === s.id);
        return (
          <div className="metric-row" key={s.id}>
            <span>{s.port_pool === "backend" ? "后端服务" : "前端服务"}</span>
            <b>
              {env?.status === "ready" && actual?.status === "ready"
                ? "健康检查通过"
                : env?.status === "starting" && actual?.status === "ready"
                  ? "已启动"
                  : "未就绪"}
            </b>
            {ready && s.port_pool === "frontend" && (
              <a href={actual.origin} target="_blank" rel="noreferrer">
                打开验收页面 ↗
              </a>
            )}
          </div>
        );
      })}
      <div className="metric-row">
        <span>测试数据</span>
        <span>
          {project.data.mode === "external_lock"
            ? "外部测试资源 · 同一资源排队使用"
            : "本任务独立目录"}
        </span>
      </div>
      <div className="metric-row">
        <span>数据与依赖验证</span>
        <b>
          {needsData
            ? tested
              ? "本版本集成测试已通过"
              : "尚未通过本版本集成测试"
            : "未配置外部数据准备"}
        </b>
      </div>
      <details>
        <summary>环境技术详情</summary>
        <p>外部资源：{project.data.resource_id ?? "无"}</p>
        <pre>{JSON.stringify(env, null, 2)}</pre>
      </details>
    </div>
  );
}
