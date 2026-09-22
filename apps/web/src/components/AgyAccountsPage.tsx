import React from "react";
import { AgyAccountsPanel } from "./AgyAccountsPanel.js";

export const AgyAccountsPage: React.FC = () => {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#f8fafc",
        display: "flex",
        justifyContent: "center",
        padding: "40px 20px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "760px",
          background: "#ffffff",
          borderRadius: "12px",
          border: "1px solid #e2e8f0",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.05)",
          padding: "24px",
          height: "fit-content",
        }}
      >
        <AgyAccountsPanel />
      </div>
    </div>
  );
};
