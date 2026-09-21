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

export function formatAuthHealthDisplay(auth?: {
  access_expires_at?: string;
  refresh_expires_at?: string;
  last_authenticated_request_at?: string;
  last_refresh_verified_at?: string;
  has_refresh_credential?: boolean | null;
  metadata_status?: string;
}) {
  const hasRefresh = auth?.has_refresh_credential;
  const refreshExpiry = auth?.refresh_expires_at;

  return {
    accessExpiryText: auth?.access_expires_at
      ? new Date(auth.access_expires_at).toLocaleString("zh-CN")
      : "未知",
    refreshExpiryText: refreshExpiry
      ? new Date(refreshExpiry).toLocaleString("zh-CN")
      : "未知（官方未提供有效期）",
    refreshPresenceText:
      hasRefresh === true
        ? "已提供"
        : hasRefresh === false
          ? "未提供"
          : "未知",
    lastAuthText: auth?.last_authenticated_request_at
      ? new Date(auth.last_authenticated_request_at).toLocaleString("zh-CN")
      : "无记录",
    lastRefreshVerifiedText: auth?.last_refresh_verified_at
      ? new Date(auth.last_refresh_verified_at).toLocaleString("zh-CN")
      : "未验证",
  };
}

export function formatRecoveryProgressDisplay(state: string): {
  label: string;
  badgeClass: "info" | "warning" | "success" | "danger";
} {
  switch (state) {
    case "preserved":
      return { label: "已保全", badgeClass: "info" };
    case "resume_pending":
      return { label: "恢复已安排 (原会话)", badgeClass: "info" };
    case "recreate_pending":
      return { label: "恢复已安排 (新建根)", badgeClass: "info" };
    case "running_observed":
      return { label: "实际运行已观察", badgeClass: "success" };
    case "waiting_dependency":
      return { label: "等待依赖", badgeClass: "warning" };
    case "waiting_access":
      return { label: "等待模型访问核验", badgeClass: "warning" };
    case "manual_required":
      return { label: "需人工介入", badgeClass: "danger" };
    case "completed":
      return { label: "目标已完成", badgeClass: "success" };
    case "superseded":
      return { label: "已由新意图替代", badgeClass: "warning" };
    default:
      return { label: state, badgeClass: "info" };
  }
}
