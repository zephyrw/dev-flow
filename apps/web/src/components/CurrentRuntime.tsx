import React, { useEffect, useState } from "react";
import type { CreditQuotaStatus, QuotaBucket, RunObservation } from "../../../../packages/contracts/src/run-observation.js";
import { runtimeToolNames, visibleRunObservation } from "../../../../packages/presentation/src/run-observation.js";
import { projectRoleRuntime } from "../../../../packages/presentation/src/role-runtime.js";
import { effectiveRuntimeQuotaWindows } from "../../../../packages/presentation/src/agy-accounts.js";
import { QuotaPopover, QuotaWindowData } from "./QuotaPopover.js";
import { getAgyModelCategory } from "../../../../packages/adapters/agy/src/model-configuration.js";
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

function RuntimeQuota({
  detail,
  connected,
  adapterId,
  modelId,
  label,
  now,
  role,
  open,
  onOpenChange,
}: {
  detail: any;
  connected: boolean;
  adapterId?: string | null;
  modelId?: string | null;
  label: string;
  now: number;
  role?: "planner" | "executor";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const observation = visibleRunObservation(detail);
  const workflowId = detail?.workflow?.id;
  const profile = detail?.execution_spec?.spec?.[role === "planner" ? "plannerProfile" : "executorProfile"];
  const identity = JSON.stringify([workflowId, role, adapterId, modelId, profile]);
  const [account, setAccount] = useState<{ identity: string; quota: RunObservation["quota"] | null; creditStatus?: CreditQuotaStatus }>();
  const isCodeBuddy = adapterId === "codebuddy-code";
  useEffect(() => {
    if (!workflowId || !role || !["codex", "agy", "codebuddy-code"].includes(adapterId ?? "")) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const signal = isCodeBuddy
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)])
          : controller.signal;
        const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/quota?role=${role}`, { signal });
        const result = response.ok ? await response.json() : null;
        if (controller.signal.aborted) return;
        if (result && result.adapter === adapterId && result.model === modelId && (!isCodeBuddy || result.credit_status)) {
          setAccount({ identity, quota: result.quota, creditStatus: result.credit_status });
        } else if (isCodeBuddy) {
          throw new Error("CodeBuddy quota request failed");
        }
      } catch {
        // Only the server can confirm a cached balance still belongs to the active account.
        if (isCodeBuddy && !controller.signal.aborted) {
          setAccount({ identity, quota: null, creditStatus: "unavailable" });
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 15000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [identity, workflowId, role, adapterId, modelId, isCodeBuddy]);
  const accountQuota = account?.identity === identity ? account.quota : undefined;
  const quota = accountQuota !== undefined ? accountQuota : observation && observation.adapter === adapterId
      ? observation.quota : undefined;
  const activeModel = modelId;

  const isAgy = adapterId === "agy";
  const agyCategory = isAgy ? getAgyModelCategory(activeModel) : undefined;
  const categoryLabel = isAgy
    ? agyCategory === "gemini"
      ? "Gemini 额度"
      : agyCategory === "other" ? "Claude / GPT 额度" : "AGY 额度（类别待确认）"
    : undefined;

  const modelBuckets =
    quota?.buckets.filter((bucket) => {
      if (!activeModel) return false;
      if (isAgy) {
        // A real global constraint does not replace the model category display.
        if (bucket.id.toLowerCase() === "global") return false;
        if (bucket.model && bucket.model !== activeModel) return false;
        const poolCategory =
          bucket.id.toLowerCase().includes("claude") || bucket.id.toLowerCase().includes("gpt")
            ? "other"
            : bucket.id.toLowerCase().includes("gemini")
              ? "gemini"
              : undefined;
        if (poolCategory && poolCategory === agyCategory) return true;
      }
      if (bucket.model === activeModel || bucket.id === activeModel) return true;
      return false;
    }) ?? [];

  const sharedBuckets =
    adapterId === "codex"
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
    (!accountQuota && (!connected ||
    ["exited", "error"].includes(observation?.status ?? "") ||
    ![
      "PLANNING",
      "EXECUTING",
      "REVIEWING",
      "INTEGRATING",
      "QUEUED",
      "QUALITY_REVIEW",
    ].includes(detail?.workflow?.state)));

  // 解析周额度与 5 小时额度
  let weeklyData: QuotaWindowData | null = null;
  let fiveHourData: QuotaWindowData | null = null;

  if (matchedBucket?.windows) {
    for (const window of effectiveRuntimeQuotaWindows(matchedBucket, adapterId ?? "", quota?.observed_at ?? "", now)) {
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
    <div className="runtime-quota-wrapper">
      <QuotaPopover
        open={open}
        onOpenChange={onOpenChange}
        triggerLabel={`查看${label}工具额度`}
        categoryLabel={`${label} · ${adapterId ? runtimeToolNames[adapterId] ?? adapterId : "未配置工具"}${categoryLabel ? ` · ${categoryLabel}` : ""}`}
        showUnknownWindows={isAgy}
        weeklyData={weeklyData}
        fiveHourData={fiveHourData}
        isStale={Boolean(quota && stale)}
        isShared={isBucketShared}
        creditQuota={isCodeBuddy ? {
          status: account?.identity === identity
            ? stale && account.creditStatus === "available" ? "stale" : account.creditStatus
            : undefined,
          value: accountQuota?.credits,
          observedAt: accountQuota?.observed_at,
        } : undefined}
      />
    </div>
  );
}

export function CurrentRuntime({ detail, connected, onEdit }: {
  detail: any;
  connected: boolean;
  onEdit?: (role?: string) => void;
}) {
  const [openQuota, setOpenQuota] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const { plannerRow, executorRow, compactBadge, quotaTarget } = projectRoleRuntime(detail, { connected });
  return (
    <section className="current-runtime" aria-label="当前工具与模型">
      <div className="runtime-rows-container">
        {/* 上行：固定代表规划配置 */}
        <div className="runtime-model-row" data-role="planner">
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
        <RuntimeQuota detail={detail} connected={connected} now={now}
          adapterId={plannerRow.adapterId} modelId={plannerRow.modelId} label="规划" role="planner" open={openQuota === "planner"}
          onOpenChange={open => setOpenQuota(current => open ? "planner" : current === "planner" ? null : current)} />
        </div>

        {/* 下行：固定代表执行配置 */}
        <div className="runtime-model-row" data-role="executor">
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
        <RuntimeQuota detail={detail} connected={connected} now={now}
          adapterId={executorRow.adapterId} modelId={executorRow.modelId} label="执行" role="executor" open={openQuota === "executor"}
          onOpenChange={open => setOpenQuota(current => open ? "executor" : current === "executor" ? null : current)} />
        </div>
      </div>

      {/* 独立复核/修复紧凑标识 */}
      {compactBadge && (
        <div className="runtime-model-row" data-role={compactBadge.role}>
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
        {quotaTarget?.adapter !== "codebuddy-code" && <RuntimeQuota detail={detail} connected={connected} now={now}
          adapterId={quotaTarget?.adapter} modelId={quotaTarget?.model} label={compactBadge.label} open={openQuota === "compact"}
          onOpenChange={open => setOpenQuota(current => open ? "compact" : current === "compact" ? null : current)} />}
        </div>
      )}
    </section>
  );
}
