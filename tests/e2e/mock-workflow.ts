import type { Page } from "@playwright/test";
import type { Project } from "../../packages/contracts/src/index.js";

export function mockProject(id = "p1", name = "隔离展示项目"): Project {
  return { id, name, repositories: [{ id: "main", path: "/isolated-display-project" }],
    commands: [], services: [], browser_scenes: [], data: { mode: "directory" } };
}

/** Display-only tests use the same required model configuration fields as API projections. */
export async function installMockWorkflowConfiguration(page: Page, workflowVersion = 1) {
  await page.route(url => /\/workflows\/[^/]+\/(execution-spec|functional-issue-views)$/.test(url.pathname), route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/functional-issue-views")) return route.fulfill({ json: [] });
    const workflowId = path.split("/").at(-2)!;
    const profile = { id: "display-profile", revision: 1, adapterId: "codex", executableRef: "fixture-only",
      modelSelection: "explicit", modelId: "fixture-only", options: {} };
    return route.fulfill({ json: {
      spec: { id: "display-spec", workflow_id: workflowId, revision: 1,
        plannerProfile: { ...profile, id: "display-planner" }, executorProfile: { ...profile, id: "display-executor" },
        roleOverrides: { reviewer: { mode: "inherit" }, review_fixer: { mode: "inherit" }, functional_fixer: { mode: "inherit" } },
        mode: "single_tool", template_id: "native-development", template_revision: 1, created_at: "2026-10-10T00:00:00Z" },
      spec_revision: 1, workflow_version: workflowVersion, policy_version: 2, can_edit: true,
    } });
  });
}
