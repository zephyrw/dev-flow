import React, { useState } from "react";
import { NameEditDialog } from "./NameEditDialog.js";

export function TaskNameEditAction({ workflowId, title, onRenamed }: {
  workflowId: string;
  title: string;
  onRenamed: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const save = async (name: string) => {
    const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/name`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: name }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? result.message ?? "名称保存失败");
    onRenamed(workflowId, result.title);
  };
  return <>
    <button type="button" className="task-name-edit" aria-label={`编辑任务名称：${title}`}
      onClick={(event) => { event.stopPropagation(); setEditing(true); }}>✎</button>
    {editing && <NameEditDialog label="任务名称" initialName={title} maxLength={20} onSave={save} onClose={() => setEditing(false)} />}
  </>;
}
