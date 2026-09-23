import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";

test("人工发现功能问题后派发执行，不续接已经完成的质量审查", async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  const token = fixtureState().shutdownToken;
  const seeded = await request.post("/__fixture/feedback", {
    headers: { Origin: "http://localhost:14811" },
    data: { token },
  });
  expect(seeded.ok()).toBe(true);
  const fixture = await seeded.json();
  const get = async () =>
    (await request.get(`/api/workflows/${fixture.workflow_id}`)).json();
  try {
    await page.goto(`/?workflow=${fixture.workflow_id}`);
    await expect(page.locator(".header-title-wrapper .badge")).toContainText(
      "等待你的验收",
    );
    // 通过真实 HTTP API 提交功能问题（与 UI 同一端点）
    const response = await request.post(
      `/api/workflows/${fixture.workflow_id}/functional-issues`,
      {
        headers: { Origin: "http://localhost:14811" },
        data: {
          request_id: "22222222-2222-4222-8222-222222222222",
          text: "实际使用时空值显示错误，请按原计划补齐空值处理。",
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    await expect
      .poll(
        async () => (await get()).workflow.state,
        { timeout: 60_000 },
      )
      .toBe("EXECUTING");
    const detail = await get();
    // stage 反映真实用途：策略 2 功能修复显示 functional_fix
    expect(detail.workflow.stage).toBe("functional_fix");
    expect(
      detail.events.some(
        (event: any) =>
          event.type === "StateChanged" && event.payload.to === "QUEUED",
      ),
    ).toBe(true);
    // 策略 2：功能反馈派发 functional_fix
    expect(
      detail.runs
        .filter((run: any) => run.id !== fixture.review_run_id)
        .map((run: any) => run.purpose),
    ).toEqual(["functional_fix"]);
    const issues = await (
      await request.get(`/api/workflows/${fixture.workflow_id}/functional-issues`)
    ).json();
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("空值显示错误");
    await page.reload();
    await expect(page.locator(".header-title-wrapper .badge")).toContainText(
      "实施中",
    );
    // 不续接已完成的质量审查：quality_review 仍只有 1 条
    expect(
      (await get()).runs.filter((run: any) => run.purpose === "quality_review"),
    ).toHaveLength(1);
  } finally {
    await request.post("/__fixture/feedback/stop", {
      headers: { Origin: "http://localhost:14811" },
      data: { token, workflow_id: fixture.workflow_id },
    });
  }
});
