import type { RunObservation } from "../../contracts/src/run-observation.js";

export function visibleRunObservation(detail: any): RunObservation | null {
  const id = detail?.workflow?.run_id;
  if (!id) return null;
  let observation: RunObservation | undefined =
    detail.runtime?.run_id === id ? detail.runtime : undefined;
  for (const event of detail.events ?? []) {
    if (
      event.type === "RunObserved" &&
      event.workflow_id === detail.workflow.id &&
      event.run_id === id &&
      event.payload?.run_id === id &&
      (!observation ||
        Date.parse(event.payload.updated_at) >=
          Date.parse(observation.updated_at))
    )
      observation = event.payload;
  }
  if (observation) return observation;
  const run = detail.runs?.find((r: any) => r.id === id);
  if (!run) return null;
  return {
    run_id: id,
    adapter: run.profile?.adapterId ?? run.adapter,
    purpose: run.purpose,
    requested_model: run.profile?.modelId,
    started_at: run.started_at,
    updated_at: run.started_at,
    status: run.status === "running" ? "starting" : "exited",
    active_tools: 0,
  };
}

export const runtimeToolNames: Record<string, string> = {
  codex: "Codex CLI",
  agy: "Antigravity CLI",
  "claude-code": "Claude Code",
  "grok-build": "Grok Build",
  "kimi-code": "Kimi Code",
  qoder: "Qoder",
  opencode: "OpenCode",
  "cursor-agent": "Cursor Agent",
};
export const runtimePurposeNames: Record<string, string> = {
  planning: "规划模型 · 制定计划",
  implement: "执行模型 · 开发实施",
  planner_takeover: "规划模型 · 接手修复",
  plan_self_check: "计划自查",
  quality_review: "规划模型 · 独立复核",
  functional_fix: "功能修复",
  aside: "临时提问",
  merge_conflict: "解决合并冲突",
};
