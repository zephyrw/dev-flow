import React from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Review } from "../../../../packages/contracts/src/index.js";

const verdictLabels: Record<string, string> = {
  pass: "通过", passed: "通过", quality_pass: "通过",
  findings: "发现问题", changes_required: "需要整改",
  incomplete: "验证不完整", need_user: "需要你的处理",
};

export function ReviewResults({
  review,
  activity,
}: {
  review?: (Partial<Review> & { stale?: boolean }) | null;
  activity?: string;
}) {
  if (!review) return <div className="empty">尚无独立复核结果，复核完成后会显示在这里。</div>;
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const questions = Array.isArray(review.unresolved_questions) ? review.unresolved_questions : [];
  const files = Array.isArray(review.coverage?.files) ? review.coverage.files : [];
  const verdict = review.verdict ?? review.status;

  const statusText = review.stale
    ? activity === "executor_test"
      ? "历史复核问题已交整改，目前正在整改后测试。"
      : activity === "planner_takeover"
        ? "正在处理本次复核发现的问题。"
        : "历史复核已失效，请结合后续整改进展查看。"
    : "本轮复核";

  const verdictLabel = verdict ? (verdictLabels[verdict] ?? verdict) : null;
  const isPass = verdict === "pass" || verdict === "passed" || verdict === "quality_pass";
  const isNeedsFix = verdict === "changes_required" || verdict === "findings";

  return (
    <div className="review-results">
      <div className="review-header-summary panel">
        <div className="review-header-top">
          <p className="review-status-lead">
            {statusText}
            {verdictLabel && <> · <span className={`review-verdict-badge ${isPass ? "pass" : isNeedsFix ? "warn" : ""}`}>{verdictLabel}</span></>}
          </p>
          <div className="review-badge-metrics">
            <span className="review-metric-pill">
              {findings.length > 0
                ? `${findings.length} 项问题`
                : isPass
                  ? "未发现问题"
                  : "暂无问题明细"}
            </span>
            {files.length > 0 && (
              <span className="review-metric-pill">
                覆盖 {files.length} 个文件
              </span>
            )}
          </div>
        </div>
        {review.summary && (
          <div className="document review-summary-content">
            <Markdown remarkPlugins={[remarkGfm]}>{review.summary}</Markdown>
          </div>
        )}
      </div>

      {review.snapshot_id && (
        <details className="review-snapshot-details">
          <summary>技术详情</summary>
          <p className="mono">快照：{review.snapshot_id}</p>
        </details>
      )}

      {findings.length > 0 && (
        <div className="review-findings-list">
          {findings.map((finding, index) => (
            <article key={finding.id ?? index} className="panel review-finding-card">
              <div className="finding-header">
                <h3>
                  {finding.id ?? `问题 ${index + 1}`}
                  {finding.severity && <> · {finding.severity}</>}
                </h3>
              </div>
              {(finding.repo_id || finding.path) && (
                <p className="finding-location">
                  {[finding.repo_id, finding.path].filter(Boolean).join(" / ")}
                  {finding.line != null && `:${finding.line}`}
                </p>
              )}
              <div className="finding-fields-grid">
                {finding.trigger && (
                  <p className="finding-field-item">
                    <strong className="field-tag">触发条件：</strong>
                    {finding.trigger}
                  </p>
                )}
                {finding.evidence && (
                  <p className="finding-field-item">
                    <strong className="field-tag">证据：</strong>
                    {finding.evidence}
                  </p>
                )}
                {finding.consequence && (
                  <p className="finding-field-item">
                    <strong className="field-tag">影响：</strong>
                    {finding.consequence}
                  </p>
                )}
                {finding.reason && (
                  <p className="finding-field-item">
                    <strong className="field-tag">处置理由：</strong>
                    {finding.reason}
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {review.repair_document && (
        <div className="review-repair-section panel">
          <h3>整改意见</h3>
          <p>整改沿用原批准计划。</p>
          <div className="document">
            <Markdown remarkPlugins={[remarkGfm]}>{review.repair_document}</Markdown>
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div className="review-section-block">
          <h3>复核缺口</h3>
          <ul className="review-bullets-list">
            {questions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      )}

      {files.length > 0 && (
        <div className="review-section-block">
          <h3>覆盖文件</h3>
          <ul className="review-files-list mono">
            {files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
