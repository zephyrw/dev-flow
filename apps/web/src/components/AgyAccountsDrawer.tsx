import React from "react";
import { AgyAccountsPanel } from "./AgyAccountsPanel.js";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export const AgyAccountsDrawer: React.FC<Props> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: "680px",
        maxWidth: "95vw",
        height: "100vh",
        background: "#1e1e2e",
        boxShadow: "-4px 0 20px rgba(0,0,0,0.5)",
        zIndex: 9000,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: "10px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.1)",
        }}
      >
        <button className="agy-btn" onClick={onClose}>
          ✕ 关闭
        </button>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <AgyAccountsPanel />
      </div>
    </div>
  );
};
