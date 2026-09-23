import React, { useEffect, useState } from "react";
import type { QuotaBucket } from "../../../../packages/contracts/src/run-observation.js";
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

  const modelBuckets = quota?.buckets.filter((bucket) =>
    model && (bucket.model ? bucket.model === model : bucket.id === model),
  ) ?? [];
  // "codex" without a model is the account-wide bucket from the Codex API.
  // An adapter name or a mismatching model is not evidence of a shared limit.
  const sharedBuckets = runtime.adapter === "codex"
    ? quota?.buckets.filter((bucket) => bucket.id === "codex" && !bucket.model) ?? []
    : [];
  const matchedBucket: QuotaBucket | undefined = modelBuckets.length === 1
    ? modelBuckets[0]
    : modelBuckets.length === 0 && sharedBuckets.length === 1
      ? sharedBuckets[0]
      : undefined;
  const isBucketShared = Boolean(matchedBucket && sharedBuckets.includes(matchedBucket));

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
      "QUEUED",
    ].includes(detail?.workflow?.state);

  // 解析周额度（严格 10080 分钟）与 5 小时额度（严格 300 分钟），缺失不展示其他周期
  let weeklyData: QuotaWindowData | null = null;
  let fiveHourData: QuotaWindowData | null = null;

  if (matchedBucket?.windows) {
    for (const window of matchedBucket.windows) {
      const winMins = window.window_minutes;
      const remainingPercent =
        typeof window.used_percent === "number" &&
        Number.isFinite(window.used_percent)
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
            : runtime.purpose === "executor_test"
              ? "executor"
              : runtime.purpose === "planner_commit" ||
                  runtime.purpose === "planner_takeover"
                ? "planner"
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
        isShared={isBucketShared}
      />
    </section>
  );
}
