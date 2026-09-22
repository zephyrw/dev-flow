import React from "react";
import { AppDialog } from "./AppDialog.js";
import { AgyAccountsPanel } from "./AgyAccountsPanel.js";

export interface AgyAccountsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AgyAccountsDialog({ isOpen, onClose }: AgyAccountsDialogProps) {
  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      title="AGY 账号管理"
      subtitle="管理 Antigravity 账号及自动切换设置"
      width="680px"
    >
      <AgyAccountsPanel onDismiss={onClose} />
    </AppDialog>
  );
}

// 保持向前兼容导出
export const AgyAccountsDrawer = AgyAccountsDialog;
