import React, { useEffect, useRef, useState } from "react";
import type { SourceChangePreview } from "../../../../packages/core/src/source-change.js";
import "./plan-review.css";

export function SourceChangeDialog({
  workflowId,
  version,
  onClose,
  onResolved,
}: {
  workflowId: string;
  version: number;
  onClose: () => void;
  onResolved: (choice: "continue" | "replan") => void;
}) {
  const [preview, setPreview] = useState<SourceChangePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [instructions, setInstructions] = useState("");
  const [reload, setReload] = useState(0);
  const request = useRef({ payload: "", id: "" });
  const endpoint = `/api/workflows/${encodeURIComponent(workflowId)}/source-change/`;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPreview(null);
    setError("");
    void fetch(endpoint + "preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_version: version }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw Error(data.error?.message ?? "读取代码更新失败");
        if (!controller.signal.aborted) setPreview(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, version, reload]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [pending, onClose]);

  const choose = async (choice: "continue" | "replan") => {
    if (!preview || pending) return;
    setPending(true);
    setError("");
    const body = {
      preview_id: preview.id,
      choice,
      instructions: choice === "replan" ? instructions : "",
    };
    const payload = JSON.stringify(body);
    if (request.current.payload !== payload)
      request.current = { payload, id: crypto.randomUUID() };
    try {
      const response = await fetch(endpoint + "resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, request_id: request.current.id }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message ?? "提交失败，请重试");
      onResolved(choice);
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
        aria-labelledby="source-change-title"
      >
        <div className="section-title">
          <h2 id="source-change-title">项目代码已更新</h2>
          <button disabled={pending} onClick={onClose}>
            关闭
          </button>
        </div>
        <p>
          制定计划后，项目里的代码有了变化。任务仍在主工作区执行，请先查看更新，再决定如何继续。
        </p>
        {loading && <p role="status">正在读取代码更新…</p>}
        {preview?.repositories.map((repo) => (
          <article className="source-change-repo" key={repo.repo_id}>
            <h3>
              {repo.repo_id} · {repo.branch}
            </h3>
            <p className="muted">{repo.root}</p>
            <p>
              制定计划时 <code>{repo.previous_commit.slice(0, 8)}</code> →
              当前代码 <code>{repo.current_commit.slice(0, 8)}</code>
            </p>
            <details open>
              <summary>最近更新（最多 20 条）</summary>
              {repo.commits.length ? (
                <ul>
                  {repo.commits.map((commit) => (
                    <li key={commit}>{commit}</li>
                  ))}
                </ul>
              ) : (
                <p>提交版本没有新增，当前文件内容可能已变化。</p>
              )}
            </details>
            <details>
              <summary>
                已提交的文件变化（{repo.changed_files.length} 项）
              </summary>
              <pre>
                {repo.changed_files.slice(0, 100).join("\n") || "无"}
                {repo.changed_files.length > 100 ? "\n仅显示前 100 项" : ""}
              </pre>
            </details>
            <details>
              <summary>
                {repo.local_changes
                  ? "还有本地未提交的修改，将保留并作为执行输入"
                  : "没有本地未提交的修改"}
              </summary>
              <pre>{repo.local_changes || "无"}</pre>
            </details>
          </article>
        ))}
        {error && (
          <div role="alert" className="error">
            {error}
            <button
              disabled={pending || loading}
              onClick={() => setReload((n) => n + 1)}
            >
              重新读取代码更新
            </button>
          </div>
        )}
        <div className="source-change-choice">
          <h3>使用当前代码继续</h3>
          <p>
            确认这些更新不影响原计划。保留原任务范围和验收要求，记录你选择的代码版本，然后开始执行。
          </p>
          <button
            className="primary"
            disabled={!preview || loading || pending}
            onClick={() => void choose("continue")}
          >
            确认使用当前代码并继续
          </button>
        </div>
        <div className="source-change-choice">
          <h3>按当前代码重新规划</h3>
          <p>
            让规划模型结合这些更新检查并修正原计划。新版计划会等待你批准，然后才执行。
          </p>
          <label htmlFor="source-change-instructions">
            补充规划要求（可选）
          </label>
          <textarea
            id="source-change-instructions"
            rows={2}
            maxLength={20000}
            disabled={pending}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <button
            disabled={!preview || loading || pending}
            onClick={() => void choose("replan")}
          >
            按当前代码重新规划
          </button>
        </div>
        {pending && <p role="status">正在核对代码并提交选择…</p>}
      </section>
    </div>
  );
}
