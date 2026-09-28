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
  shortResetText: string;
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
      shortResetText: "",
      isUnknown: true,
      isZero: false,
      isResetDue: false,
      statusClass: "unknown",
    };
  }

  const fraction = window.remaining_fraction;
  const pct = Math.round(fraction * 100);
  const isZero = fraction <= 0;
  const isFull = pct >= 100;

  let resetText = "—";
  let shortResetText = "";
  let isResetDue = false;

  // 判断是否应该显示重置时间：
  // 规则：
  // 1. 只有当前额度为 100% (isFull) 时才有可能没有重置时间；若小于 100%，一定有重置时间。
  // 2. 额度已经是 100% 时，绝不可能处于“待重置”状态！若当前时间已超过旧 reset_at (nowMs >= resetTime)，
  //    说明上一轮重置早已完成并已达满额，新会话尚未发生，计时器未开启，故没有重置时间。
  // 3. 若额度为 100% 且 resetTime 与观测时间差值接近满额周期（临时漂移占位时间），也没有重置时间。
  let hasValidReset = Boolean(window.reset_at);
  if (hasValidReset && isFull && window.reset_at) {
    const resetTime = Date.parse(window.reset_at);
    if (!Number.isNaN(resetTime)) {
      if (nowMs >= resetTime) {
        // 时间已过且额度已满(100%)：已重置完成，无需重置，未启动新会话倒计时，无重置时间
        hasValidReset = false;
      } else {
        const observedTime = window.observed_at ? Date.parse(window.observed_at) : NaN;
        if (!Number.isNaN(observedTime)) {
          const durationMs = window.kind === "weekly" ? 7 * 86400 * 1000 : 5 * 3600 * 1000;
          const diffMs = resetTime - observedTime;
          if (diffMs >= durationMs - 120_000) {
            hasValidReset = false;
          }
        }
      }
    }
  }

  if (hasValidReset && window.reset_at) {
    const resetTime = Date.parse(window.reset_at);
    if (!Number.isNaN(resetTime)) {
      if (nowMs >= resetTime) {
        // 倒计时已到期：不显示“待重置”标签，短文本置空
        isResetDue = !isFull;
        resetText = !isFull ? "预计已重置，待核验" : "—";
        shortResetText = "";
      } else {
        const diffSec = Math.max(0, Math.round((resetTime - nowMs) / 1000));
        if (diffSec >= 86400) {
          const days = Math.floor(diffSec / 86400);
          const hours = Math.floor((diffSec % 86400) / 3600);
          shortResetText = hours > 0 ? `${days}d${hours}h` : `${days}d`;
          resetText =
            hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
        } else if (diffSec >= 3600) {
          const hours = Math.floor(diffSec / 3600);
          const mins = Math.floor((diffSec % 3600) / 60);
          shortResetText = mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
          resetText =
            mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
        } else {
          const mins = Math.max(1, Math.floor(diffSec / 60));
          shortResetText = diffSec < 60 ? "<1m" : `${mins}m`;
          resetText = `${mins}分钟后重置`;
        }
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
    shortResetText,
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
