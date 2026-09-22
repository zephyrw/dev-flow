import React from "react";
import type { ToolProfile, RoleOverrides } from "../../../../packages/contracts/src/index.js";
import { ModelProfileEditor } from "./ModelProfileEditor.js";
import { formatToolName, formatModelName } from "../../../../packages/presentation/src/model-display.js";

export type ConfigTabId = "planner" | "executor" | "reviewer" | "review_fixer" | "functional_fixer";

export interface ConfigTabItem {
  id: ConfigTabId;
  label: string;
  inheritable?: boolean;
  defaultInheritSource?: "planner" | "executor";
}

export interface ModelConfigTabsProps {
  tabs: ConfigTabItem[];
  activeTab: ConfigTabId;
  onTabChange: (tabId: ConfigTabId) => void;
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  overrides?: RoleOverrides;
  onPlannerChange: (profile: ToolProfile) => void;
  onExecutorChange: (profile: ToolProfile) => void;
  onOverrideChange?: (role: "reviewer" | "review_fixer" | "functional_fixer", mode: "inherit" | "explicit", profile?: ToolProfile) => void;
  disabled?: boolean;
}

export function ModelConfigTabs({
  tabs,
  activeTab,
  onTabChange,
  plannerProfile,
  executorProfile,
  overrides,
  onPlannerChange,
  onExecutorChange,
  onOverrideChange,
  disabled = false,
}: ModelConfigTabsProps) {
  // 当前角色是否是附加的角色
  const isOverrideRole =
    activeTab === "reviewer" ||
    activeTab === "review_fixer" ||
    activeTab === "functional_fixer";

  const currentOverride = isOverrideRole && overrides ? overrides[activeTab] : null;
  const isInherited = currentOverride ? currentOverride.mode === "inherit" : false;

  const activeTabConfig = tabs.find((t) => t.id === activeTab);
  const inheritSource = activeTabConfig?.defaultInheritSource ?? (activeTab === "reviewer" ? "planner" : "executor");
  const inheritedProfile = inheritSource === "planner" ? plannerProfile : executorProfile;

  return (
    <div className="ms-tabs-container">
      {/* 顶部 Tab 栏 */}
      <div className="ms-tabs-nav" role="tablist" aria-label="配置职责切换">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`ms-tab-btn ${isActive ? "is-active" : ""}`}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab 内容区 */}
      <div className="ms-tabs-content">
        {activeTab === "planner" && (
          <ModelProfileEditor
            profile={plannerProfile}
            toolLabel="工具"
            disabled={disabled}
            onChange={onPlannerChange}
          />
        )}

        {activeTab === "executor" && (
          <ModelProfileEditor
            profile={executorProfile}
            toolLabel="工具"
            disabled={disabled}
            onChange={onExecutorChange}
          />
        )}

        {isOverrideRole && currentOverride && (
          <div className="ms-override-section">
            <div className="ms-inherit-selector">
              <label className="ms-radio-label">
                <input
                  type="radio"
                  name={`inherit-${activeTab}`}
                  checked={isInherited}
                  disabled={disabled}
                  onChange={() => {
                    onOverrideChange?.(activeTab, "inherit");
                  }}
                />
                <span>同{inheritSource === "planner" ? "规划" : "执行"}</span>
              </label>

              <label className="ms-radio-label">
                <input
                  type="radio"
                  name={`inherit-${activeTab}`}
                  checked={!isInherited}
                  disabled={disabled}
                  onChange={() => {
                    const profileToUse =
                      currentOverride.mode === "explicit"
                        ? currentOverride.profile
                        : { ...inheritedProfile, id: activeTab };
                    onOverrideChange?.(activeTab, "explicit", profileToUse);
                  }}
                />
                <span>单独选择</span>
              </label>
            </div>

            {isInherited ? (
              <div className="ms-inherit-hint">
                跟随{inheritSource === "planner" ? "规划" : "执行"}配置：
                <strong>
                  {formatToolName(inheritedProfile.adapterId)} · {formatModelName(inheritedProfile.adapterId, inheritedProfile.modelId)}
                </strong>
              </div>
            ) : (
              <ModelProfileEditor
                profile={
                  currentOverride.mode === "explicit"
                    ? currentOverride.profile
                    : { ...inheritedProfile, id: activeTab }
                }
                toolLabel="工具"
                disabled={disabled}
                onChange={(p) => onOverrideChange?.(activeTab, "explicit", p)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
