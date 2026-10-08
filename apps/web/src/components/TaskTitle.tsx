import React, { useState } from "react";
import { createPortal } from "react-dom";

/** Show the full name only when the rendered task title is truncated. */
export function TaskTitle({ title, className, as: Tag = "span" }: {
  title: string;
  className?: string;
  as?: "span" | "h3";
}) {
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const show = (element: HTMLElement) => {
    if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.min(420, window.innerWidth - 16) - 8)),
      top: Math.min(rect.bottom + 6, window.innerHeight - 100),
    });
  };
  return <>
    <Tag className={className} title={title}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={() => setPosition(undefined)}
    >{title}</Tag>
    {position && createPortal(
      <div className="task-title-tooltip" role="tooltip" style={position}>{title}</div>,
      document.body,
    )}
  </>;
}
