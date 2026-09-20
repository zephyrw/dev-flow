import React, { useState } from "react";
import type {
  RepairSelection,
  ToolProfile,
} from "../../../../packages/contracts/src/index.js";
import { ModelProfileEditor } from "./ModelProfileEditor.js";
import { blankProfile, profileSummary } from "./model-api.js";
import "./model-settings.css";

export type RepairPickerValue = {
  selection: RepairSelection;
  rememberForTask: boolean;
};

export function RepairModelPicker({
  value,
  onChange,
  plannerProfile,
  executorProfile,
  currentAssignment,
  inheritedProfile,
  disabled = false,
  name = "repair-handler",
  showRemember = true,
  repairKind = "functional",
}: {
  value: RepairPickerValue;
  onChange: (next: RepairPickerValue) => void;
  plannerProfile?: ToolProfile;
  executorProfile?: ToolProfile;
  currentAssignment?: ToolProfile | null;
  inheritedProfile?: ToolProfile;
  disabled?: boolean;
  name?: string;
  showRemember?: boolean;
  repairKind?: "functional" | "quality";
}) {
  const [open, setOpen] = useState(false);
  const mode = value.selection.mode;
  const roleLabel = repairKind === "quality" ? "审查修复" : "人工问题修复";
  const rememberLabel = `同时设为该任务后续${roleLabel}默认值`;
  const customProfile =
    value.selection.mode === "custom"
      ? value.selection.profile
      : blankProfile(`${name}-custom`, "codex");

  const setMode = (next: RepairSelection["mode"]) => {
    if (next === "custom") {
      onChange({
        ...value,
        selection: { mode: "custom", profile: customProfile },
      });
      return;
    }
    onChange({
      ...value,
      selection: { mode: next },
    });
  };

  return (
    <details
      className="ms-picker"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary>本次修复由谁处理</summary>
      <p className="ms-muted">默认按任务的{roleLabel}配置</p>
      {currentAssignment ? (
        <p className="ms-hint">
          当前批次覆盖：{profileSummary(currentAssignment)}
        </p>
      ) : (
        <p className="ms-hint">
          当前跟随任务配置：{profileSummary(inheritedProfile)}
        </p>
      )}
      <label>
        <input
          type="radio"
          name={name}
          aria-label="按任务配置"
          disabled={disabled}
          checked={mode === "task-default"}
          onChange={() => setMode("task-default")}
        />
        按任务配置
      </label>
      <label>
        <input
          type="radio"
          name={name}
          aria-label="使用规划配置"
          disabled={disabled}
          checked={mode === "planner"}
          onChange={() => setMode("planner")}
        />
        使用规划配置
      </label>
      {mode === "planner" && (
        <p className="ms-hint">
          提交时将使用：{profileSummary(plannerProfile)}
        </p>
      )}
      <label>
        <input
          type="radio"
          name={name}
          aria-label="使用执行配置"
          disabled={disabled}
          checked={mode === "executor"}
          onChange={() => setMode("executor")}
        />
        使用执行配置
      </label>
      {mode === "executor" && (
        <p className="ms-hint">
          提交时将使用：{profileSummary(executorProfile)}
        </p>
      )}
      <label>
        <input
          type="radio"
          name={name}
          aria-label="自定义工具/模型"
          disabled={disabled}
          checked={mode === "custom"}
          onChange={() => setMode("custom")}
        />
        自定义工具/模型
      </label>
      {mode === "custom" && (
        <ModelProfileEditor
          profile={{ ...customProfile, id: `${name}-custom` }}
          toolLabel="修复工具"
          disabled={disabled}
          onChange={(profile) =>
            onChange({
              ...value,
              selection: { mode: "custom", profile },
            })
          }
        />
      )}
      {showRemember && (
        <label>
          <input
            type="checkbox"
            aria-label={rememberLabel}
            disabled={disabled}
            checked={value.rememberForTask}
            onChange={(event) =>
              onChange({ ...value, rememberForTask: event.target.checked })
            }
          />
          {rememberLabel}
        </label>
      )}
    </details>
  );
}

export const defaultRepairPicker = (): RepairPickerValue => ({
  selection: { mode: "task-default" },
  rememberForTask: false,
});
