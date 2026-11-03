import React, { useState } from "react";
import { AppDialog } from "./AppDialog.js";

export function NameEditDialog({ label, initialName, maxLength, onSave, onClose }: {
  label: string;
  initialName: string;
  maxLength: number;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || Array.from(name.trim()).length > maxLength || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(name.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "名称保存失败");
    } finally {
      setSaving(false);
    }
  };
  return <AppDialog isOpen title={`修改${label}`} width={440} busy={saving} onClose={onClose}>
    <form onSubmit={save} className="name-edit-form">
      <label>{label} <span className="required-marker" aria-hidden="true">*</span>
        <input aria-label={label} required maxLength={maxLength} value={name}
          disabled={saving} onChange={(event) => setName(event.target.value)} />
      </label>
      <p className="name-edit-hint">最多 {maxLength} 字</p>
      {error && <p role="alert">{error}</p>}
      <div className="name-dialog-actions">
        <button type="button" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={saving || !name.trim() || Array.from(name.trim()).length > maxLength}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  </AppDialog>;
}
