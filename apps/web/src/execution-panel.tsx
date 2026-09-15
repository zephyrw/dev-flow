import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LogEntry } from "./logs.js";

export function ExecutionPanel({
  entries,
  connected,
  close,
  width,
  resize,
  locate,
  read,
  loadHistory,
  interaction,
}: {
  entries: LogEntry[];
  connected: boolean;
  close: () => void;
  width: number;
  resize: (width: number) => void;
  locate?: { sequence: number; request: number };
  read: (sequence: number) => void;
  loadHistory?: () => Promise<void>;
  interaction?: React.ReactNode;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const last = Math.max(0, ...entries.map((e) => e.sequence));
  useEffect(() => {
    if (follow && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      read(last);
    }
  }, [entries, follow]);
  useEffect(() => {
    if (locate === undefined) return;
    setFollow(false);
    scroll.current
      ?.querySelector(`[data-sequence="${locate.sequence}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [locate]);
  return (
    <section className="execution-sidebar" aria-label="执行过程侧栏">
      <div
        className="resize-handle"
        role="separator"
        aria-label="调整执行侧栏宽度"
        aria-orientation="vertical"
        aria-valuemin={320}
        aria-valuemax={520}
        aria-valuenow={width}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            resize(width + (e.key === "ArrowLeft" ? 20 : -20));
          }
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.dataset.dragX = String(e.clientX);
          e.currentTarget.dataset.dragWidth = String(width);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            resize(
              Number(e.currentTarget.dataset.dragWidth) +
                Number(e.currentTarget.dataset.dragX) -
                e.clientX,
            );
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <div className="execution-heading">
        <div className="execution-heading-left">
          <h2>执行过程</h2>
          <span
            className={`conn-pill ${connected ? "connected" : "reconnecting"}`}
          >
            <span className="conn-dot" />
            <small>{connected ? "已连接" : "重连中"}</small>
          </span>
        </div>
        <button
          className="btn-icon-close"
          onClick={close}
          aria-label="收起执行过程"
          title="收起执行过程"
        >
          <span>收起</span>
          <svg
            className="collapse-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
      <div
        className="logs timeline-stream"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
      >
        {loadHistory && (
          <button
            disabled={loadingHistory}
            onClick={() => {
              setFollow(false);
              setLoadingHistory(true);
              void loadHistory().finally(() => setLoadingHistory(false));
            }}
          >
            {loadingHistory ? "正在加载…" : "加载更早的执行记录"}
          </button>
        )}
        {entries.map((e) => (
          <article
            className={`activity ${e.kind}`}
            key={e.key}
            data-sequence={e.sequence}
          >
            <div className="activity-indicator">
              <span className={`indicator-dot ${e.status || e.kind}`} />
              <div className="timeline-line" />
            </div>
            <div className="activity-body">
              <div className="activity-heading">
                <b className="activity-title">{e.title}</b>
                {e.status && (
                  <span className={`activity-status ${e.status}`}>
                    {{
                      active: "进行中",
                      done: "已完成",
                      error: "失败",
                      interrupted: "已中断",
                    }[e.status] ?? e.status}
                  </span>
                )}
                <time>{new Date(e.created_at).toLocaleTimeString()}</time>
              </div>
              {e.kind === "message" ? (
                <div className="activity-markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{e.text}</Markdown>
                </div>
              ) : e.kind !== "diagnostic" && e.text ? (
                <p className="activity-summary">
                  {e.text.slice(0, 600)}
                  {e.text.length > 600 ? "…" : ""}
                </p>
              ) : null}
              <details className="activity-details">
                <summary>查看操作详情</summary>
                <pre className="terminal-pre">
                  {e.kind === "diagnostic"
                    ? e.text
                    : JSON.stringify(e.raw, null, 2)}
                </pre>
              </details>
            </div>
          </article>
        ))}
        {!entries.length && <p className="empty">还没有执行记录</p>}
      </div>
      {interaction}
      {!follow && (
        <button className="back-to-latest" onClick={() => setFollow(true)}>
          ↓ 回到最新
        </button>
      )}
    </section>
  );
}
