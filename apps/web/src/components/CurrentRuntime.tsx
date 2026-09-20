import React, { useEffect, useState } from "react";
import {
  visibleRunObservation,
  runtimeToolNames,
} from "../../../../packages/presentation/src/run-observation.js";
import "./current-runtime.css";
import "./model-settings.css";

export function CurrentRuntime({
  detail,
  connected,
  onEdit,
}: {
  detail: any;
  connected: boolean;
  onEdit?: (role?: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const runtime = visibleRunObservation(detail);
  if (!runtime) return null;
  const tool = runtimeToolNames[runtime.adapter] ?? runtime.adapter;
  const model = runtime.actual_model ?? runtime.requested_model;
  const modelDetails = [
    runtime.actual_model
      ? "实际模型：" + runtime.actual_model
      : runtime.requested_model && "运行配置模型：" + runtime.requested_model,
    runtime.effort && "推理强度：" + runtime.effort,
  ]
    .filter(Boolean)
    .join("；");
  const quota = runtime.quota;
  const buckets =
    runtime.adapter === "codex"
      ? quota?.buckets.filter(
          (bucket) => bucket.model === model || bucket.id === model,
        )
      : quota?.buckets;
  const relevantBuckets = buckets?.length
    ? buckets
    : quota?.buckets.filter((bucket) => bucket.id === "codex");
  const stale =
    quota &&
    (now - Date.parse(quota.observed_at) > 120000 ||
      !connected ||
      ["exited", "error"].includes(runtime.status) ||
      ![
        "PLANNING",
        "EXECUTING",
        "REVIEWING",
        "INTEGRATING",
        "PLANNER_TAKEOVER",
      ].includes(detail.workflow.state));
  const windows =
    relevantBuckets?.flatMap((bucket) =>
      bucket.windows.map((window) => {
        const period =
          window.window_minutes === 10080
            ? "周"
            : window.window_minutes % 60 === 0
              ? window.window_minutes / 60 + "h"
              : window.window_minutes + "min";
        const label =
          (relevantBuckets.length > 1
            ? (bucket.label ?? bucket.id) + " "
            : "") +
          period +
          "剩余 " +
          Math.round((100 - window.used_percent) * 10) / 10 +
          "%";
        return {
          label,
          detail:
            label +
            (window.resets_at
              ? "，重置：" +
                new Date(window.resets_at * 1000).toLocaleString("zh-CN")
              : ""),
        };
      }),
    ) ?? [];
  const quotaText = windows.length
    ? "额度：" +
      windows.map((window) => window.label).join(" / ") +
      (stale ? "（待更新）" : "")
    : "";
  const quotaDetails = windows.length
    ? (runtime.adapter === "codex" ? "Codex 账号共享额度" : "运行账号额度") +
      "；" +
      windows.map((window) => window.detail).join("；") +
      "；" +
      (stale
        ? "上次读取，待更新"
        : quota?.source === "account_api"
          ? "账号接口实测"
          : "会话实测") +
      "：" +
      new Date(quota!.observed_at).toLocaleString("zh-CN")
    : "";
  return (
    <section
      className="current-runtime"
      aria-label="当前工具与模型"
      title={[tool, modelDetails, quotaDetails].filter(Boolean).join("；")}
    >
      <span>{tool}</span>
      {model && (
        <>
          <span className="runtime-separator" aria-hidden="true">
            ·
          </span>
          <span title={modelDetails}>{model}</span>
        </>
      )}
      {onEdit && (
        <button
          type="button"
          className="runtime-edit-link"
          onClick={() => {
            const run = detail.runs?.find(
              (item: any) => item.id === runtime.run_id,
            );
            onEdit(
              run?.routing_role ??
                (runtime.purpose === "quality_review"
                  ? "reviewer"
                  : runtime.purpose === "functional_fix"
                    ? "functional_fixer"
                    : undefined),
            );
          }}
        >
          修改
        </button>
      )}
      {quotaText && (
        <>
          <span className="runtime-separator" aria-hidden="true">
            ·
          </span>
          <span aria-label="运行账号额度" title={quotaDetails}>
            {quotaText}
          </span>
        </>
      )}
    </section>
  );
}
