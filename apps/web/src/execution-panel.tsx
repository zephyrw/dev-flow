import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LogEntry } from "./logs.js";
import { CommandPreview } from "./command-preview.js";
import {
  publicConversationText,
  readConversationViewport,
  shouldRenderConversationInteraction,
  writeConversationViewport,
  type ConversationViewEntry,
} from "./use-conversation-view.js";

/** 智能中间截断路径：优先完整显示文件名，有余量时尽量多显示前缀，极窄空间截取文件名后半段 */
export function formatPathSummary(
  text: string,
  maxLength: number = 56,
): string {
  if (!text || text.length <= maxLength) return text;
  const lastSepIndex = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (lastSepIndex === -1) {
    return maxLength > 3 ? "..." + text.slice(-(maxLength - 3)) : text;
  }

  const fileName = text.slice(lastSepIndex + 1);
  const dirPath = text.slice(0, lastSepIndex);
  const sep = text[lastSepIndex];

  // 连文件名+省略号都放不下时，显示最后那段，前面显示 ...
  if (fileName.length + 3 >= maxLength) {
    return "..." + fileName.slice(-(maxLength - 3));
  }

  // 空间充足容纳文件名，计算前缀可用空间
  const availableForPrefix = maxLength - fileName.length - 3;
  if (availableForPrefix < 3) {
    return `...${sep}${fileName}`;
  }

  let prefix = dirPath.slice(0, availableForPrefix);
  // 保持形如 C:\Code\...ApplicationSaveService.java，且预留分隔符空间防止溢出
  if (!prefix.endsWith("\\") && !prefix.endsWith("/")) {
    prefix = dirPath.slice(0, Math.max(0, availableForPrefix - 1)) + sep;
  }
  return `${prefix}...${fileName}`;
}

export function PathSummary({ text }: { text: string }) {
  if (!text) return null;
  const lastSepIndex = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (lastSepIndex === -1) {
    return <span>{text}</span>;
  }
  const dirPath = text.slice(0, lastSepIndex);
  const sep = text[lastSepIndex];
  const fileName = text.slice(lastSepIndex + 1);

  return (
    <span className="summary-path-wrapper">
      <span className="summary-path-prefix">{dirPath}</span>
      <span className="summary-path-file">{sep}{fileName}</span>
    </span>
  );
}

function persistConversationScroll(
  workflowId: string | undefined,
  conversationId: string | undefined,
  el: HTMLDivElement | null,
  followLatest: boolean,
) {
  if (!workflowId || !conversationId || !el) return;
  writeConversationViewport(workflowId, conversationId, {
    scrollTop: el.scrollTop,
    followLatest,
  });
}

function isSeparatorEntry(entry: ConversationViewEntry) {
  return entry.presentation === "separator" || entry.kind === "separator";
}

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
  footer,
  breadcrumb,
  viewedRuntime,
  notice,
  workflowId,
  conversationId,
  isChildView,
  onCopyPublicText,
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
  footer?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  viewedRuntime?: React.ReactNode;
  notice?: string;
  workflowId?: string;
  conversationId?: string;
  isChildView?: boolean;
  onCopyPublicText?: (text: string) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [copied, setCopied] = useState(false);
  const followRef = useRef(follow);
  const conversationRef = useRef(conversationId);
  followRef.current = follow;
  const last = Math.max(0, ...entries.map((e) => e.sequence));
  // 侧栏有效宽度为总宽减去边距与指示器(约56px)，按单行平均字符宽度5.5px计算最大字符容量，确保文字铺满整行并与右侧时间对齐
  const maxSummaryChars = Math.max(24, Math.floor((width - 56) / 5.5));
  useEffect(() => {
    if (follow && scroll.current) {
      scroll.current.scrollTop = scroll.current.scrollHeight;
      read(last);
      if (workflowId && conversationId) {
        writeConversationViewport(workflowId, conversationId, {
          scrollTop: scroll.current.scrollTop,
          followLatest: true,
          readCursor: last,
        });
      }
    }
  }, [entries, follow]);
  useEffect(() => {
    if (locate === undefined) return;
    setFollow(false);
    scroll.current
      ?.querySelector(`[data-sequence="${locate.sequence}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [locate]);
  useEffect(() => {
    const previousId = conversationRef.current;
    if (previousId && previousId !== conversationId) {
      persistConversationScroll(
        workflowId,
        previousId,
        scroll.current,
        followRef.current,
      );
    }
    conversationRef.current = conversationId;
    if (!workflowId || !conversationId) return;
    const saved = readConversationViewport(workflowId, conversationId);
    setFollow(saved.followLatest);
    if (!scroll.current) return;
    scroll.current.scrollTop = saved.followLatest
      ? scroll.current.scrollHeight
      : saved.scrollTop;
  }, [workflowId, conversationId]);
  const copyPublic = () => {
    const text = publicConversationText(entries as ConversationViewEntry[]);
    onCopyPublicText?.(text);
    void navigator.clipboard?.writeText(text)?.then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <section
      className="execution-sidebar"
      aria-label="执行过程侧栏"
      data-child-view={isChildView ? "true" : undefined}
    >
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
            title="页面与服务的事件连接状态；模型活动见右上角当前运行信息"
          >
            <span className="conn-dot" />
            <small>{connected ? "已连接" : "重连中"}</small>
          </span>
          <button
            type="button"
            className="btn-text"
            onClick={copyPublic}
            aria-label="复制公开文本"
            title="复制公开文本"
          >
            {copied ? "已复制" : "复制公开文本"}
          </button>
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
      {notice && (
        <p className="conversation-view-notice" role="status">
          {notice}
        </p>
      )}
      {breadcrumb}
      {viewedRuntime && (
        <p
          className="conversation-view-runtime"
          title={
            typeof viewedRuntime === "string" ? viewedRuntime : undefined
          }
        >
          {viewedRuntime}
        </p>
      )}
      <div
        className="logs timeline-stream"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          const nextFollow =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setFollow(nextFollow);
          persistConversationScroll(
            workflowId,
            conversationId,
            el,
            nextFollow,
          );
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
        {entries.map((e) => {
          const row = e as ConversationViewEntry;
          if (isSeparatorEntry(row)) {
            return (
              <div
                className="activity separator"
                key={row.key}
                data-sequence={row.sequence}
              >
                <b className="activity-title">{row.title}</b>
              </div>
            );
          }
          return (
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
                {e.status && e.status !== "done" && (
                  <span className={`activity-status ${e.status}`}>
                    {{
                      active: "进行中",
                      error: "失败",
                      interrupted: "已中断",
                    }[e.status] ?? e.status}
                  </span>
                )}
                <time>{new Date(e.created_at).toLocaleTimeString()}</time>
              </div>
              {e.command ? (
                <CommandPreview command={e.command} cwd={e.cwd} />
              ) : e.kind === "message" || e.kind === "event" ? (
                <div className="activity-markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>{e.text}</Markdown>
                </div>
              ) : e.kind !== "diagnostic" && e.text ? (
                <p className="activity-summary" title={e.text}>
                  <PathSummary text={e.text} />
                </p>
              ) : null}
              {e.kind === "tool" && e.resultText && (
                <p className="activity-result">{e.resultText}</p>
              )}
            </div>
          </article>
          );
        })}
        {!entries.length && <p className="empty">还没有执行记录</p>}
      </div>
      {footer}
      {shouldRenderConversationInteraction(Boolean(isChildView))
        ? interaction
        : null}
      {!follow && (
        <button className="back-to-latest" onClick={() => setFollow(true)}>
          ↓ 回到最新
        </button>
      )}
    </section>
  );
}
