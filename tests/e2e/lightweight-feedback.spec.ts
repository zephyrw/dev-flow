import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";

test("人工发现功能问题后派发执行，不续接已经完成的质量审查", async ({ page }) => {
  test.setTimeout(600_000);
  const token = fixtureState().shutdownToken;
  const seeded = await page.request.post("/__fixture/feedback", {
    headers: { Origin: "http://localhost:14811" }, data: { token },
  });
  expect(seeded.ok()).toBe(true);
  const fixture = await seeded.json();
  const get = async () => (await page.request.get(`/api/workflows/${fixture.workflow_id}`)).json();
  try {
    await page.goto(`/?workflow=${fixture.workflow_id}`);
    await expect(page.locator(".header-title-wrapper .badge")).toContainText("等待你的验收");
    await page.getByRole("button", { name: "执行过程", exact: true }).click();
    await page.getByRole("button", { name: "指导或提问", exact: true }).click();
    await page.locator(".guidance-form textarea").fill("实际使用时空值显示错误，请按原计划补齐空值处理。");
    const sent = page.waitForResponse((response) => response.url().endsWith(`/workflows/${fixture.workflow_id}/functional-issues`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "发送指导并继续" }).click();
    const response = await sent;
    expect(response.ok(), await response.text()).toBe(true);
    await expect.poll(async () => {
      const workflows = await (await page.request.get("/api/workflows")).json();
      return workflows.find((workflow: any) => workflow.id === fixture.workflow_id)?.state;
    }, { timeout: 300_000 }).toBe("EXECUTING");
    const detail = await get();
    expect(detail.workflow.stage).toBe("execute");
    expect(detail.events.some((event: any) => event.type === "StateChanged" && event.payload.to === "QUEUED" && event.payload.stage === "execute")).toBe(true);
    expect(detail.runs.filter((run: any) => run.id !== fixture.review_run_id).map((run: any) => run.purpose)).toEqual(["implement"]);
    const issues = await (await page.request.get(`/api/workflows/${fixture.workflow_id}/functional-issues`)).json();
    expect(issues).toHaveLength(1);
    expect(issues[0].description).toContain("空值显示错误");
    await page.reload();
    await expect(page.locator(".header-title-wrapper .badge")).toContainText("实施中");
    expect((await get()).runs.filter((run: any) => run.purpose === "quality_review")).toHaveLength(1);
  } finally {
    await page.request.post("/__fixture/feedback/stop", { headers: { Origin: "http://localhost:14811" }, data: { token, workflow_id: fixture.workflow_id } });
  }
});
