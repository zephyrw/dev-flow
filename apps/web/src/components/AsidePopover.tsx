import React, { useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  asidePositionLabel,
  asideStatusLabel,
  isAsideNavDisabled,
  isPendingAsideStatus,
  promoteButtonLabel,
  showAsideSourceWorkflow,
  type AsideDetail,
  type ProjectAsidePosition,
  type ProjectAsideSummary,
} from "../use-project-asides.js";
import "./aside-popover.css";

export function AsidePopover({
  currentWorkflowId,
  summary,
  detail,
  position,
  error,
  hasNew,
  busy,
  onClose,
  onPrev,
  onNext,
  onCancel,
  onPromote,
  onShowLatest,
}: {
  currentWorkflowId: string;
  summary: ProjectAsideSummary;
  detail: AsideDetail | null;
  position: ProjectAsidePosition | null;
  error?: string;
  hasNew?: boolean;
  busy?: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCancel: () => void;
  onPromote: () => void;
  onShowLatest: () => void;
}) {
  const status = detail?.status ?? summary.status;
  const waiting = isPendingAsideStatus(status);
  const failed = status === "expired";
  const showSource = showAsideSourceWorkflow(
    summary.workflow_id,
    currentWorkflowId,
  );
  const canPromote = status === "completed" && !!detail?.answer;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      className={"aside-popover" + (failed ? " is-failed" : "")}
      role="dialog"
      aria-modal="false"
      aria-labelledby="aside-popover-title"
      data-aside-popover=""
    >
      <header className="aside-popover-header">
        <h2 id="aside-popover-title" className="aside-popover-title">
          临时提问
          {showSource && (
            <span className="aside-popover-source">
              {" · "}
              {summary.workflow_title}
            </span>
          )}
        </h2>
        <div className="aside-popover-nav">
          <button
            type="button"
            aria-label="较新一条"
            disabled={isAsideNavDisabled("prev", position)}
            onClick={onPrev}
          >
            ‹
          </button>
          <span className="aside-popover-count">{asidePositionLabel(position)}</span>
          <button
            type="button"
            aria-label="较旧一条"
            disabled={isAsideNavDisabled("next", position)}
            onClick={onNext}
          >
            ›
          </button>
        </div>
        <button
          type="button"
          className="aside-popover-close"
          aria-label="关闭提问浮窗"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <div className="aside-popover-body">
        {hasNew && (
          <button
            type="button"
            className="aside-popover-new"
            onClick={onShowLatest}
          >
            有新问题
          </button>
        )}
        <div className="aside-popover-meta">
          <span className={"aside-status " + status}>{asideStatusLabel(status)}</span>
          <time>{new Date(summary.created_at).toLocaleString()}</time>
        </div>
        <h3>问</h3>
        <p className="aside-popover-question">
          {detail?.question ?? summary.question_preview}
        </p>
        <h3>答</h3>
        {status === "completed" && detail?.answer ? (
          <div className="aside-popover-answer">
            <Markdown remarkPlugins={[remarkGfm]}>{detail.answer}</Markdown>
          </div>
        ) : (
          <p role="status" className={failed ? "error" : "muted"}>
            {detail?.answer ?? asideStatusLabel(status)}
          </p>
        )}
        <div className="aside-popover-actions">
          {waiting && (
            <button type="button" disabled={busy} onClick={onCancel}>
              取消本次提问
            </button>
          )}
          {canPromote && (
            <button type="button" disabled={busy} onClick={onPromote}>
              {promoteButtonLabel(summary.workflow_title)}
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
