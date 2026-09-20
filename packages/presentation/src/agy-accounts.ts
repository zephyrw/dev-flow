import type {
  AgyAccountDto,
  AgyQuotaSnapshot,
  QuotaWindow,
} from "../../contracts/src/agy-account.js";

export interface QuotaWindowDisplay {
  label: string;
  percentageText: string;
  fraction: number | null;
  resetText: string;
  isUnknown: boolean;
  isZero: boolean;
  isResetDue: boolean;
  statusClass: "normal" | "warning" | "danger" | "unknown";
}

export function formatQuotaWindow(
  window: QuotaWindow | undefined,
  nowMs: number = Date.now(),
): QuotaWindowDisplay {
  if (
    !window ||
    window.status !== "observed" ||
    window.remaining_fraction === null
  ) {
    return {
      label: window?.kind === "weekly" ? "周额度" : "五小时额度",
      percentageText: "待补测",
      fraction: null,
      resetText: "—",
      isUnknown: true,
      isZero: false,
      isResetDue: false,
      statusClass: "unknown",
    };
  }

  const fraction = window.remaining_fraction;
  const pct = Math.round(fraction * 100);
  const isZero = fraction <= 0;

  let resetText = "—";
  let isResetDue = false;

  if (window.reset_at) {
    const resetTime = Date.parse(window.reset_at);
    if (!Number.isNaN(resetTime)) {
      if (nowMs >= resetTime) {
        isResetDue = true;
        resetText = "预计已重置，待核验";
      } else {
        const diffSec = Math.round((resetTime - nowMs) / 1000);
        const hours = Math.floor(diffSec / 3600);
        const mins = Math.floor((diffSec % 3600) / 60);
        resetText =
          hours > 0 ? `${hours}小时${mins}分后重置` : `${mins}分钟后重置`;
      }
    }
  }

  let statusClass: "normal" | "warning" | "danger" | "unknown" = "normal";
  if (isZero) statusClass = "danger";
  else if (pct < 25) statusClass = "warning";

  return {
    label: window.kind === "weekly" ? "周额度" : "五小时额度",
    percentageText: `${pct}%`,
    fraction,
    resetText,
    isUnknown: false,
    isZero,
    isResetDue,
    statusClass,
  };
}

export function formatAccountStateLabel(state: string): string {
  switch (state) {
    case "ready":
      return "正常";
    case "waiting_quota":
      return "额度等待中";
    case "pending_quota":
      return "待补测";
    case "reauth_required":
      return "需重新认证";
    case "disabled":
      return "已停用";
    case "incompatible":
      return "不兼容";
    default:
      return state;
  }
}
