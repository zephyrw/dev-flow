import React, { useState } from "react";
import { AppDialog } from "./AppDialog.js";
import { NameEditDialog } from "./NameEditDialog.js";
import { TaskTitle } from "./TaskTitle.js";

export function ProjectName({ project, onRenamed, onDeleted }: {
  project: { id: string; name: string; primary_repo_id?: string; repositories?: { id: string; path: string }[] };
  onRenamed: (id: string, name: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = (project.repositories?.find((repo) => repo.id === project.primary_repo_id)
    ?? project.repositories?.[0])?.path;
  const endpoint = `/api/projects/${encodeURIComponent(project.id)}`;
  const save = async (name: string) => {
    const response = await fetch(endpoint + "/name", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message ?? result.message ?? "名称保存失败");
    onRenamed(project.id, result.name);
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? result.message ?? "删除项目关联失败");
      setDeleting(false);
      onDeleted(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除项目关联失败");
    } finally {
      setBusy(false);
    }
  };
  return <div className="project-name-editor">
    <TaskTitle className="project-name" title={`▱ ${project.name}`} tooltip={path} />
    <button type="button" className="project-name-edit" aria-label={`编辑项目名称：${project.name}`}
      onClick={() => setEditing(true)}>✎</button>
    <button type="button" className="project-name-delete" aria-label={`删除项目：${project.name}`}
      onClick={() => { setError(""); setDeleting(true); }}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
        <path d="M2 4h12M6 4V2h4v2M4 4l1 10h6l1-10M6.5 6v6M9.5 6v6" />
      </svg>
    </button>
    {editing && <NameEditDialog label="项目名称" initialName={project.name} maxLength={100} onSave={save} onClose={() => setEditing(false)} />}
    <AppDialog isOpen={deleting} title="删除项目" width={460} busy={busy} onClose={() => setDeleting(false)}
      footer={<><button type="button" disabled={busy} onClick={() => setDeleting(false)}>取消</button>
        <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{busy ? "删除中…" : "确认删除"}</button></>}>
      <p>确定删除项目“{project.name}”吗？</p>
      <p>只删除这个工作台的项目关联，不会删除项目文件。</p>
      <p>项目及其任务将从工作台列表移除。任务记录保留，正在运行的任务继续执行。</p>
      {error && <p role="alert">{error}</p>}
    </AppDialog>
  </div>;
}
