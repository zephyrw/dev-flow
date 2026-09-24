import React, { useState, useRef } from "react";

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

  const pendingRequest = useRef<{ workflowId: string; payload: { request_id: string; expected_visibility_revision: number; archived: true } } | null>(null);
  const handleArchive = async () => {
    if (archiving) return;
    if (!window.confirm("归档后任务将从菜单和总览隐藏，文件、状态和记录均保留。正在运行的任务会继续执行，可在设置中恢复。")) return;
    setArchiving(true);
    try {
      if (pendingRequest.current?.workflowId !== workflowId) {
        const visRes = await fetch("/api/workflows/" + encodeURIComponent(workflowId) + "/visibility");
        if (!visRes.ok) throw new Error("读取可见性状态失败: " + visRes.status);
        const visData = await visRes.json();
        if (!Number.isSafeInteger(visData.visibility?.revision)) throw new Error("可见性状态响应无效");
        pendingRequest.current = { workflowId, payload: {
          request_id: crypto.randomUUID(), expected_visibility_revision: visData.visibility.revision, archived: true,
        } };
      }
      const putRes = await fetch("/api/workflows/" + encodeURIComponent(workflowId) + "/visibility", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pendingRequest.current.payload),
      });
      if (!putRes.ok) {
        if (putRes.status === 409) pendingRequest.current = null;
        const err = await putRes.json().catch(() => ({}));
        throw new Error(err.message || "归档失败: " + putRes.status);
      }
      pendingRequest.current = null;
      onArchived?.(workflowId);
    } catch (err: any) {
      alert("归档任务失败：" + (err?.message || "未知错误"));
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
