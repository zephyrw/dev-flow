import React from "react";

export const DEFAULT_NAVIGATION_WIDTH = 312.5;
export const NAVIGATION_WIDTH_KEY = "devflow.navigationWidth";

export function readNavigationWidth(): number {
  try {
    const saved = Number(localStorage.getItem(NAVIGATION_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 220 && saved <= 560
      ? saved : DEFAULT_NAVIGATION_WIDTH;
  } catch {
    return DEFAULT_NAVIGATION_WIDTH;
  }
}

export function NavigationResizeHandle({ width, resize }: {
  width: number;
  resize: (width: number) => void;
}) {
  return <div
    className="navigation-resize-handle"
    role="separator"
    aria-label="调整任务导航宽度"
    aria-orientation="vertical"
    aria-valuemin={220}
    aria-valuemax={560}
    aria-valuenow={width}
    tabIndex={0}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        resize(width + (event.key === "ArrowRight" ? 20 : -20));
      }
    }}
    onPointerDown={(event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.dataset.startX = String(event.clientX);
      event.currentTarget.dataset.startWidth = String(width);
    }}
    onPointerMove={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        resize(Number(event.currentTarget.dataset.startWidth) + event.clientX -
          Number(event.currentTarget.dataset.startX));
      }
    }}
    onPointerUp={(event) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }}
  />;
}
