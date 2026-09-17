import React, { useState } from "react";
import { runtimeFailureResolution } from "../../../../packages/contracts/src/runtime-failure.js";
import "./runtime-failure.css";

export function runtimeFailureForTask(detail: any) {
  const w = detail?.workflow;
  if (w?.state !== "BLOCKED" || detail.attention?.category === "source_change")
    return undefined;
  const repair = detail.repair;
  const resolution =
    detail.attention?.resolution ??
    runtimeFailureResolution(w.blocker?.code, w.blocker?.message) ??
    (w.blocker?.code === "REPAIR_EXHAUSTED" &&
    repair?.plan_revision === w.plan_revision
      ? runtimeFailureResolution(repair.code, repair.last_error)
      : undefined);
  return resolution?.code === "MODEL_QUOTA" &&
    detail.attention?.category === "queue"
    ? undefined
    : resolution;
}

export function RuntimeFailureNotice({
  detail,
  send,
  refresh,
}: {
  detail: any;
  send: (path: string, body: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const w = detail.workflow;
  const repair = detail.repair;
  const resolution = runtimeFailureForTask(detail);
  if (!resolution) return null;
  const context = detail.attention?.runtime_context;
  const profile =
    detail.attention?.profile ??
    detail.runs?.find((r: any) => r.id === w.run_id)?.profile;
  const diagnostic =
    context?.diagnostic ??
    (w.blocker?.code === "REPAIR_EXHAUSTED" ? repair?.last_error : undefined);
  const authorizationPending = detail.operations?.some(
    (r: any) => r.status === "pending",
  );
  return (
    <section
      className="runtime-failure-notice"
      id={`runtime-failure-${w.id}`}
      tabIndex={-1}
      aria-label="运行问题处理方法"
    >
      <h3>{resolution.title}</h3>
      <p>{resolution.message}</p>
      {(profile || context) && (
        <dl>
          <dt>执行工具</dt>
          <dd>{context?.adapter ?? profile?.adapterId}</dd>
          <dt>启动入口</dt>
          <dd>
            {context?.executable_ref ??
              profile?.executableRef ??
              "客户端默认路径"}
          </dd>
          <dt>所选模型</dt>
          <dd>{context?.model ?? profile?.modelId ?? "客户端原生配置"}</dd>
          {context?.exit_code !== undefined && (
            <>
              <dt>退出码</dt>
              <dd>{String(context.exit_code)}</dd>
            </>
          )}
        </dl>
      )}
      <ol>
        {resolution.steps.map((step: string) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="runtime-failure-boundary">
        本次运行问题不计入模型整改失败次数。处理后沿用原任务、批准计划和已有工作区继续。
      </p>
      {diagnostic && (
        <details>
          <summary>查看本轮原始错误</summary>
          <pre>{diagnostic}</pre>
        </details>
      )}
      {authorizationPending ? (
        <p>请先在执行侧栏处理待授权操作。</p>
      ) : (
        <button
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError("");
            try {
              await send(`/workflows/${w.id}/feedback`, {
                request_id: crypto.randomUUID(),
                expected_version: w.version,
                scope: "within_plan",
                text: `已按处理方法检查并处理“${resolution.title}”。请在原批准范围内继续原任务，保留已有修改；若运行条件仍不满足，请报告具体原因，不要将环境问题计为代码整改失败。`,
              });
              await refresh();
              window.dispatchEvent(new Event("devflow-activity"));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "正在恢复…" : "已处理，继续原任务"}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
