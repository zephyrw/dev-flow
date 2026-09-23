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
  policyVersion = 1,
  lockedRole,
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
  /** 2 表示策略 2：本流程使用规划与执行两组配置，不展示会无效的高级覆盖。 */
  policyVersion?: number;
  /** 策略 2 下锁定职责组：规划质量修复/提交只能用 planner；执行测试只能用 executor。 */
  lockedRole?: "planner" | "executor";
}) {
  const [open, setOpen] = useState(false);
  const mode = value.selection.mode;
  const roleLabel = repairKind === "quality" ? "审查修复" : "人工问题修复";
  const rememberLabel = `同时设为该任务后续${roleLabel}默认值`;
  const policy2 = policyVersion >= 2;
  const customProfile =
    value.selection.mode === "custom"
      ? value.selection.profile
      : blankProfile(`${name}-custom`, "codex");

  const setMode = (next: RepairSelection["mode"]) => {
    if (policy2 && lockedRole === "planner" && next === "executor") return;
    if (policy2 && lockedRole === "executor" && next === "planner") return;
    if (next === "custom") {
      if (policy2 && lockedRole) return;
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
      {policy2 ? (
        <p className="ms-muted">
          本流程使用规划与执行两组配置
          {lockedRole === "planner"
            ? "；规划质量修复/提交固定使用规划配置"
            : lockedRole === "executor"
              ? "；执行测试固定使用执行配置"
              : ""}
        </p>
      ) : (
        <p className="ms-muted">默认按任务的{roleLabel}配置</p>
      )}
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
          disabled={disabled || (policy2 && lockedRole === "executor")}
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
          disabled={disabled || (policy2 && lockedRole === "planner")}
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
          disabled={disabled || (policy2 && !!lockedRole)}
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
