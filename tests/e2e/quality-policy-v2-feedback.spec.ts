import { test, expect } from "@playwright/test";
import { fixtureState } from "./native-helper.js";

test("API 直提功能问题应派发 functional_fix 并进入 EXECUTING", async ({ request }) => {
  test.setTimeout(120_000);
  const token = fixtureState().shutdownToken;
  const seeded = await request.post("/__fixture/feedback", {
    headers: { Origin: "http://localhost:14811" },
    data: { token },
  });
  expect(seeded.ok()).toBe(true);
  const fixture = await seeded.json();
  try {
    const before = await (await request.get(`/api/workflows/${fixture.workflow_id}`)).json();
    expect(before.workflow.state).toBe("HUMAN_PENDING");
    const response = await request.post(
      `/api/workflows/${fixture.workflow_id}/functional-issues`,
      {
        headers: { Origin: "http://localhost:14811" },
        data: {
          request_id: "11111111-1111-4111-8111-111111111111",
          text: "实际使用时空值显示错误，请按原计划补齐空值处理。",
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    // 轮询状态到 EXECUTING
    let state = "";
    for (let i = 0; i < 40; i++) {
      const detail = await (await request.get(`/api/workflows/${fixture.workflow_id}`)).json();
      state = detail.workflow.state;
      if (state === "EXECUTING" || state === "BLOCKED" || state === "WAITING_INPUT") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const detail = await (await request.get(`/api/workflows/${fixture.workflow_id}`)).json();
    console.log("final state:", detail.workflow.state, "stage:", detail.workflow.stage);
    console.log("runs:", detail.runs.map((r: any) => ({ id: r.id, purpose: r.purpose, status: r.status })));
    expect(["EXECUTING", "QUEUED"]).toContain(detail.workflow.state);
    const purposes = detail.runs
      .filter((run: any) => run.id !== fixture.review_run_id)
      .map((run: any) => run.purpose);
    expect(purposes).toContain("functional_fix");
  } finally {
    await request.post("/__fixture/feedback/stop", {
      headers: { Origin: "http://localhost:14811" },
      data: { token, workflow_id: fixture.workflow_id },
    });
  }
});
