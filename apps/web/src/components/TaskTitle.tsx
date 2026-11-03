import React, { useId, useState } from "react";
import { createPortal } from "react-dom";

/** Show the full name only when the rendered task title is truncated. */
export function TaskTitle({ title, className, tooltip, as: Tag = "span" }: {
  title: string;
  className?: string;
  tooltip?: string;
  as?: "span" | "h3";
}) {
  const tooltipId = useId();
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const show = (element: HTMLElement) => {
    if (!tooltip && element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(420, window.innerWidth - 16) - 8)),
      top: Math.min(rect.bottom + 6, window.innerHeight - 100),
    });
  };
  return <>
    <Tag className={className} tabIndex={tooltip ? 0 : undefined} aria-describedby={position ? tooltipId : undefined}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={() => setPosition(undefined)}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={() => setPosition(undefined)}
    >{title}</Tag>
    {position && createPortal(
      <div id={tooltipId} className="task-title-tooltip" role="tooltip" style={position}>{tooltip ?? title}</div>,
      document.body,
    )}
  </>;
}
