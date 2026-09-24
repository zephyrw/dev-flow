import React, { useState } from "react";

export interface WorkflowArchiveActionProps {
  workflowId: string;
  workflowTitle?: string;
  onArchived?: (workflowId: string) => void;
}

export function WorkflowArchiveAction({
  workflowId,
  workflowTitle,
  onArchived,
}: WorkflowArchiveActionProps) {
  const [archiving, setArchiving] = useState(false);

  const handleArchive = async () => {
    if (archiving) return;
    setArchiving(true);
    try {
      const visRes = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/visibility`,
      );
      const visData = await visRes.json().catch(() => ({}));
      const currentRev = visData.visibility?.revision ?? 0;

      const putRes = await fetch(
        `/api/workflows/${encodeURIComponent(workflowId)}/visibility`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: crypto.randomUUID(),
            expected_visibility_revision: currentRev,
            archived: true,
          }),
        },
      );

      if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        throw new Error(err.message || `归档失败 (${putRes.status})`);
      }

      onArchived?.(workflowId);
    } catch (err: any) {
      alert(`归档任务失败：${err?.message || "未知错误"}`);
    } finally {
      setArchiving(false);
    }
  };

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={() => void handleArchive()}
      disabled={archiving}
      title={
        workflowTitle
          ? `将任务“${workflowTitle}”移入归档（不影响运行与代码目录）`
          : "将当前任务移入归档（不影响运行与代码目录）"
      }
      aria-label="归档任务"
    >
      {archiving ? "归档中…" : "归档"}
    </button>
  );
}
