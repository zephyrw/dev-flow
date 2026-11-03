import React, { useState } from "react";

export function ProjectName({ project, onRenamed }: {
  project: { id: string; name: string; primary_repo_id?: string; repositories?: { id: string; path: string }[] };
  onRenamed: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const path = (project.repositories?.find((repo) => repo.id === project.primary_repo_id)
    ?? project.repositories?.[0])?.path;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.error?.message ?? "名称保存失败");
      onRenamed(project.id, result.name);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "名称保存失败");
    } finally {
      setSaving(false);
    }
  };
  return <div className="project-name-editor">
    {editing ? <form onSubmit={save} className="project-name-form">
      <label>项目名称 <span className="required-marker" aria-hidden="true">*</span>
        <input aria-label="项目名称" autoFocus required maxLength={100} value={name}
          disabled={saving} onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !saving) setEditing(false); }} />
      </label>
      <button type="submit" disabled={saving || !name.trim()}>保存</button>
      <button type="button" disabled={saving} onClick={() => setEditing(false)}>取消</button>
      {error && <span role="alert">{error}</span>}
    </form> : <>
      <span className="project-name" title={path}>▱ {project.name}</span>
      <button type="button" className="project-name-edit" aria-label={`编辑项目名称：${project.name}`}
        onClick={() => { setName(project.name); setError(""); setEditing(true); }}>✎</button>
    </>}
  </div>;
}
