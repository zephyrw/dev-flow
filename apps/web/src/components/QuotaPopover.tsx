import React, { useState, useRef, useEffect } from "react";
import "./quota-popover.css";

export interface QuotaWindowData {
  windowMinutes: number; // 300 或 10080
  remainingPercent: number | null; // 0 - 100
  resetsAt?: number; // epoch seconds
  isShared?: boolean;
}

export interface QuotaPopoverProps {
  weeklyData?: QuotaWindowData | null;
  fiveHourData?: QuotaWindowData | null;
  isStale?: boolean;
  isShared?: boolean;
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

export function QuotaPopover({
  weeklyData,
  fiveHourData,
  isStale = false,
  isShared = false,
}: QuotaPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const hoverTimer = useRef<number | null>(null);

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
    setIsPinned((prev) => {
      const next = !prev;
      setIsOpen(next);
      return next;
    });
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
        aria-label="查看额度"
        title="查看额度"
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
          {/* 第一行：周额度 */}
          <div className="quota-row">
            <div className="quota-row-info">
              <div className="quota-row-title">周额度剩余</div>
              <div className="quota-row-subtitle">
                {weeklyData?.resetsAt
                  ? formatResetTime(weeklyData.resetsAt)
                  : isStale
                    ? "待更新"
                    : weeklyData?.remainingPercent !== null && weeklyData?.remainingPercent !== undefined
                      ? "正常生效中"
                      : "暂不可用"}
              </div>
            </div>
            <div className="quota-row-visual">
              <span className="quota-percent-text">
                {weeklyData?.remainingPercent !== null && weeklyData?.remainingPercent !== undefined
                  ? `${Math.round(weeklyData.remainingPercent)}%`
                  : "--"}
              </span>
              <ProgressRing
                percent={
                  weeklyData?.remainingPercent !== null && weeklyData?.remainingPercent !== undefined
                    ? weeklyData.remainingPercent
                    : null
                }
              />
            </div>
          </div>

          {/* 第二行：5小时额度 */}
          <div className="quota-row">
            <div className="quota-row-info">
              <div className="quota-row-title">5小时额度剩余</div>
              <div className="quota-row-subtitle">
                {fiveHourData?.resetsAt
                  ? formatResetTime(fiveHourData.resetsAt)
                  : isStale
                    ? "待更新"
                    : fiveHourData?.remainingPercent !== null && fiveHourData?.remainingPercent !== undefined
                      ? "正常生效中"
                      : "暂不可用"}
              </div>
            </div>
            <div className="quota-row-visual">
              <span className="quota-percent-text">
                {fiveHourData?.remainingPercent !== null && fiveHourData?.remainingPercent !== undefined
                  ? `${Math.round(fiveHourData.remainingPercent)}%`
                  : "--"}
              </span>
              <ProgressRing
                percent={
                  fiveHourData?.remainingPercent !== null && fiveHourData?.remainingPercent !== undefined
                    ? fiveHourData.remainingPercent
                    : null
                }
              />
            </div>
          </div>

          {/* 共享说明或状态提示 */}
          {isShared && (
            <div className="quota-shared-notice">当前模型使用账号共享额度</div>
          )}

          {isStale && (
            <div className="quota-stale-notice">额度数据可能已过期，待更新</div>
          )}
        </div>
      )}
    </div>
  );
}
