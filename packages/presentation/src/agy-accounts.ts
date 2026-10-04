import type {
  AgyAccountDto,
  AgyQuotaSnapshot,
  QuotaWindow,
} from "../../contracts/src/agy-account.js";
import { hasDualQuotaWindows, computeEffectiveWeeklyQuota } from "../../agy-accounts/src/quota.js";
import type { QuotaBucket } from "../../contracts/src/run-observation.js";

/** Convert only a complete AGY model bucket; other adapters retain their own window semantics. */
export function effectiveRuntimeQuotaWindows(
  bucket: QuotaBucket, adapter: string, observedAt: string, nowMs = Date.now(),
): QuotaBucket["windows"] {
  if (adapter !== "agy") return bucket.windows;
  const windows: QuotaWindow[] = bucket.windows.map(window => ({
    kind: window.window_minutes === 10080 ? "weekly" : "five_hour",
    duration_minutes: window.window_minutes === 10080 ? 10080 : 300,
    remaining_fraction: Number.isFinite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100
      ? (100 - window.used_percent) / 100 : null,
    reset_at: window.resets_at === undefined ? null
      : Number.isFinite(window.resets_at) && Math.abs(window.resets_at * 1000) <= 8640000000000000
        ? new Date(window.resets_at * 1000).toISOString() : "invalid",
    observed_at: observedAt,
    status: Number.isFinite(window.used_percent) ? "observed" : "missing",
  }));
  if (!hasDualQuotaWindows(windows) || !bucket.windows.every(w => [300, 10080].includes(w.window_minutes))) return bucket.windows;
  return bucket.windows.map((window, index) => {
    if (window.window_minutes !== 10080) return window;
    const effective = computeEffectiveWeeklyQuota(windows[index], nowMs);
    return effective.isValid && effective.fraction === 1
      ? { ...window, used_percent: 0, resets_at: undefined } : window;
  });
}

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
  allowWeeklyResetProjection: boolean = true,
): QuotaWindowDisplay {
  if (
    !window ||
    window.status !== "observed" ||
    window.remaining_fraction === null ||
    typeof window.remaining_fraction !== "number" ||
    !Number.isFinite(window.remaining_fraction) ||
    window.remaining_fraction < 0 ||
    window.remaining_fraction > 1
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

  // 检查非空非法时间：非空非法时间不能误变满额
  let isResetAtInvalid = false;
  let resetTime = NaN;
  if (window.reset_at) {
    resetTime = Date.parse(window.reset_at);
    if (Number.isNaN(resetTime)) {
      isResetAtInvalid = true;
    }
  }

  if (isResetAtInvalid) {
    const fraction = window.remaining_fraction;
    const pct = Math.round(fraction * 100);
    const isZero = fraction <= 0;
    return {
      label: window.kind === "weekly" ? "周额度" : "五小时额度",
      percentageText: `${pct}%`,
      fraction,
      resetText: "—",
      shortResetText: "",
      isUnknown: false,
      isZero,
      isResetDue: false,
      statusClass: isZero ? "danger" : pct < 25 ? "warning" : "normal",
    };
  }

  // 周额度窗口：规则：没有重置时间或已到期（包括等于边界）则恢复 100%
  if (window.kind === "weekly") {
    const isNoReset = !window.reset_at;
    const isPastOrEqualReset = Number.isFinite(resetTime) && nowMs >= resetTime;

    const effective = computeEffectiveWeeklyQuota(window, nowMs);
    if (allowWeeklyResetProjection && effective.isValid && effective.fraction === 1 && (isNoReset || isPastOrEqualReset)) {
      return {
        label: "周额度",
        percentageText: "100%",
        fraction: 1,
        resetText: "—",
        shortResetText: "",
        isUnknown: false,
        isZero: false,
        isResetDue: false,
        statusClass: "normal",
      };
    }

    // 无效快照保留原始额度；仅未来的合法时间显示倒计时。
    const fraction = window.remaining_fraction;
    const pct = Math.round(fraction * 100);
    const isZero = fraction <= 0;
    const isFull = pct >= 100;

    let resetText = "—";
    let shortResetText = "";
    let hasValidReset = !isNoReset && !isPastOrEqualReset;

    // 满额漂移时间检查
    if (isFull) {
      const observedTime = window.observed_at ? Date.parse(window.observed_at) : NaN;
      if (!Number.isNaN(observedTime)) {
        const durationMs = 7 * 86400 * 1000;
        const diffMs = resetTime - observedTime;
        if (diffMs >= durationMs - 120_000) {
          hasValidReset = false;
        }
      }
    }

    if (hasValidReset) {
      const diffSec = Math.max(0, Math.round((resetTime - nowMs) / 1000));
      if (diffSec >= 86400) {
        const days = Math.floor(diffSec / 86400);
        const hours = Math.floor((diffSec % 86400) / 3600);
        shortResetText = hours > 0 ? `${days}d${hours}h` : `${days}d`;
        resetText = hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
      } else if (diffSec >= 3600) {
        const hours = Math.floor(diffSec / 3600);
        const mins = Math.floor((diffSec % 3600) / 60);
        shortResetText = mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
        resetText = mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
      } else {
        const mins = Math.max(1, Math.floor(diffSec / 60));
        shortResetText = diffSec < 60 ? "<1m" : `${mins}m`;
        resetText = `${mins}分钟后重置`;
      }
    }

    let statusClass: "normal" | "warning" | "danger" | "unknown" = "normal";
    if (isZero) statusClass = "danger";
    else if (pct < 25) statusClass = "warning";

    return {
      label: "周额度",
      percentageText: `${pct}%`,
      fraction,
      resetText,
      shortResetText,
      isUnknown: false,
      isZero,
      isResetDue: false,
      statusClass,
    };
  }

  // 五小时额度窗口：保持已有逻辑
  const fraction = window.remaining_fraction;
  const pct = Math.round(fraction * 100);
  const isZero = fraction <= 0;
  const isFull = pct >= 100;

  let resetText = "—";
  let shortResetText = "";
  let isResetDue = false;

  let hasValidReset = Boolean(window.reset_at);
  if (hasValidReset && isFull && window.reset_at) {
    if (nowMs >= resetTime) {
      hasValidReset = false;
    } else {
      const observedTime = window.observed_at ? Date.parse(window.observed_at) : NaN;
      if (!Number.isNaN(observedTime)) {
        const durationMs = 5 * 3600 * 1000;
        const diffMs = resetTime - observedTime;
        if (diffMs >= durationMs - 120_000) {
          hasValidReset = false;
        }
      }
    }
  }

  if (hasValidReset && window.reset_at) {
    if (nowMs >= resetTime) {
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

  let statusClass: "normal" | "warning" | "danger" | "unknown" = "normal";
  if (isZero) statusClass = "danger";
  else if (pct < 25) statusClass = "warning";

  return {
    label: "五小时额度",
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

export function formatSnapshotQuotaWindow(
  snapshot: Pick<AgyQuotaSnapshot, "windows" | "capability_verified"> | undefined,
  kind: QuotaWindow["kind"],
  nowMs: number = Date.now(),
): QuotaWindowDisplay {
  const window = snapshot?.windows.find((w) => w.kind === kind);
  // 与服务公开视图采用同一完整性边界，防止原始窗口在页面再次投影满额。
  const allowWeeklyResetProjection = !!snapshot &&
    snapshot.capability_verified !== false && hasDualQuotaWindows(snapshot.windows);
  return formatQuotaWindow(window, nowMs, allowWeeklyResetProjection);
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
