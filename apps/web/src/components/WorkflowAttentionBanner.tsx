import React from "react";

export interface AttentionItem {
  category: string;
  message: string;
  action?: string;
  action_kind?:
    | "open_execution"
    | "approval"
    | "source_change"
    | "acceptance"
    | "guidance"
    | "focus_failure"
    | "custom";
  source?: string;
  reason?: string;
  at?: string;
}

export interface WorkflowAttentionBannerProps {
  attention: AttentionItem | null;
  workflowId: string;
  workflowVersion: number;
  onOpenPlan?: () => void;
  onOpenSourceChange?: () => void;
  onOpenEnvironment?: () => void;
  onOpenGuidance?: () => void;
}

function resolveActionKind(item: AttentionItem): string | undefined {
  if (item.action_kind) return item.action_kind;
  if (!item.action) return undefined;
  if (
    item.action === "查看执行过程" ||
    item.action === "查看执行" ||
    item.action === "查看过程"
  ) {
    return "open_execution";
  }
  if (item.category === "approval") return "approval";
  if (item.category === "source_change") return "source_change";
  if (item.category === "acceptance") return "acceptance";
  if (item.category === "guidance") return "guidance";
  return "custom";
}

export function WorkflowAttentionBanner({
  attention,
  workflowId,
  workflowVersion,
  onOpenPlan,
  onOpenSourceChange,
  onOpenEnvironment,
  onOpenGuidance,
}: WorkflowAttentionBannerProps) {
  if (!attention) return null;

  // 过滤控制台本地暂停触发的重复提示
  const isLocalPause =
    attention.source === "local_console" ||
    attention.reason === "user_paused" ||
    attention.message?.includes("你在控制台暂停");
  if (isLocalPause) return null;

  const actionKind = resolveActionKind(attention);
  // 删除冗余的“查看执行过程”跳转按钮
  const showActionButton =
    Boolean(attention.action) &&
    actionKind !== "open_execution" &&
    actionKind !== undefined;

  const handleAction = () => {
    switch (actionKind) {
      case "approval":
        onOpenPlan?.();
        break;
      case "source_change":
        onOpenSourceChange?.();
        break;
      case "acceptance":
        onOpenEnvironment?.();
        break;
      case "guidance":
        onOpenGuidance?.();
        break;
      default:
        // 若页面有对应的失败通知卡，优先滚动对齐
        const card = document.getElementById(`runtime-failure-${workflowId}`);
        if (card) {
          card.scrollIntoView({ block: "nearest" });
          card.focus();
        }
        break;
    }
  };

  return (
    <div
      className={`attention-strip ${attention.category}`}
      role="status"
    >
      <span className="attention-icon" aria-hidden="true">
        ⚠️
      </span>
      <span className="attention-message" title={attention.message}>
        {attention.message}
      </span>

      {showActionButton && (
        <button
          type="button"
          className="btn-attention-action"
          onClick={handleAction}
        >
          {attention.action}
        </button>
      )}
    </div>
  );
}
