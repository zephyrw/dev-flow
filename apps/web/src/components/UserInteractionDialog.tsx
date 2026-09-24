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

interface DraftState {
  selectedChoiceId: string;
  answerText: string;
  lastAttempt?: {
    action: string;
    choice_id?: string;
    answer?: string;
    requestId: string;
  };
}

// F07: 全局草稿存储，以 (workflowId, interactionId) 作为唯一索引键
const draftStore = new Map<string, DraftState>();

function getDraftKey(workflowId: string, interactionId: string): string {
  return `${workflowId}:${interactionId}`;
}

export function UserInteractionDialog(props: UserInteractionDialogProps) {
  if (!props.interaction) return null;
  return (
    <InteractionForm
      key={getDraftKey(props.workflowId, props.interaction.id)}
      {...props}
    />
  );
}

function InteractionForm({
  workflowId,
  interaction,
  isOpen,
  onClose,
  onResponded,
}: UserInteractionDialogProps) {
  const currentInteractionId = interaction?.id || "";
  const draftKey = currentInteractionId
    ? getDraftKey(workflowId, currentInteractionId)
    : "";

  const [selectedChoiceId, setSelectedChoiceId] = useState<string>("");
  const [answerText, setAnswerText] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const mounted = useRef(false);
  const busy = useRef(false);
  const view = useRef({ open: isOpen, generation: 0 });
  if (view.current.open !== isOpen)
    view.current = { open: isOpen, generation: view.current.generation + 1 };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // F07: 当 interaction 或 workflow 变化时，按 (workflowId, interactionId) 独立加载/重置草稿
  useEffect(() => {
    if (!draftKey) {
      setSelectedChoiceId("");
      setAnswerText("");
      setError("");
      return;
    }

    const saved = draftStore.get(draftKey);
    if (saved) {
      setSelectedChoiceId(saved.selectedChoiceId);
      setAnswerText(saved.answerText);
    } else {
      setSelectedChoiceId("");
      setAnswerText("");
    }
    setError("");
  }, [draftKey]);

  // 当用户编辑时，同步保存当前问题的草稿
  const handleChoiceChange = (choiceId: string) => {
    setSelectedChoiceId(choiceId);
    if (draftKey) {
      const current = draftStore.get(draftKey) || {
        selectedChoiceId: "",
        answerText: "",
      };
      draftStore.set(draftKey, {
        ...current,
        selectedChoiceId: choiceId,
      });
    }
  };

  const handleAnswerChange = (text: string) => {
    setAnswerText(text);
    if (draftKey) {
      const current = draftStore.get(draftKey) || {
        selectedChoiceId: "",
        answerText: "",
      };
      draftStore.set(draftKey, {
        ...current,
        answerText: text,
      });
    }
  };

  if (!isOpen || !interaction) return null;

  const req = interaction.request;
  const isAction = req.kind === "action_required";
  const actionLabel = req.action_label || "我已完成，继续";

  const handleSubmit = async (action: "confirm" | "answer" | "cancel") => {
    if (busy.current) return;

    if (action === "answer") {
      const trimmedChoice = selectedChoiceId.trim();
      const trimmedAnswer = answerText.trim();
      if (req.allow_free_text === false) {
        if (!trimmedChoice) {
          setError("当前问题禁止自由文本输入，请选择一个有效选项");
          return;
        }
      } else if (!trimmedChoice && !trimmedAnswer) {
        setError("请选择一个选项或输入回答内容");
        return;
      }
    }

    setSubmitting(true);
    busy.current = true;
    const generation = view.current.generation;
    const isCurrentView = () =>
      mounted.current &&
      view.current.open &&
      view.current.generation === generation;
    setError("");

    // F07: 提交快照与幂等 requestId 处理
    const currentDraft = draftStore.get(draftKey) || {
      selectedChoiceId,
      answerText,
    };
    const choice_id = selectedChoiceId ? selectedChoiceId.trim() : undefined;
    const answer = answerText.trim() ? answerText.trim() : undefined;

    let requestId: string;
    const last = currentDraft.lastAttempt;
    if (
      last &&
      last.action === action &&
      last.choice_id === choice_id &&
      last.answer === answer
    ) {
      // 相同快照重试，复用相同 request_id
      requestId = last.requestId;
    } else {
      // 新决定或修改内容，生成新 request_id
      requestId = `req_int_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 9)}`;
      currentDraft.lastAttempt = {
        action,
        choice_id,
        answer,
        requestId,
      };
      draftStore.set(draftKey, currentDraft);
    }

    const targetWorkflowId = workflowId;
    const targetInteractionId = interaction.id;

    try {
      const payload: UserInteractionResponseInput = {
        request_id: requestId,
        source_run_id: interaction.source_run_id,
        source_plan_revision: interaction.source_plan_revision,
        root_conversation_id: interaction.root_conversation_id,
        expected_generation: interaction.source_generation,
        native_session_id: interaction.native_session_id,
        action,
        choice_id,
        answer,
      };

      await respondUserInteraction(
        targetWorkflowId,
        targetInteractionId,
        payload,
      );

      // 成功提交后清除该草稿
      draftStore.delete(draftKey);

      // 触发外部状态拉取
      if (isCurrentView()) {
        // Close this question before refreshing: the refresh may open another.
        onClose();
        await onResponded();
      }
    } catch (err) {
      // 只有当前依然在同一问题时才显示错误
      if (isCurrentView()) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      busy.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  const footer = (
    <div className="user-interaction-footer">
      <button
        type="button"
        className="btn-interaction-cancel"
        disabled={submitting}
        onClick={() => {
          void handleSubmit("cancel");
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
              submitting ||
              (req.allow_free_text === false
                ? !selectedChoiceId
                : !selectedChoiceId && !answerText.trim())
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
      isDirty={false} /* 稍后处理和关闭保持收起语义，不触发放弃警告 */
      footer={footer}
    >
      <div className="user-interaction-body">
        {error && <div className="user-interaction-error">{error}</div>}

        <div className="user-interaction-message">{req.message}</div>

        {req.target && (
          <div className="user-interaction-target">
            <span className="user-interaction-target-title">
              操作目标指引：
            </span>
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
            {req.target.tab_id !== undefined && (
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
                      name={`user-interaction-choice-${interaction.id}`}
                      value={choice.id}
                      checked={selectedChoiceId === choice.id}
                      onChange={() => handleChoiceChange(choice.id)}
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
              maxLength={4000}
              placeholder={
                isAction
                  ? "可选：填写操作完成说明或遇到的异常..."
                  : "填写补充回答或说明..."
              }
              value={answerText}
              onChange={(e) => handleAnswerChange(e.target.value)}
              disabled={submitting}
            />
          </div>
        )}
      </div>
    </AppDialog>
  );
}
