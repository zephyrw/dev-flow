import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Review } from "../../../../packages/contracts/src/index.js";

const verdictLabels: Record<string, string> = {
  pass: "通过", passed: "通过", quality_pass: "通过",
  findings: "发现问题", changes_required: "需要整改",
  incomplete: "验证不完整", need_user: "需要你的处理",
};

export function ReviewResults({ review }: { review?: Partial<Review> & { stale?: boolean } | null }) {
  if (!review) return <div className="empty">尚无独立复核结果，复核完成后会显示在这里。</div>;
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const questions = Array.isArray(review.unresolved_questions) ? review.unresolved_questions : [];
  const files = Array.isArray(review.coverage?.files) ? review.coverage.files : [];
  const verdict = review.verdict ?? review.status;
  return <div className="review-results">
    <p>
      {review.stale ? "历史复核已失效，请以新一轮结果为准。" : "本轮复核"}
      {review.plan_revision != null && <> · 第 {review.plan_revision} 版计划</>}
      {verdict && <> · {verdictLabels[verdict] ?? verdict}</>}
    </p>
    {review.summary && <div className="document"><Markdown remarkPlugins={[remarkGfm]}>{review.summary}</Markdown></div>}
    {review.snapshot_id && <details><summary>技术详情</summary><p className="mono">快照：{review.snapshot_id}</p></details>}
    {findings.map((finding, index) => <article key={finding.id ?? index} className="panel">
      <h3>{finding.id ?? `问题 ${index + 1}`}{finding.severity && <> · {finding.severity}</>}</h3>
      {(finding.repo_id || finding.path) && <p>
        {[finding.repo_id, finding.path].filter(Boolean).join(" / ")}{finding.line != null && `:${finding.line}`}
      </p>}
      {finding.trigger && <p>触发条件：{finding.trigger}</p>}
      {finding.evidence && <p>证据：{finding.evidence}</p>}
      {finding.consequence && <p>影响：{finding.consequence}</p>}
      {finding.reason && <p>处置理由：{finding.reason}</p>}
    </article>)}
    {review.repair_document && <>
      <h3>整改意见</h3>
      <p>整改沿用原批准计划。</p>
      <div className="document"><Markdown remarkPlugins={[remarkGfm]}>{review.repair_document}</Markdown></div>
    </>}
    {questions.length > 0 && <><h3>复核缺口</h3><ul>{questions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}
    {files.length > 0 && <><h3>覆盖文件</h3><ul>{files.map((file) => <li key={file}>{file}</li>)}</ul></>}
  </div>;
}
