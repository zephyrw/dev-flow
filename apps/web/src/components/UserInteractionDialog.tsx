import React, { useEffect, useRef, useState } from "react";
import { AppDialog } from "./AppDialog.js";
import type {
  UserInteractionRecord,
  UserInteractionResponseInput,
} from "../../../../packages/contracts/src/user-interaction.js";
import { respondUserInteraction } from "./user-interaction-api.js";
import "./user-interaction.css";

export interface UserInteractionDialogProps {
  workflowId: string;
  interaction: UserInteractionRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onResponded: () => Promise<void>;
  rootConversationId?: string;
  expectedGeneration?: number;
}

export function UserInteractionDialog({
  workflowId,
  interaction,
  isOpen,
  onClose,
  onResponded,
  rootConversationId,
  expectedGeneration,
}: UserInteractionDialogProps) {
  const [selectedChoiceId, setSelectedChoiceId] = useState<string>("");
  const [answerText, setAnswerText] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  // 保持重试时的稳定幂等 request_id
  const requestIdRef = useRef<string>("");

  useEffect(() => {
    if (isOpen && interaction) {
      if (!requestIdRef.current) {
        requestIdRef.current = `req_int_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;
      }
      setError("");
    } else if (!isOpen) {
      requestIdRef.current = "";
      setSelectedChoiceId("");
      setAnswerText("");
      setError("");
    }
  }, [isOpen, interaction?.id]);

  if (!isOpen || !interaction) return null;

  const req = interaction.request;
  const isAction = req.kind === "action_required";
  const actionLabel = req.action_label || "我已完成，继续";

  const handleSubmit = async (action: "confirm" | "answer" | "cancel") => {
    if (submitting) return;

    if (action === "answer") {
      if (!selectedChoiceId && !answerText.trim()) {
        setError("请选择一个选项或输入回答内容");
        return;
      }
    }

    setSubmitting(true);
    setError("");

    try {
      const payload: UserInteractionResponseInput = {
        request_id: requestIdRef.current,
        source_run_id: interaction.source_run_id,
        root_conversation_id: rootConversationId,
        expected_generation: expectedGeneration,
        action,
        choice_id: selectedChoiceId || undefined,
        answer: answerText.trim() || undefined,
      };

      await respondUserInteraction(workflowId, interaction.id, payload);
      await onResponded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const isDirty = Boolean(selectedChoiceId || answerText.trim());

  const footer = (
    <div className="user-interaction-footer">
      <button
        type="button"
        className="btn-interaction-cancel"
        disabled={submitting}
        onClick={() => {
          if (window.confirm("确定要取消本次请求吗？任务将保持暂停状态。")) {
            void handleSubmit("cancel");
          }
        }}
      >
        取消本次请求
      </button>

      <div className="user-interaction-footer-right">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={submitting}
          onClick={onClose}
        >
          稍后处理
        </button>

        {isAction ? (
          <button
            type="button"
            className="btn btn-primary btn-interaction-confirm"
            disabled={submitting}
            onClick={() => void handleSubmit("confirm")}
          >
            {submitting ? "提交中..." : actionLabel}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-interaction-submit"
            disabled={
              submitting || (!selectedChoiceId && !answerText.trim())
            }
            onClick={() => void handleSubmit("answer")}
          >
            {submitting ? "提交中..." : "提交回答"}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      title={req.title}
      subtitle={`来源任务：${interaction.workflow_id} (${interaction.role})`}
      width={640}
      isDirty={isDirty}
      footer={footer}
    >
      <div className="user-interaction-body">
        {error && <div className="user-interaction-error">{error}</div>}

        <div className="user-interaction-message">{req.message}</div>

        {req.target && (
          <div className="user-interaction-target">
            <span className="user-interaction-target-title">操作目标指引：</span>
            {req.target.url && (
              <div className="user-interaction-target-url">
                页面地址：{" "}
                <a
                  href={req.target.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {req.target.url}
                </a>
              </div>
            )}
            {req.target.tab_id && (
              <div>标签页 Tab ID：{req.target.tab_id}</div>
            )}
            {req.target.connection_hint && (
              <div>提示：{req.target.connection_hint}</div>
            )}
          </div>
        )}

        {!isAction && (
          <div className="user-interaction-question-section">
            {req.question && (
              <div className="user-interaction-question-title">
                {req.question}
              </div>
            )}

            {req.choices && req.choices.length > 0 && (
              <div className="user-interaction-choices">
                {req.choices.map((choice) => (
                  <label
                    key={choice.id}
                    className={`user-interaction-choice-label ${
                      selectedChoiceId === choice.id ? "selected" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name="user-interaction-choice"
                      value={choice.id}
                      checked={selectedChoiceId === choice.id}
                      onChange={() => setSelectedChoiceId(choice.id)}
                      disabled={submitting}
                    />
                    <span>{choice.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {(isAction || req.allow_free_text !== false) && (
          <div>
            <textarea
              className="user-interaction-textarea"
              placeholder={
                isAction
                  ? "可选：填写操作完成说明或遇到的异常..."
                  : "填写补充回答或说明..."
              }
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              disabled={submitting}
            />
          </div>
        )}
      </div>
    </AppDialog>
  );
}
