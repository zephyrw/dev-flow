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
  const buckets =
    runtime.adapter === "codex"
      ? quota?.buckets.filter(
          (bucket: any) => bucket.model === model || bucket.id === model,
        )
      : quota?.buckets;
  const relevantBuckets = buckets?.length
    ? buckets
    : quota?.buckets?.filter((bucket: any) => bucket.id === "codex");

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

  // 解析周额度与5小时额度
  let weeklyData: QuotaWindowData | null = null;
  let fiveHourData: QuotaWindowData | null = null;

  if (relevantBuckets) {
    for (const bucket of relevantBuckets) {
      for (const window of bucket.windows ?? []) {
        const remainingPercent =
          typeof window.used_percent === "number" &&
          !Number.isNaN(window.used_percent)
            ? Math.max(0, Math.min(100, 100 - window.used_percent))
            : null;
        const data: QuotaWindowData = {
          windowMinutes: window.window_minutes,
          remainingPercent,
          resetsAt: window.resets_at,
          isShared: runtime.adapter === "codex",
        };
        if (window.window_minutes === 10080 || window.window_minutes > 1440) {
          if (!weeklyData || window.window_minutes === 10080) {
            weeklyData = data;
          }
        } else if (
          window.window_minutes === 300 ||
          window.window_minutes <= 360
        ) {
          if (!fiveHourData || window.window_minutes === 300) {
            fiveHourData = data;
          }
        }
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
