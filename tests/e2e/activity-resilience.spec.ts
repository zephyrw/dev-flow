import { installMockWorkflowConfiguration, mockProject } from "./mock-workflow.js";
import { test, expect } from "@playwright/test";
import { openExecutionSidebar } from "./native-helper.js";

test.describe("H02 Activity & Guidance Resilience", () => {
  test("H02-C01: functional-issues 返回对象时显示局部错误，不崩溃且无 pageerror，控制区与进度可操作", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    const workflow = {
      id: "wf-c01",
      project_id: "p1",
      title: "C01 容错测试",
      state: "EXECUTING",
      plan_revision: 1,
    };
    const detail = {
      workflow,
      project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "C01 项目" },
      plan: {
        plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] },
      },
      tasks: [
        {
          id: "T1",
          has_implementation: true,
          development_status: "running",
          status: "claimed",
        },
      ],
      test_progress: { total: 1, passed: 0, failed: 0, cases: [] },
      events: [],
      runs: [],
      evidence: [],
      attention: null,
    };

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/functional-issues")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ notAnArray: true }),
        });
      }
      if (path.endsWith("/asides")) {
        return route.fulfill({ json: [] });
      }
      if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
      if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
      return route.fulfill({ json: detail });
    });

    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});

    await installMockWorkflowConfiguration(page);
    await page.goto("/?workflow=wf-c01");
    await page.getByRole("button", { name: /^规划模型：/ }).click();

    // 验证局部错误展示
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("任务反馈响应格式无效");
    await page.keyboard.press("Escape");

    // 验证页面控制按钮和任务进度仍然可操作，页面主体正常存在
    const strip = page.getByLabel("交付进度");
    await expect(strip).toBeVisible();
    await page.getByRole("button", { name: "任务进度", exact: true }).click();
    await expect(page.getByLabel("实现记录")).toBeVisible();

    // 确认无 pageerror
    expect(pageErrors.length).toBe(0);
  });

  test("H02-C02: 项目提问返回无效分页时显示局部错误，恢复后刷新错误消失且无 pageerror", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    let returnValid = false;
    const workflow = {
      id: "wf-c02",
      project_id: "p1",
      title: "C02 恢复测试",
      state: "EXECUTING",
      plan_revision: 1,
    };
    const detail = {
      workflow,
      project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "C02 项目" },
      plan: {
        plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] },
      },
      tasks: [],
      test_progress: { total: 0, passed: 0, failed: 0, cases: [] },
      events: [],
      runs: [],
      evidence: [],
      attention: null,
    };

    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/functional-issues")) {
        return route.fulfill({ json: [] });
      }
      if (path.endsWith("/conversation-messages")) return route.fulfill({ json: { client_mode: "btw", aside_id: "aside-c02", message_id: "msg-c02" } });
      if (path.endsWith("/position")) return route.fulfill({ json: { index: 1, total: 1 } });
      if (path.endsWith("/aside-updates")) return route.fulfill({ json: { items: [], snapshot_cursor: 1 } });
      if (path.endsWith("/asides/aside-c02")) return route.fulfill({ json: { id: "aside-c02", workflow_id: workflow.id, question: "查询项目提问历史", answer: "历史已恢复", status: "completed", created_at: new Date().toISOString() } });
      if (path === "/api/projects/p1/asides") {
        return route.fulfill({ json: returnValid ? { items: [{ id: "aside-c02", project_id: "p1", workflow_id: workflow.id, workflow_title: workflow.title, question_preview: "查询项目提问历史", status: "completed", created_at: new Date().toISOString() }], total: 1, next_cursor: null, snapshot_cursor: 1 } : { bad: "structure" } });
      }
      if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
      if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
      return route.fulfill({ json: detail });
    });

    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});

    await installMockWorkflowConfiguration(page);
    await page.goto("/?workflow=wf-c02");
    await openExecutionSidebar(page);
    await page.locator(".conversation-composer-input").fill("/btw 查询项目提问历史");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("项目提问响应格式无效");
    await expect(page.getByRole("button", { name: "历史提问" })).toHaveCount(0);

    returnValid = true;
    await page.reload();

    await page.locator(".conversation-composer-input").fill("/btw 查询项目提问历史");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(page.locator(".aside-popover")).toContainText("历史已恢复");
    await expect(page.getByRole("alert")).not.toBeVisible();
    expect(pageErrors.length).toBe(0);
  });

  test("H02-C03: 切换任务时立即清理旧任务问题，延迟响应期间不展示A的可操作问题", async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    const wfA = {
      id: "wf-a",
      project_id: "p1",
      title: "任务 A",
      state: "HUMAN_PENDING",
      plan_revision: 1,
      version: 1,
    };
    const wfB = {
      id: "wf-b",
      project_id: "p1",
      title: "任务 B",
      state: "HUMAN_PENDING",
      plan_revision: 1,
      version: 1,
    };

    const detailA = {
      workflow: wfA,
      project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "项目" },
      plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } },
      tasks: [],
      test_progress: { total: 0, passed: 0, failed: 0, cases: [] },
      events: [],
      runs: [],
      evidence: [],
      attention: null,
    };
    const detailB = {
      workflow: wfB,
      project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "项目" },
      plan: { plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] } },
      tasks: [],
      test_progress: { total: 0, passed: 0, failed: 0, cases: [] },
      events: [],
      runs: [],
      evidence: [],
      attention: null,
    };

    let delayBResponses = false;
    let bResolver: (() => void) | null = null;

    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;

      if (path.endsWith("/workflows")) {
        return route.fulfill({ json: [wfA, wfB] });
      }
      if (path.endsWith("/projects")) {
        return route.fulfill({ json: [{ id: "p1", name: "项目" }] });
      }
      if (path === "/api/workflows/wf-a") {
        return route.fulfill({ json: detailA });
      }
      if (path === "/api/workflows/wf-b") {
        return route.fulfill({ json: detailB });
      }

      if (path.includes("/wf-a/functional-issues")) {
        return route.fulfill({
          json: [
            {
              issue_id: "issue-a-1",
              description: "A任务遗留问题",
              status: "ready_for_retest",
              fix_delivery_id: "del-a",
            },
          ],
        });
      }
      if (path.includes("/wf-a/asides")) {
        return route.fulfill({ json: [] });
      }

      if (path.includes("/wf-b/functional-issues") || path.includes("/wf-b/asides")) {
        if (delayBResponses) {
          await new Promise<void>((resolve) => {
            bResolver = resolve;
          });
        }
        return route.fulfill({ json: [] });
      }

      return route.fulfill({ json: {} });
    });

    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});

    // 先进入 A 并打开执行过程侧栏
    await installMockWorkflowConfiguration(page);
    await page.goto("/?workflow=wf-a");
    await page.getByRole("button", { name: /^规划模型：/ }).click();
    await expect(page.getByText("A任务遗留问题")).toBeVisible();
    await expect(page.getByRole("button", { name: "复测通过" })).toBeVisible();

    // 启用对 B 的列表响应延迟
    delayBResponses = true;

    // 切换到 B
    await page.keyboard.press("Escape");
    await page.locator(".flow-nav-btn").filter({ hasText: wfB.title }).click();
    await page.getByRole("button", { name: /^规划模型：/ }).click();

    // 在 B 响应延迟期间，任务 A 的问题和按钮必须已被清理，不得展示
    await expect(page.getByRole("button", { name: "复测通过" })).not.toBeVisible();
    await expect(page.getByText("A任务遗留问题")).not.toBeVisible();

    // 释放 B 的延迟
    if (bResolver) (bResolver as () => void)();

    expect(pageErrors.length).toBe(0);
  });

  for (const submission of ["button", "keyboard"] as const) {
  test(`H02-C04: ${submission}提交409保留全文和引用且无未处理错误`, async ({
    page,
  }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    const workflow = {
      id: "wf-c04",
      project_id: "p1",
      title: "C04 保留草稿测试",
      state: "EXECUTING",
      plan_revision: 1,
    };
    const detail = {
      workflow,
      project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "C04 项目" },
      plan: {
        plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] },
      },
      tasks: [],
      test_progress: { total: 0, passed: 0, failed: 0, cases: [] },
      events: [],
      runs: [],
      evidence: [],
      attention: null,
    };

    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;

      if (path.endsWith("/references")) {
        return route.fulfill({
          json: {
            items: [
              {
                ref_id: "ref-1",
                repo_id: "r1",
                relative_path: "src/main.ts",
                kind: "file",
              },
            ],
          },
        });
      }

      if (path.endsWith("/conversation-messages")) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "CONFLICT", message: "版本冲突，任务状态已变更" },
          }),
        });
      }

      if (path.endsWith("/functional-issues") || path.endsWith("/asides")) {
        return route.fulfill({ json: [] });
      }
      if (path.endsWith("/projects")) return route.fulfill({ json: [detail.project] });
      if (path.endsWith("/workflows")) return route.fulfill({ json: [workflow] });
      return route.fulfill({ json: detail });
    });

    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});

    await installMockWorkflowConfiguration(page);
    await page.goto("/?workflow=wf-c04");

    const textarea = page.locator(".conversation-composer-input");
    await expect(textarea).toBeVisible();
    await textarea.fill("请参考文件 @");

    // 弹出候选并选择
    await expect(page.locator(".reference-popup")).toBeVisible();
    await page.evaluate(() => {
      const control = { original: window.requestAnimationFrame, callbacks: [] as FrameRequestCallback[] };
      (window as any).__referenceFrames = control;
      window.requestAnimationFrame = callback => { control.callbacks.push(callback); return control.callbacks.length; };
    });
    await page.getByText("src/main.ts").click();
    // A real user can type before a deferred caret callback runs. Do not wait
    // for the reference callback: deliver the first character, then that frame.
    await textarea.pressSequentially("继");
    await page.evaluate(() => {
      const control = (window as any).__referenceFrames as { original: typeof requestAnimationFrame; callbacks: FrameRequestCallback[] };
      window.requestAnimationFrame = control.original;
      delete (window as any).__referenceFrames;
      for (const callback of control.callbacks) callback(performance.now());
    });
    await textarea.pressSequentially("续优化");

    // 点击提交
    if (submission === "button") await page.getByRole("button", { name: "发送", exact: true }).click();
    else await textarea.press("Control+Enter");

    // 409 返回后，错误提示可见
    await expect(page.getByRole("alert")).toContainText("版本冲突");

    // 输入框仍然可见（未关闭）
    await expect(textarea).toBeVisible();

    // 检查输入框内容保留
    await expect(textarea).toHaveValue("请参考文件 @src/main.ts 继续优化");

    // 检查 @ 引用 tag 标签依然保留
    await expect(page.locator(".conversation-composer-ref")).toContainText("src/main.ts");

    // 确认未提示成功
    await expect(page.getByText("已保存，正在继续这个任务。")).not.toBeVisible();
    expect(pageErrors).toEqual([]);
  });

  }

  test("H02-C05: 历史补拉第一页立即显示，不等待更早页返回", async ({
    page,
  }) => {
    const workflow = {
      id: "wf-catchup-first",
      project_id: "p1",
      title: "首批补拉",
      state: "EXECUTING",
      plan_revision: 1,
    };
    const detail = {
      workflow,
      project: { ...mockProject(), data: { mode: "directory" }, id: "p1", name: "补拉项目" },
      plan: {
        plan: { task_model: "native-v2", modules: [], tasks: [], tests: [] },
      },
      tasks: [],
      test_progress: { total: 0, passed: 0, failed: 0, cases: [] },
      events: [],
      runs: [],
      evidence: [],
      attention: null,
    };
    const olderRequest: { release?: () => void } = {};
    const older = new Promise<void>((resolve) => {
      olderRequest.release = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path.endsWith("/history")) {
        const before = url.searchParams.get("before");
        if (!before) {
          return route.fulfill({
            json: {
              events: [
                {
                  workflow_id: workflow.id,
                  event_seq: 9001,
                  type: "StateChanged",
                  created_at: new Date().toISOString(),
                  payload: { to: "REVIEW_QUEUED", stage: "quality_before_human" },
                },
              ],
              next_before: 9001,
            },
          });
        }
        await older;
        return route.fulfill({
          json: {
            events: [
              {
                workflow_id: workflow.id,
                event_seq: 1,
                type: "StateChanged",
                created_at: new Date().toISOString(),
                payload: { to: "QUEUED" },
              },
            ],
            next_before: null,
          },
        });
      }
      if (path.endsWith("/functional-issues") || path.endsWith("/asides")) {
        return route.fulfill({ json: [] });
      }
      if (path.endsWith("/projects")) {
        return route.fulfill({ json: [detail.project] });
      }
      if (path.endsWith("/workflows")) {
        return route.fulfill({ json: [workflow] });
      }
      return route.fulfill({ json: detail });
    });
    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});
    await installMockWorkflowConfiguration(page);
    await page.goto("/?workflow=wf-catchup-first");
    await openExecutionSidebar(page);
    const sidebar = page.getByRole("region", { name: "执行过程侧栏" });
    await expect(sidebar.getByText("等待规划模型审查")).toBeVisible();
    await expect(sidebar.getByText("等待可用执行资源。")).toHaveCount(0);
    olderRequest.release?.();
  });
});
