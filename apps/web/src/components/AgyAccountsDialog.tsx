import React, { useRef, useState } from "react";
import { AppDialog } from "./AppDialog.js";
import { AgyAccountsPanel, type AgyAccountsPanelHandle } from "./AgyAccountsPanel.js";

export interface AgyAccountsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AgyAccountsDialog({ isOpen, onClose }: AgyAccountsDialogProps) {
  const [syncing, setSyncing] = useState(false);
  const panelRef = useRef<AgyAccountsPanelHandle | null>(null);

  const handleSyncRefresh = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      if (panelRef.current) {
        await panelRef.current.syncAndRefresh();
      }
    } catch (err) {
      console.error("同步刷新账号与额度失败:", err);
    } finally {
      setSyncing(false);
    }
  };

  const refreshButton = (
    <button
      type="button"
      className={`agy-header-refresh-btn ${syncing ? "is-spinning" : ""}`}
      onClick={handleSyncRefresh}
      title="刷新没有额度的账号及当前活动账号"
      aria-label="刷新没有额度的账号及当前活动账号"
      disabled={syncing}
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        stroke="currentColor"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 8" />
        <polyline points="21 3 21 8 16 8" />
      </svg>
    </button>
  );

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      title="AGY 账号管理"
      titleExtra={refreshButton}
      subtitle="管理 Antigravity 账号及自动切换设置"
      width="680px"
    >
      <AgyAccountsPanel ref={panelRef} onDismiss={onClose} />
    </AppDialog>
  );
}

// 保持向前兼容导出
export const AgyAccountsDrawer = AgyAccountsDialog;

