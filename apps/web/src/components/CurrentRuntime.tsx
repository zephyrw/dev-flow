import React, { useEffect, useState } from "react";
import type { QuotaBucket } from "../../../../packages/contracts/src/run-observation.js";
import { visibleRunObservation } from "../../../../packages/presentation/src/run-observation.js";
import { projectRoleRuntime } from "../../../../packages/presentation/src/role-runtime.js";
import { QuotaPopover, QuotaWindowData } from "./QuotaPopover.js";
import "./current-runtime.css";

function BrainIcon() {
  return (
    <svg
      className="runtime-row-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04" />
    </svg>
  );
}

function ExecutorIcon() {
  return (
    <svg
      className="runtime-row-icon"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

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

  const runtimeView = projectRoleRuntime(detail, { connected });
  const { plannerRow, executorRow, compactBadge, quotaTarget } = runtimeView;

  const observation = visibleRunObservation(detail);
  const quota = observation && connected && runtimeView.activeRole &&
    observation?.adapter === quotaTarget?.adapter &&
    (observation.actual_model ?? observation.requested_model) === quotaTarget?.model
      ? observation.quota : undefined;
  const activeModel =
    quotaTarget?.model ??
    observation?.actual_model ??
    observation?.requested_model;

  const modelBuckets =
    quota?.buckets.filter((bucket) =>
      activeModel
        ? bucket.model
          ? bucket.model === activeModel
          : bucket.id === activeModel
        : false,
    ) ?? [];

  const sharedBuckets =
    observation?.adapter === "codex"
      ? quota?.buckets.filter(
          (bucket) => bucket.id === "codex" && !bucket.model,
        ) ?? []
      : [];

  const matchedBucket: QuotaBucket | undefined =
    modelBuckets.length === 1
      ? modelBuckets[0]
      : modelBuckets.length === 0 && sharedBuckets.length === 1
        ? sharedBuckets[0]
        : undefined;
  const isBucketShared = Boolean(
    matchedBucket && sharedBuckets.includes(matchedBucket),
  );

  const stale =
    !quota ||
    !Number.isFinite(Date.parse(quota.observed_at)) ||
    now - Date.parse(quota.observed_at) > 120000 ||
    !connected ||
    ["exited", "error"].includes(observation?.status ?? "") ||
    ![
      "PLANNING",
      "EXECUTING",
      "REVIEWING",
      "INTEGRATING",
      "QUEUED",
      "QUALITY_REVIEW",
    ].includes(detail?.workflow?.state);

  // 解析周额度与 5 小时额度
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

  return (
    <section className="current-runtime" aria-label="当前工具与模型">
      <div className="runtime-rows-container">
        {/* 上行：固定代表规划配置 */}
        <button
          type="button"
          className={`runtime-row-btn ${plannerRow.isActive ? "is-active" : "is-inactive"}`}
          onClick={() => onEdit?.("planner")}
          aria-label={`规划模型：${plannerRow.displayText}${plannerRow.activeReason ? `（${plannerRow.activeReason}）` : ""}`}
          title={
            plannerRow.tooltip ??
            (plannerRow.activeReason
              ? `规划配置（${plannerRow.activeReason}）`
              : "规划配置，点击调整")
          }
        >
          <BrainIcon />
          <span className="runtime-row-text">{plannerRow.displayText}</span>
          {plannerRow.activeReason && (
            <span className="runtime-row-tag">{plannerRow.activeReason}</span>
          )}
        </button>

        {/* 下行：固定代表执行配置 */}
        <button
          type="button"
          className={`runtime-row-btn ${executorRow.isActive ? "is-active" : "is-inactive"}`}
          onClick={() => onEdit?.("executor")}
          aria-label={`执行模型：${executorRow.displayText}${executorRow.activeReason ? `（${executorRow.activeReason}）` : ""}`}
          title={
            executorRow.tooltip ??
            (executorRow.activeReason
              ? `执行配置（${executorRow.activeReason}）`
              : "执行配置，点击调整")
          }
        >
          <ExecutorIcon />
          <span className="runtime-row-text">{executorRow.displayText}</span>
          {executorRow.activeReason && (
            <span className="runtime-row-tag">{executorRow.activeReason}</span>
          )}
        </button>
      </div>

      {/* 独立复核/修复紧凑标识 */}
      {compactBadge && (
        <button
          type="button"
          className="runtime-compact-badge is-active"
          onClick={() => onEdit?.(compactBadge.role)}
          title={compactBadge.tooltip}
          aria-label={`${compactBadge.label}：${compactBadge.displayText}`}
        >
          <span className="runtime-badge-label">{compactBadge.label}</span>
          <span className="runtime-badge-text">{compactBadge.displayText}</span>
        </button>
      )}

      {/* 额度入口 */}
      <div
        className="runtime-quota-wrapper"
        title={quotaTarget?.description}
        aria-label={quotaTarget?.description}
      >
        <QuotaPopover
          weeklyData={weeklyData}
          fiveHourData={fiveHourData}
          isStale={Boolean(stale)}
          isShared={isBucketShared}
        />
      </div>
    </section>
  );
}
