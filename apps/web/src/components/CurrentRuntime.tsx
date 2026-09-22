import React, { useEffect, useState } from "react";
import { visibleRunObservation } from "../../../../packages/presentation/src/run-observation.js";
import { formatRuntimeDisplay } from "../../../../packages/presentation/src/model-display.js";
import { QuotaPopover, QuotaWindowData } from "./QuotaPopover.js";
import "./current-runtime.css";

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

  const model = runtime.actual_model ?? runtime.requested_model;
  const displayText = formatRuntimeDisplay(
    runtime.adapter,
    model,
    runtime.effort,
  );

  const quota = runtime.quota;

  // 确定当前运行对应的模型/账号额度来源，避免多桶覆盖或顺序影响
  let matchedBucket: any = null;
  if (quota?.buckets && quota.buckets.length > 0) {
    matchedBucket =
      quota.buckets.find((b: any) => (model && (b.model === model || b.id === model))) ??
      quota.buckets.find((b: any) => b.is_shared === true || b.id === runtime.adapter || (runtime.adapter === "codex" && b.id === "codex")) ??
      null;
  }

  const isBucketShared = Boolean(
    matchedBucket?.is_shared === true ||
    matchedBucket?.id === "codex" ||
    (matchedBucket && model && matchedBucket.model !== model && matchedBucket.id !== model)
  );

  const stale =
    !quota ||
    now - Date.parse(quota.observed_at) > 120000 ||
    !connected ||
    ["exited", "error"].includes(runtime.status) ||
    ![
      "PLANNING",
      "EXECUTING",
      "REVIEWING",
      "INTEGRATING",
      "PLANNER_TAKEOVER",
    ].includes(detail?.workflow?.state);

  // 解析周额度（严格 10080 分钟）与 5 小时额度（严格 300 分钟），缺失不展示其他周期
  let weeklyData: QuotaWindowData | null = null;
  let fiveHourData: QuotaWindowData | null = null;

  if (matchedBucket?.windows) {
    for (const window of matchedBucket.windows) {
      const winMins = window.window_minutes ?? window.duration_minutes;
      const remainingPercent =
        typeof window.used_percent === "number" &&
        !Number.isNaN(window.used_percent)
          ? Math.max(0, Math.min(100, 100 - window.used_percent))
          : null;
      const data: QuotaWindowData = {
        windowMinutes: winMins,
        remainingPercent,
        resetsAt: window.resets_at,
        isShared: isBucketShared,
      };
      if (winMins === 10080) {
        weeklyData = data;
      } else if (winMins === 300) {
        fiveHourData = data;
      }
    }
  }

  const handleEditClick = () => {
    if (!onEdit) return;
    const run = detail.runs?.find((item: any) => item.id === runtime.run_id);
    onEdit(
      run?.routing_role ??
        (runtime.purpose === "quality_review"
          ? "reviewer"
          : runtime.purpose === "functional_fix"
            ? "functional_fixer"
            : undefined),
    );
  };

  return (
    <section className="current-runtime" aria-label="当前工具与模型">
      <button
        type="button"
        className="runtime-model-trigger"
        onClick={handleEditClick}
        title="点击调整模型与强度"
      >
        <span className="runtime-model-name">{displayText}</span>
      </button>

      <QuotaPopover
        weeklyData={weeklyData}
        fiveHourData={fiveHourData}
        isStale={Boolean(stale)}
        isShared={runtime.adapter === "codex"}
      />
    </section>
  );
}
