import React, { useState, useEffect, useRef } from "react";
import { AppDialog } from "./AppDialog.js";
import {
  ApprovalTarget,
  normalizeInstructionsText,
  computeInstructionsHash,
} from "./plan-approval-api.js";

export interface PlanApprovalDialogProps {
  isOpen: boolean;
  isStale?: boolean;
  onClose: () => void;
  workflowId: string;
  workflowVersion: number;
  planRevision: number;
  planHash: string | null;
  snapshotId?: string | null;
  environmentRevision?: number;
  planTitle?: string;
  planSummary?: string;
  executorProfileDescription?: string;
  onApprove: (
    target: ApprovalTarget,
    instructionsText: string,
    instructionsHash: string,
    requestId: string,
  ) => Promise<void>;
}

interface DraftRecord {
  planRevision: number;
  planHash: string | null;
  text: string;
}

const MAX_INSTRUCTIONS_LENGTH = 20000;

export function PlanApprovalDialog({
  isOpen,
  isStale = false,
  onClose,
  workflowId,
  workflowVersion,
  planRevision,
  planHash,
  snapshotId,
  environmentRevision,
  planTitle,
  planSummary,
  executorProfileDescription,
  onApprove,
}: PlanApprovalDialogProps) {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planMismatchNotice, setPlanMismatchNotice] = useState<string | null>(
    null,
  );
  const isComposingRef = useRef(false);

  const frozenTargetRef = useRef<ApprovalTarget | null>(null);
  const currentRequestIdRef = useRef<string>(crypto.randomUUID());
  const lastNormalizedTextRef = useRef<string>("");

  const storageKey = `devflow_approval_draft_${workflowId}`;

  // 打开时锁定不可变目标并初始化草稿
  useEffect(() => {
    if (!isOpen) {
      frozenTargetRef.current = null;
      return;
    }
    if (frozenTargetRef.current) return;
    const target: ApprovalTarget = {
      workflowId,
      workflowVersion,
      planRevision,
      planHash,
      snapshotId,
      environmentRevision,
      planTitle,
      planSummary,
      executorProfileDescription,
    };
    frozenTargetRef.current = target;
    currentRequestIdRef.current = crypto.randomUUID();
    lastNormalizedTextRef.current = "";
    setError(null);
    setPlanMismatchNotice(null);

    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const draft: DraftRecord = JSON.parse(raw);
        if (
          draft.planRevision === planRevision &&
          draft.planHash === planHash
        ) {
          setText(draft.text || "");
        } else if (draft.text && draft.text.trim()) {
          setText(draft.text);
          setPlanMismatchNotice(
            "计划已变化（修订版或哈希已更新），原草稿仅供参考，请重新核对后确认。",
          );
        } else {
          setText("");
        }
      } else {
        setText("");
      }
    } catch {
      setText("");
    }
  }, [
    isOpen,
    workflowId,
    workflowVersion,
    planRevision,
    planHash,
    snapshotId,
    environmentRevision,
    planTitle,
    planSummary,
    executorProfileDescription,
    storageKey,
  ]);

  // 检测外部目标变化（防止背景变更导致误审批）
  const isTargetStale = isStale || (
    frozenTargetRef.current !== null &&
    (frozenTargetRef.current.workflowId !== workflowId ||
      frozenTargetRef.current.planRevision !== planRevision ||
      frozenTargetRef.current.planHash !== planHash ||
      frozenTargetRef.current.workflowVersion !== workflowVersion ||
      frozenTargetRef.current.snapshotId !== snapshotId ||
      frozenTargetRef.current.environmentRevision !== environmentRevision));

  // 草稿自动保存
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    if (val.length <= MAX_INSTRUCTIONS_LENGTH) {
      setText(val);
      try {
        const draft: DraftRecord = {
          planRevision,
          planHash,
          text: val,
        };
        sessionStorage.setItem(storageKey, JSON.stringify(draft));
      } catch {}
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting || !frozenTargetRef.current || isTargetStale) return;
    setIsSubmitting(true);
    setError(null);

    try {
      const normalized = normalizeInstructionsText(text);
      if (normalized !== lastNormalizedTextRef.current) {
        lastNormalizedTextRef.current = normalized;
        currentRequestIdRef.current = crypto.randomUUID();
      }
      const target = frozenTargetRef.current;
      const hash = await computeInstructionsHash(normalized);
      await onApprove(
        target,
        normalized,
        hash,
        currentRequestIdRef.current,
      );
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      onClose();
    } catch (err: any) {
      setError(err?.message || "审批失败，请重试");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      if (!isComposingRef.current) {
        e.preventDefault();
        void handleSubmit();
      }
    }
  };

  const isDirty = text.trim().length > 0;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      busy={isSubmitting}
      title="批准执行计划"
      subtitle={`任务：${workflowId} · 计划修订版本 v${planRevision}`}
      width={720}
      isDirty={isDirty && !isSubmitting}
      footer={
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px", width: "100%" }}>
          <button
            type="button"
            className="btn-secondary"
            onClick={onClose}
            disabled={isSubmitting}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleSubmit}
            disabled={isSubmitting || isTargetStale}
          >
            {isSubmitting ? "正在批准并派发..." : "批准并开始执行"}
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "4px 0" }}>
        {/* 计划概述卡片 */}
        <div
          style={{
            padding: "12px 14px",
            background: "var(--color-bg-secondary, #f8fafc)",
            borderRadius: "6px",
            border: "1px solid var(--color-border, #e2e8f0)",
            fontSize: "13px",
            lineHeight: "1.5",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>
            {planTitle || `计划版本 v${planRevision}`}
          </div>
          {planSummary && (
            <div style={{ color: "var(--color-text-secondary, #64748b)", marginBottom: "6px" }}>
              {planSummary}
            </div>
          )}
          {executorProfileDescription && (
            <div style={{ fontSize: "12px", color: "var(--color-text-muted, #94a3b8)" }}>
              审批后将启动的执行配置：<span style={{ color: "var(--color-text-primary, #1e293b)" }}>{executorProfileDescription}</span>
            </div>
          )}
        </div>

        {isTargetStale && <div role="alert">任务或计划已变化，请关闭弹窗并重新核对后批准。草稿已保留。</div>}
        {planMismatchNotice && (
          <div
            style={{
              padding: "8px 12px",
              background: "#fffbeb",
              color: "#b45309",
              border: "1px solid #fde68a",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            ⚠️ {planMismatchNotice}
          </div>
        )}

        {/* 提示文案 */}
        <div
          style={{
            padding: "10px 12px",
            background: "#eff6ff",
            color: "#1e40af",
            border: "1px solid #bfdbfe",
            borderRadius: "6px",
            fontSize: "12px",
            lineHeight: "1.5",
          }}
        >
          <strong>提示：</strong>
          这些指令会随本次已批准计划交给执行模型，在后续开发、相关测试、修复和恢复时持续遵循。它们不能改变计划范围或跳过必要的安全与验收要求；如需修改整体方案请关闭弹窗并点击“驳回并修正”。
        </div>

        {/* 附加执行指令输入框 */}
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "6px",
            }}
          >
            <label
              htmlFor="execution-instructions-input"
              style={{ fontWeight: 500, fontSize: "13px" }}
            >
              附加执行指令（可选）
            </label>
            <span
              style={{
                fontSize: "11px",
                color:
                  text.length > MAX_INSTRUCTIONS_LENGTH * 0.9
                    ? "#ef4444"
                    : "var(--color-text-muted, #94a3b8)",
              }}
            >
              {text.length} / {MAX_INSTRUCTIONS_LENGTH}
            </span>
          </div>

          <textarea
            id="execution-instructions-input"
            rows={6}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: "6px",
              border: "1px solid var(--color-border, #cbd5e1)",
              fontFamily: "monospace, sans-serif",
              fontSize: "13px",
              lineHeight: "1.4",
              resize: "vertical",
              boxSizing: "border-box",
            }}
            placeholder={`尽量复用已有组件，不引入新的大型依赖。\n完成一组功能后先跑对应测试，再继续下一组。\n遇到已存在的测试失败请单独记录，不要通过删断言让测试变绿。`}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
            disabled={isSubmitting}
          />
          <div
            style={{
              fontSize: "11px",
              color: "var(--color-text-muted, #94a3b8)",
              marginTop: "4px",
            }}
          >
            按 Ctrl+Enter (Mac 上 Cmd+Enter) 可快速提交；直接回车保留换行。
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 12px",
              background: "#fef2f2",
              color: "#b91c1c",
              border: "1px solid #fecaca",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            {error}
          </div>
        )}
      </div>
    </AppDialog>
  );
}
