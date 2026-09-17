import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./plan-review.css";

export interface PlanReviewTarget {
  workflow_id: string;
  expected_version: number;
  plan_revision: number;
  plan_hash: string;
  mode: "reject" | "question";
}

export function PlanReviewDialog({
  target,
  onClose,
  onRejected,
}: {
  target: PlanReviewTarget;
  onClose: () => void;
  onRejected: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [questions, setQuestions] = useState<any[]>([]);
  const [reload, setReload] = useState(0);
  const request = useRef({ payload: "", id: "" });
  const reject = target.mode === "reject";
  const endpoint = `/api/workflows/${encodeURIComponent(target.workflow_id)}/plan/`;

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [pending, onClose]);

  useEffect(() => {
    if (reject) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(
          endpoint + `questions?plan_revision=${target.plan_revision}`,
          { signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok) throw Error(data.error?.message ?? "读取问答失败");
        if (controller.signal.aborted) return;
        setQuestions(data);
        if (data.some((q: any) => ["active", "queued"].includes(q.status)))
          timer = setTimeout(() => void load(), 1500);
      } catch (e) {
        if (!controller.signal.aborted) setError(String(e));
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, target.plan_revision, reject, reload]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || !text.trim()) return;
    setPending(true);
    setError("");
    const body = {
      plan_revision: target.plan_revision,
      plan_hash: target.plan_hash,
      text: text.trim(),
      ...(reject ? { expected_version: target.expected_version } : {}),
    };
    const payload = JSON.stringify(body);
    if (request.current.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
    try {
      const response = await fetch(
        endpoint + (reject ? "reject" : "questions"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, request_id: request.current.id }),
        },
      );
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message ?? "提交失败，请重试");
      if (reject) {
        onRejected();
        return;
      }
      setQuestions((previous) => [
        ...previous.filter((q) => q.id !== data.id),
        data,
      ]);
      setText("");
      request.current = { payload: "", id: "" };
      setReload((value) => value + 1);
      window.dispatchEvent(new Event("devflow-activity"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        className="modal plan-review-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plan-review-title"
      >
        <div className="section-title">
          <h2 id="plan-review-title">
            {reject ? "驳回并修正" : "计划问答"} · 第 {target.plan_revision} 版
          </h2>
          <button disabled={pending} onClick={onClose}>
            关闭
          </button>
        </div>
        <p>
          {reject
            ? "写明计划中的问题和修改要求。规划模型会修正并提交新版，等待你重新批准后才执行。"
            : "规划模型将结合这版计划的完整正文回答。提问不改变计划和审批状态；需要修改时可关闭窗口，选择“驳回并修正”。"}
        </p>
        {!reject && (
          <div
            className="plan-question-history"
            aria-label="计划问答记录"
            aria-live="polite"
          >
            {!questions.length && (
              <p className="muted">可以询问实施步骤、设计取舍或验收细节。</p>
            )}
            {questions.map((q) => (
              <article key={q.id}>
                <h3>你的问题</h3>
                <p className="plan-question-text">{q.question}</p>
                <h3>规划模型</h3>
                {q.status === "completed" ? (
                  <div className="plan-question-answer">
                    <Markdown remarkPlugins={[remarkGfm]}>{q.answer}</Markdown>
                  </div>
                ) : (
                  <p role="status">
                    {q.status === "queued"
                      ? "问题已排队，等待规划模型回答…"
                      : q.status === "active"
                        ? "规划模型正在回答…"
                        : "本次回答未完成，可以重新提问。"}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
        <form onSubmit={submit}>
          <label htmlFor="plan-review-text">
            {reject ? "修改意见（必填）" : "向规划模型提问"}
          </label>
          <textarea
            id="plan-review-text"
            autoFocus
            rows={4}
            maxLength={20000}
            required
            placeholder={
              reject
                ? "例如：实施步骤缺少数据迁移，请补充迁移、回滚和验证方案。"
                : "例如：第三步为什么采用这个方案？对现有功能有什么影响？"
            }
            value={text}
            disabled={pending}
            onChange={(event) => setText(event.target.value)}
          />
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="actions">
            <button
              className="primary"
              type="submit"
              disabled={pending || !text.trim()}
            >
              {pending ? "正在提交…" : reject ? "提交修改意见" : "发送问题"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
