import React, { useState, useRef, useEffect } from "react";
import type { CreditQuota, CreditQuotaStatus } from "../../../../packages/contracts/src/run-observation.js";
import "./quota-popover.css";

export interface QuotaWindowData {
  windowMinutes: number; // 300 或 10080
  remainingPercent: number | null; // 0 - 100
  resetsAt?: number; // epoch seconds
  isShared?: boolean;
}

export interface QuotaPopoverProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerLabel?: string;
  categoryLabel?: string;
  showUnknownWindows?: boolean;
  weeklyData?: QuotaWindowData | null;
  fiveHourData?: QuotaWindowData | null;
  isStale?: boolean;
  isShared?: boolean;
  creditQuota?: { status?: CreditQuotaStatus; value?: CreditQuota; observedAt?: string };
}

function formatResetTime(resetsAtEpochSeconds?: number): string {
  if (!resetsAtEpochSeconds) return "";
  const diffMs = resetsAtEpochSeconds * 1000 - Date.now();
  if (diffMs <= 0) return "即将重置";
  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  const days = Math.floor(diffMinutes / (24 * 60));
  const hours = Math.floor((diffMinutes % (24 * 60)) / 60);
  const minutes = diffMinutes % 60;
  if (days > 0) {
    return `${days}天${hours}小时后重置`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes}分钟后重置`;
  }
  return `${minutes}分钟后重置`;
}

function ProgressRing({ percent }: { percent: number | null }) {
  if (percent === null || Number.isNaN(percent)) {
    return (
      <svg className="quota-ring" width="22" height="22" viewBox="0 0 22 22">
        <circle
          cx="11"
          cy="11"
          r="9"
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="2.5"
        />
      </svg>
    );
  }

  const validPercent = Math.max(0, Math.min(100, percent));
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (validPercent / 100) * circumference;

  let strokeColor = "#10b981"; // 绿色
  if (validPercent < 20) {
    strokeColor = "#ef4444"; // 红色预警
  } else if (validPercent < 50) {
    strokeColor = "#f59e0b"; // 橙黄色提示
  }

  return (
    <svg className="quota-ring" width="22" height="22" viewBox="0 0 22 22">
      <circle
        cx="11"
        cy="11"
        r={radius}
        fill="none"
        stroke="#e2e8f0"
        strokeWidth="2.5"
      />
      <circle
        cx="11"
        cy="11"
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth="2.5"
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        transform="rotate(-90 11 11)"
      />
    </svg>
  );
}

/** 有真实数值才展示对应额度行；拿不到（如 20x Pro 无 5 小时限额）则整行隐藏。 */
type QuotaWindowWithData = QuotaWindowData & { remainingPercent: number };

function hasQuotaData(
  data?: QuotaWindowData | null,
): data is QuotaWindowWithData {
  return (
    !!data && typeof data.remainingPercent === "number" && Number.isFinite(data.remainingPercent)
  );
}

function QuotaRow({ title, data }: { title: string; data: QuotaWindowWithData }) {
  return (
    <div className="quota-row">
      <div className="quota-row-info">
        <div className="quota-row-title">{title}</div>
        <div className="quota-row-subtitle">
          {data.resetsAt ? formatResetTime(data.resetsAt) : "正常生效中"}
        </div>
      </div>
      <div className="quota-row-visual">
        <span className="quota-percent-text">
          {`${Math.round(data.remainingPercent)}%`}
        </span>
        <ProgressRing percent={data.remainingPercent} />
      </div>
    </div>
  );
}

function UnknownQuotaRow({ title }: { title: string }) {
  return (
    <div className="quota-row">
      <div className="quota-row-info">
        <div className="quota-row-title">{title}</div>
        <div className="quota-row-subtitle">待实测 / 暂不可用</div>
      </div>
      <div className="quota-row-visual">
        <span className="quota-percent-text">未知</span>
        <ProgressRing percent={null} />
      </div>
    </div>
  );
}

const creditMessages: Record<CreditQuotaStatus, string> = {
  available: "",
  stale: "额度可能已过期，显示上次读取结果",
  "auth-required": "请登录 CodeBuddy CLI 后重试",
  external: "当前模型使用外部服务额度",
  unsupported: "当前客户端或账号暂不支持查询积分",
  unavailable: "暂时无法查询积分，请稍后重试",
};
const creditNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });

function CreditQuotaRows({ status, value, observedAt }: NonNullable<QuotaPopoverProps["creditQuota"]>) {
  return (
    <div className="credit-quota">
      {value && (
        <>
          <div className="quota-row">
            <div className="quota-row-title">剩余积分</div>
            <strong>{creditNumber.format(value.remaining)} 积分</strong>
          </div>
          <div className="quota-row-subtitle">账号共享积分</div>
          {(value.total !== undefined || value.used !== undefined) && (
            <div className="quota-row-subtitle">
              {[
                value.total !== undefined ? `总计 ${creditNumber.format(value.total)}` : undefined,
                value.used !== undefined ? `已用 ${creditNumber.format(value.used)}` : undefined,
              ].filter(Boolean).join(" · ")}
            </div>
          )}
          {value.packages.length > 1 && value.packages.map(pkg => (
            <div className="quota-row" key={pkg.code}>
              <span>{pkg.name ?? pkg.code}</span>
              <span>{creditNumber.format(pkg.remaining)} 积分</span>
            </div>
          ))}
          {observedAt && (
            <div className="quota-row-subtitle">更新于 {new Date(observedAt).toLocaleString()}</div>
          )}
        </>
      )}
      {!status || creditMessages[status] ? (
        <div className="quota-row-subtitle">{status ? creditMessages[status] : "正在读取积分…"}</div>
      ) : null}
    </div>
  );
}

export function QuotaPopover({
  open,
  onOpenChange,
  triggerLabel = "查看额度",
  categoryLabel,
  showUnknownWindows = false,
  weeklyData,
  fiveHourData,
  isStale = false,
  isShared = false,
  creditQuota,
}: QuotaPopoverProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = open ?? localOpen;
  const setIsOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  const [isPinned, setIsPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) setIsPinned(false);
  }, [isOpen]);
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  const handleMouseEnter = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    if (isPinned) return;
    hoverTimer.current = window.setTimeout(() => {
      setIsOpen(false);
    }, 180);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const next = !isPinned;
    setIsPinned(next);
    setIsOpen(next);
  };

  useEffect(() => {
    function handleDocumentClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsPinned(false);
        setIsOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        setIsPinned(false);
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleDocumentClick);
      window.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("mousedown", handleDocumentClick);
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }, [isOpen]);

  return (
    <div
      className="quota-popover-wrapper"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`quota-trigger-btn ${isOpen ? "is-active" : ""}`}
        onClick={handleClick}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-expanded={isOpen}
      >
        {/* 简洁仪表盘线性图标 */}
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 12.5A7 7 0 1 1 13.5 12.5" />
          <path d="M8 8l2.5-3" />
        </svg>
      </button>

      {isOpen && (
        <div className="quota-popover-content" ref={popoverRef} role="tooltip">
          {categoryLabel && (
            <div className="quota-category-title" style={{ fontSize: "12px", fontWeight: "600", color: "#1e293b", paddingBottom: "6px", marginBottom: "6px", borderBottom: "1px solid #e2e8f0" }}>
              {categoryLabel}
            </div>
          )}
          {creditQuota ? <CreditQuotaRows {...creditQuota} /> : <>
          {/* AGY 固定展示两个窗口；其他工具保留没有限额时隐藏该行的行为。 */}
          {hasQuotaData(weeklyData) ? (
            <QuotaRow title="周额度剩余" data={weeklyData} />
          ) : showUnknownWindows ? <UnknownQuotaRow title="周额度剩余" /> : null}
          {hasQuotaData(fiveHourData) ? (
            <QuotaRow title="5小时额度剩余" data={fiveHourData} />
          ) : showUnknownWindows ? <UnknownQuotaRow title="5小时额度剩余" /> : null}
          {!showUnknownWindows && !hasQuotaData(weeklyData) && !hasQuotaData(fiveHourData) && (
            <div className="quota-row-subtitle">暂无额度数据</div>
          )}

          {/* 共享说明或状态提示 */}
          {isShared && (
            <div className="quota-shared-notice">当前模型使用账号共享额度</div>
          )}

          {isStale && (
            <div className="quota-stale-notice">额度数据可能已过期，待更新</div>
          )}
          </>}
        </div>
      )}
    </div>
  );
}
