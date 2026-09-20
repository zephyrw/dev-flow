import React from "react";
import { AgyAccountsPanel } from "./AgyAccountsPanel.js";

export const AgyAccountsPage: React.FC = () => {
  return (
    <div style={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      <AgyAccountsPanel />
    </div>
  );
};
