import { test, expect } from "@playwright/test";

test("implementation, development checks and final validation remain distinct in the workbench", async ({
  page,
}) => {
  const workflow = {
    id: "wf-progress",
    project_id: "p1",
    title: "真实进度",
    state: "EXECUTING",
    plan_revision: 1,
  };
  const detail = {
    workflow,
    project: { id: "p1", name: "进度测试" },
    plan: {
      plan: { task_model: "leaf-v1", modules: [], tasks: [], tests: [] },
    },
    tasks: [
      {
        id: "T1",
        has_implementation: true,
        development_status: "completed",
        status: "claimed",
      },
    ],
    test_progress: { total: 2, passed: 1, failed: 1, cases: [] },
    events: [],
    runs: [],
    evidence: [],
    attention: null,
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith("/projects")
        ? [detail.project]
        : path.endsWith("/workflows")
          ? [workflow]
          : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=wf-progress");
  const strip = page.getByLabel("交付进度");
  await page.getByRole("button", { name: "任务进度", exact: true }).click();
  await expect(page.getByLabel("实现记录")).toContainText("已提交实现 1/1");
  await expect(
    strip.locator(".metric-chip").filter({ hasText: "开发完成" }),
  ).toContainText("1/1");
  await expect(
    strip.locator(".metric-chip").filter({ hasText: "验证完成" }),
  ).toContainText("0/1");
  await expect(
    strip.locator(".metric-chip").filter({ hasText: "已通过测试" }),
  ).toContainText("1/2");
});

test("a user who switched accounts can retry now without waiting for the old quota timer", async ({
  page,
}) => {
  const workflow = {
    id: "wf-account-switch",
    project_id: "p1",
    title: "账号切换后恢复",
    state: "BLOCKED",
    plan_revision: 1,
    blocker: { code: "MODEL_QUOTA" },
  };
  const detail: any = {
    workflow,
    tasks: [],
    events: [],
    plan: null,
    runs: [],
    evidence: [],
    project: { id: "p1", name: "恢复测试" },
    attention: {
      category: "queue",
      message: "旧账号额度恢复时间：16:22 自动继续。",
      action: "查看执行过程",
    },
  };
  let recovered = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/recover")) {
      recovered = true;
      workflow.state = "QUEUED";
      detail.attention = { category: "queue", message: "已提交，正在安排执行" };
      return route.fulfill({ json: workflow });
    }
    return route.fulfill({
      json: path.endsWith("/projects")
        ? [detail.project]
        : path.endsWith("/workflows")
          ? [workflow]
          : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=" + workflow.id);
  await page.getByRole("button", { name: "立即重试", exact: true }).click();
  await expect.poll(() => recovered).toBe(true);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "排队中",
  );
  await expect(page.locator(".attention-strip")).not.toContainText("16:22");
});

test("quota wait explains automatic continuation and allows cancelling it", async ({
  page,
}) => {
  const workflow = {
    id: "wf-quota",
    project_id: "p1",
    title: "等待额度的任务",
    state: "BLOCKED",
    plan_revision: 1,
    blocker: { code: "MODEL_QUOTA" },
  };
  const detail = {
    workflow,
    tasks: [],
    events: [],
    plan: null,
    runs: [],
    evidence: [],
    project: { id: "p1", name: "测试项目" },
    attention: {
      category: "queue",
      message: "模型额度暂时不足，预计 15:02 自动继续。",
      action: "等待自动继续",
    },
  };
  let stopped = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/stop")) {
      stopped = true;
      workflow.state = "STOPPED";
      detail.attention.category = "paused";
      return route.fulfill({ json: workflow });
    }
    return route.fulfill({
      json: path.endsWith("/projects")
        ? [detail.project]
        : path.endsWith("/workflows")
          ? [workflow]
          : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.locator(".header-title-wrapper .badge")).toContainText(
    "等待模型额度",
  );
  await expect(page.locator(".attention-strip")).toContainText(
    "15:02 自动继续",
  );
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await page.getByRole("button", { name: "暂停自动继续", exact: true }).click();
  await expect.poll(() => stopped).toBe(true);
  await expect(
    page.getByText("已暂停，到点后不会自动继续。", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "暂停自动继续", exact: true }),
  ).toHaveCount(0);
});

test("a technical diagnosis failure offers automatic retry without requiring user troubleshooting text", async ({
  page,
}) => {
  const workflow = {
    id: "wf-diagnosis",
    project_id: "p1",
    title: "后端启动故障",
    state: "WAITING_INPUT",
    stage: "needs_guidance",
    plan_revision: 1,
    blocker: { code: "DIAGNOSIS_FAILED" },
  };
  const detail = {
    workflow,
    tasks: [],
    events: [],
    plan: null,
    runs: [],
    evidence: [],
    project: { id: "p1", name: "测试项目" },
    attention: {
      category: "guidance",
      message:
        "平台的故障诊断调用失败，尚未完成排查。可继续自动排查，无需你解释技术日志。",
      action: "查看执行过程",
    },
    repair: {
      attempts: 3,
      diagnoses: 1,
      user_summary: "后端服务还没有成功启动。",
      instructions: "FlowError: SERVICE_EXITED devflow_request_operation",
    },
  };
  let received: any;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/feedback")) {
      received = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      json: path.endsWith("/projects")
        ? [detail.project]
        : path.endsWith("/workflows")
          ? [workflow]
          : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=" + workflow.id);
  await expect(page.locator(".attention-strip")).not.toContainText("FlowError");
  await expect(page.locator(".attention-strip")).not.toContainText("devflow_");
  await expect(page.locator(".task-interaction textarea")).toHaveCount(0);
  await page.getByRole("button", { name: "继续自动排查", exact: true }).click();
  await expect.poll(() => received?.scope).toBe("within_plan");
  expect(received.text).toContain("继续在原批准范围内自动排查");
});

for (const approved of [true, false])
  test(`workbench ${approved ? "approves" : "rejects"} the exact operation and continues the same task`, async ({
    page,
  }) => {
    const w = {
      id: "wf-authorization",
      project_id: "p1",
      title: "等待授权的任务",
      state: "WAITING_AUTHORIZATION",
      version: 1,
      plan_revision: 1,
      environment_revision: 0,
      updated_at: new Date().toISOString(),
    };
    const operation = {
      id: "operation-1",
      status: "pending",
      fingerprint: "bound-command-hash",
      cwd: "D:\\Project",
      operation: {
        executable: "node",
        args: ["--version"],
        reason: "需要核实当前项目的 Node 运行环境",
      },
    };
    const detail = {
      workflow: w,
      attention: {
        category: "authorization",
        message: "等待操作授权",
        action: "查看待授权操作",
        at: w.updated_at,
      },
      operations: [operation],
      tasks: [],
      test_progress: { total: 0, passed: 0, cases: [] },
      plan: null,
      events: [],
      runs: [],
      evidence: [],
      project: {
        id: "p1",
        name: "授权测试",
        repositories: [],
        commands: [],
        services: [],
      },
    };
    let received: any;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/decision")) {
        received = route.request().postDataJSON();
        operation.status = approved ? "approved" : "denied";
        w.state = "QUEUED";
        w.version++;
        await route.fulfill({ json: w });
        return;
      }
      await route.fulfill({
        json: url.pathname.endsWith("/projects")
          ? [detail.project]
          : url.pathname.endsWith("/workflows")
            ? [w]
            : detail,
      });
    });
    await page.routeWebSocket("**/api/notifications", () => {});
    await page.routeWebSocket("**/api/events?*", () => {});
    await page.goto("/?workflow=" + w.id);
    await expect(
      page.getByRole("heading", { name: "操作等待你的授权" }),
    ).toBeVisible();
    await expect(page.locator(".authorization-card")).toContainText(
      "--version",
    );
    await page
      .getByLabel("授权处理意见（可选）")
      .fill("处理后继续原任务，不要重新开发。");
    await page
      .getByRole("button", {
        name: approved ? "批准本次操作并继续" : "拒绝并告知模型",
      })
      .click();
    await expect
      .poll(() => received)
      .toEqual({
        approved,
        fingerprint: "bound-command-hash",
        note: "处理后继续原任务，不要重新开发。",
      });
    await expect(page.locator(".authorization-card")).toHaveCount(0);
    await expect(page.locator(".header-title-wrapper .badge")).toContainText(
      "排队中",
    );
  });

test("guidance remains available in a recovered task and is sent without starting another workflow", async ({
  page,
}) => {
  const w = {
    id: "wf-guidance",
    project_id: "p1",
    title: "恢复中的任务",
    state: "RECOVERY_REQUIRED",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
  };
  const detail = {
    workflow: w,
    tasks: [],
    test_progress: { total: 0, passed: 0, cases: [] },
    plan: null,
    events: [],
    runs: [],
    evidence: [],
    project: {
      id: "p1",
      name: "指导测试",
      repositories: [],
      commands: [],
      services: [],
    },
  };
  let received: any;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/feedback")) {
      received = route.request().postDataJSON();
      w.state = "QUEUED";
      w.version++;
      await route.fulfill({ json: w });
      return;
    }
    await route.fulfill({
      json: path.endsWith("/projects")
        ? [detail.project]
        : path.endsWith("/workflows")
          ? [w]
          : detail,
    });
  });
  await page.routeWebSocket("**/api/notifications", () => {});
  await page.routeWebSocket("**/api/events?*", () => {});
  await page.goto("/?workflow=" + w.id);
  await page.getByRole("button", { name: "执行过程", exact: true }).click();
  await page
    .getByRole("button", { name: "给执行模型补充指导", exact: true })
    .click();
  await page
    .locator(".guidance-form textarea")
    .fill("读取启动日志，修复报错并继续测试。");
  await page.getByRole("button", { name: "发送指导并继续" }).click();
  await expect
    .poll(() => received)
    .toEqual({
      text: "读取启动日志，修复报错并继续测试。",
      scope: "within_plan",
    });
});
