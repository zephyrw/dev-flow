import { test, expect } from "@playwright/test";

test("E02 — worktree 前后端多实例浏览器环境隔离（数据不互串、刷新保持独立）", async ({
  page,
}) => {
  // 模拟两个独立 worktree 实例各自的后端数据
  const instanceAWorkflows = [
    {
      id: "wf-inst-a-1",
      project_id: "p-a",
      title: "Worktree A 的独立工作流",
      state: "EXECUTING",
      plan_revision: 1,
    },
  ];

  const instanceBWorkflows = [
    {
      id: "wf-inst-b-1",
      project_id: "p-b",
      title: "Worktree B 的独立工作流",
      state: "PLANNING",
      plan_revision: 1,
    },
  ];

  let currentActiveInstance: "A" | "B" = "A";

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    // 模拟不同实例 API 隔离响应
    const workflows =
      currentActiveInstance === "A" ? instanceAWorkflows : instanceBWorkflows;

    if (path.endsWith("/workflows")) {
      if (route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData() || "{}");
        const newWf = {
          id: `wf-${currentActiveInstance.toLowerCase()}-${Date.now()}`,
          project_id: `p-${currentActiveInstance.toLowerCase()}`,
          title: body.title || "新增工作流",
          state: "EXECUTING",
          plan_revision: 1,
        };
        workflows.push(newWf);
        return route.fulfill({ status: 200, json: newWf });
      }
      return route.fulfill({ status: 200, json: workflows });
    }

    if (path.endsWith("/projects")) {
      return route.fulfill({
        status: 200,
        json: [
          {
            id: `p-${currentActiveInstance.toLowerCase()}`,
            name: `项目 ${currentActiveInstance}`,
          },
        ],
      });
    }

    if (path.includes("/workflows/")) {
      const match = workflows.find((w) => path.includes(w.id));
      return route.fulfill({
        status: 200,
        json: {
          workflow: match || workflows[0],
          project: { id: `p-${currentActiveInstance.toLowerCase()}` },
          plan: null,
          tasks: [],
          events: [],
          runs: [],
          evidence: [],
        },
      });
    }

    return route.fulfill({ json: [] });
  });

  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});

  // 1. 访问实例 A
  currentActiveInstance = "A";
  await page.goto("/?workflow=wf-inst-a-1");
  await expect(page.locator("body")).toContainText("Worktree A 的独立工作流");
  await expect(page.locator("body")).not.toContainText("Worktree B 的独立工作流");

  // 2. 模拟切换至实例 B（不同端口/独立环境）
  currentActiveInstance = "B";
  await page.goto("/?workflow=wf-inst-b-1");
  await expect(page.locator("body")).toContainText("Worktree B 的独立工作流");
  await expect(page.locator("body")).not.toContainText("Worktree A 的独立工作流");

  // 3. 再次切回实例 A，验证数据完全隔离且保持原样
  currentActiveInstance = "A";
  await page.goto("/?workflow=wf-inst-a-1");
  await expect(page.locator("body")).toContainText("Worktree A 的独立工作流");
});
