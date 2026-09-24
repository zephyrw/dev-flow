import React, { useState, useEffect } from "react";
import { AppDialog } from "./AppDialog.js";
import { DefaultModelsPanel } from "./DefaultModelsPanel.js";
import { ArchivedWorkflowsPanel } from "./ArchivedWorkflowsPanel.js";

export type SettingsTabId = "models" | "archives";

export interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: SettingsTabId;
  onDefaultsUpdated?: () => void;
  onSelectWorkflow?: (workflowId: string) => void;
  onWorkflowRestored?: (workflowId: string) => void;
}

export function SettingsDialog({
  isOpen,
  onClose,
  initialTab = "models",
  onDefaultsUpdated,
  onSelectWorkflow,
  onWorkflowRestored,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab);
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
      setIsDirty(false);
    }
  }, [isOpen, initialTab]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      title="设置"
      width={760}
      isDirty={isDirty}
    >
      <div className="settings-dialog-container" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        {/* 一级 Tab 导航栏 */}
        <div
          className="settings-nav-tabs"
          role="tablist"
          aria-label="设置"
          style={{
            display: "flex",
            gap: "8px",
            borderBottom: "1px solid var(--border-color, #e5e7eb)",
            paddingBottom: "8px",
            marginBottom: "4px",
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "models"}
            className={`btn ${activeTab === "models" ? "btn-primary" : "btn-secondary"}`}
            style={{ fontSize: "14px", padding: "6px 16px" }}
            onClick={() => setActiveTab("models")}
          >
            默认模型
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "archives"}
            className={`btn ${activeTab === "archives" ? "btn-primary" : "btn-secondary"}`}
            style={{ fontSize: "14px", padding: "6px 16px" }}
            onClick={() => setActiveTab("archives")}
          >
            归档
          </button>
        </div>

        {/* Tab 内容区 */}
        <div className="settings-tab-content">
          <div style={{ display: activeTab === "models" ? "block" : "none" }}>
            <DefaultModelsPanel
              onDefaultsUpdated={onDefaultsUpdated}
              onDirtyChange={setIsDirty}
              onClose={onClose}
            />
          </div>

          <div style={{ display: activeTab === "archives" ? "block" : "none" }}>
            <ArchivedWorkflowsPanel
              onSelectWorkflow={(workflowId) => {
                onClose();
                onSelectWorkflow?.(workflowId);
              }}
              onWorkflowRestored={onWorkflowRestored}
            />
          </div>
        </div>
      </div>
    </AppDialog>
  );
}
