import React, { useEffect, useState } from "react";
import {
  visibleRunObservation,
  runtimeToolNames,
  runtimePurposeNames,
} from "../../../../packages/presentation/src/run-observation.js";
import { CommandPreview } from "../command-preview.js";
import { formatPathSummary } from "../execution-panel.js";
import "./current-runtime.css";

export function CurrentRuntime({
  detail,
  connected,
}: {
  detail: any;
  connected: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const runtime = visibleRunObservation(detail);
  if (!runtime) return null;
  const live =
    [
      "PLANNING",
      "EXECUTING",
      "REVIEWING",
      "INTEGRATING",
      "PLANNER_TAKEOVER",
    ].includes(detail.workflow.state) &&
    !["exited", "error"].includes(runtime.status);
  const activity = live ? runtime.current_activity : undefined;
  const age = runtime.activity_at
    ? Math.max(0, Math.floor((now - Date.parse(runtime.activity_at)) / 1000))
    : undefined;
  const state = !live
    ? "本轮已停止或结束"
    : !connected
      ? "事件连接重连中"
      : runtime.status === "starting"
        ? "正在启动"
        : activity
          ? "执行工具中"
          : "等待下一条过程事件";
  const quota = runtime.quota;
  const stale =
    quota &&
    (now - Date.parse(quota.observed_at) > 120000 || !live || !connected);
  const mismatch =
    runtime.actual_model &&
    runtime.requested_model &&
    runtime.actual_model !== runtime.requested_model;
  return (
    <section
      className="current-runtime"
      aria-label="当前工具与模型"
      key={runtime.run_id}
    >
      <div className="current-runtime-line">
        <strong>
          {runtimePurposeNames[runtime.purpose ?? ""] ?? "当前运行"}
        </strong>
        <span className={live ? "runtime-live" : "runtime-muted"}>{state}</span>
      </div>
      <div className="current-runtime-line runtime-identity">
        <span>{runtimeToolNames[runtime.adapter] ?? runtime.adapter}</span>
        <span title={runtime.actual_model ?? runtime.requested_model}>
          {runtime.actual_model ?? "实际模型未确认"}
          {runtime.effort ? ` · ${runtime.effort}` : ""}
        </span>
      </div>
      {(!runtime.actual_model || mismatch) && runtime.requested_model && (
        <div className={mismatch ? "runtime-mismatch" : "runtime-muted"}>
          请求模型：{runtime.requested_model}
          {mismatch ? "（与实际模型不同）" : ""}
        </div>
      )}
      {activity && (
        <div className="runtime-action" aria-label="当前操作">
          <span>
            {activity.title}
            {runtime.active_tools > 1
              ? ` · ${runtime.active_tools} 项进行中`
              : ""}
          </span>
          {activity.command ? (
            <CommandPreview command={activity.command} cwd={activity.cwd} />
          ) : (
            <p className="activity-summary" title={activity.text}>
              {formatPathSummary(activity.text, 48)}
            </p>
          )}
        </div>
      )}
      <div className="runtime-muted">
        {age === undefined
          ? "尚未收到过程事件"
          : `最近活动：${age < 60 ? age + " 秒" : Math.floor(age / 60) + " 分钟"}前`}
      </div>
      <div className="runtime-quota" aria-label="运行账号额度">
        {quota?.buckets.length ? (
          <>
            {quota.buckets.map((bucket) => (
              <div key={bucket.id}>
                <span>
                  {runtime.adapter === "codex"
                    ? "Codex 账号共享额度"
                    : "运行账号额度"}
                  {bucket.id !== "codex"
                    ? ` · ${bucket.label ?? bucket.id}`
                    : ""}
                  ：
                </span>
                {bucket.windows.map((window, index) => (
                  <div className="runtime-quota-window" key={index}>
                    <span>
                      {window.window_minutes === 10080
                        ? "7 天"
                        : window.window_minutes % 60 === 0
                          ? `${window.window_minutes / 60} 小时`
                          : `${window.window_minutes} 分钟`}
                      窗口
                    </span>
                    <strong>
                      剩余 {Math.round((100 - window.used_percent) * 10) / 10}%
                    </strong>
                    {window.resets_at && (
                      <span>
                        重置：
                        {new Date(window.resets_at * 1000).toLocaleString(
                          "zh-CN",
                          {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
            <small className="runtime-muted">
              {stale ? "上次读取，待更新" : "会话实测"} ·{" "}
              {new Date(quota.observed_at).toLocaleTimeString("zh-CN")}
            </small>
          </>
        ) : (
          <span className="runtime-muted">
            额度：当前工具尚未提供可核实的数据
          </span>
        )}
      </div>
    </section>
  );
}
