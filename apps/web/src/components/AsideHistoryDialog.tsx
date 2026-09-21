import React, { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./aside-history.css";

export async function readAsides(workflowId: string, signal?: AbortSignal) {
  const response = await fetch("/api/workflows/" + workflowId + "/asides", {
    signal,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? "无法读取临时提问");
  if (!Array.isArray(value)) throw new Error("临时提问响应格式无效");
  return value;
}

export function upsertAside(list: any[], item: any) {
  if (!item?.id) return list;
  return [...list.filter((aside) => aside.id !== item.id), item];
}

export function AsideHistoryDialog({
  workflow,
  asides: initialAsides,
  refresh,
  onClose,
}: {
  workflow: any;
  asides: any[];
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [asides, setAsides] = useState(initialAsides);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const pending = asides.some((a) =>
    ["active", "queued", "waiting_account"].includes(a.status),
  );

  useEffect(() => {
    setAsides(initialAsides);
  }, [initialAsides]);

  useEffect(() => {
    const abort = new AbortController();
    readAsides(workflow.id, abort.signal)
      .then((list) => {
        if (!abort.signal.aborted) {
          setAsides(list);
          setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(String(e));
      });
    return () => abort.abort();
  }, [workflow.id, workflow.version, tick]);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setTick((t) => t + 1), 2000);
    return () => clearTimeout(timer);
  }, [pending, tick]);

  useEffect(() => {
    const onActivity = () => setTick((t) => t + 1);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("devflow-activity", onActivity);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("devflow-activity", onActivity);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function act(path: string, body: unknown) {
    try {
      const r = await fetch("/api/workflows/" + workflow.id + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const value = await r.json();
      if (!r.ok) throw new Error(value.message ?? "操作失败");
      setTick((t) => t + 1);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal aside-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="aside-history-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="section-title">
          <h2 id="aside-history-title">临时提问</h2>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
        <p className="aside-history-hint">
          只读提问不会打断主任务。回答完成后可转为正式反馈。
        </p>
        <div className="aside-history-list" aria-label="临时提问记录">
          {[...asides].reverse().map((a) => (
            <AsideHistoryItem
              key={a.id}
              aside={a}
              workflow={workflow}
              onAct={act}
            />
          ))}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}

function AsideHistoryItem({
  aside,
  workflow,
  onAct,
}: {
  aside: any;
  workflow: any;
  onAct: (path: string, body: unknown) => Promise<void>;
}) {
  const waiting = ["active", "queued", "waiting_account"].includes(aside.status);
  const failed = aside.status === "expired";
  return (
    <article className={"aside-history-item" + (failed ? " failed" : "")}>
      <header>
        <span className={"aside-status " + aside.status}>
          {asideStatusLabel(aside)}
        </span>
        <time>{new Date(aside.created_at).toLocaleString()}</time>
      </header>
      <h3>你的问题</h3>
      <p className="aside-question">{aside.question}</p>
      <h3>回答</h3>
      {aside.status === "completed" && aside.answer ? (
        <div className="aside-answer">
          <Markdown remarkPlugins={[remarkGfm]}>{aside.answer}</Markdown>
        </div>
      ) : (
        <p role="status" className={failed ? "error" : "muted"}>
          {aside.answer ?? asideStatusLabel(aside)}
        </p>
      )}
      {waiting && (
        <button
          type="button"
          onClick={() => void onAct("/asides/" + aside.id + "/cancel", {})}
        >
          取消提问
        </button>
      )}
      {aside.status === "completed" && aside.answer && (
        <button
          type="button"
          onClick={() =>
            void onAct("/asides/" + aside.id + "/promote", {
              text: aside.question + "\n" + aside.answer,
              target_revision: workflow.plan_revision,
            })
          }
        >
          转为正式反馈
        </button>
      )}
    </article>
  );
}

function asideStatusLabel(aside: any) {
  return (
    {
      active: "正在回答…",
      queued: "等待回答",
      waiting_account: "等待可用账号…",
      completed: "已回答",
      cancelled: "已取消",
      expired: "未完成",
    } as Record<string, string>
  )[aside.status] ?? aside.status;
}
