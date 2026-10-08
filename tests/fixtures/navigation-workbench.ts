export const navigationProjects = [
  { id: "nav-a", name: "侧栏验收项目" },
  { id: "nav-b", name: "独立展开项目" },
  { id: "nav-five", name: "恰好五个任务" },
];

export const navigationFlows = navigationProjects.flatMap((project, index) =>
  Array.from({ length: index === 2 ? 5 : 7 }, (_, task) => ({
    id: `${project.id}-${task}`,
    project_id: project.id,
    title: task === 0
      ? `${project.name}：这是需要完整显示的超长任务名称，核验任务折叠、侧栏拖动保存和模型对齐`
      : `${project.name}任务 ${task + 1}`,
    state: "PLAN_PENDING",
    version: 1,
    plan_revision: 1,
    environment_revision: 1,
  })),
);

export function navigationResponse(path: string): unknown {
  if (path === "/api/projects") return navigationProjects;
  if (path === "/api/workflows") return navigationFlows;
  if (/\/(asides|functional-issues|diff)$/.test(path)) return [];
  const workflow = navigationFlows.find((flow) => flow.id === path.split("/").at(-1)) ?? navigationFlows[0]!;
  return {
    workflow, tasks: [], runs: [], events: [], evidence: [], runtime: null,
    project: { ...navigationProjects.find((project) => project.id === workflow.project_id), repositories: [], commands: [], data: { mode: "external_lock" } },
    plan: { plan: { task_model: "native-v2", markdown: "# 侧栏与模型布局验收\n\n本页面使用隔离测试数据。" } },
    planner_profile: { adapterId: "codex", modelId: "gpt-6-astra", reasoning: { mode: "explicit", value: "high" } },
    executor_profile: { adapterId: "agy", modelId: "gemini-3.8-flash-high", reasoning: { mode: "explicit", value: "high" } },
  };
}
