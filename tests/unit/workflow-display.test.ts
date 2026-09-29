import { expect, it } from "vitest";
import { workflowProgress } from "../../packages/presentation/src/activity.js";

it.each(["QUEUED", "EXECUTING", "STOPPED"])("keeps acceptance guidance in human acceptance while %s", state => {
  const events = [{ workflow_id: "w", event_seq: 1, type: "StateChanged",
    payload: { from: "QUEUED", to: "EXECUTING", stage: "acceptance_guidance" } }];
  for (const native of [true, false]) {
    const p = workflowProgress({ id: "w", state, stage: state === "STOPPED" ? "stopped" : "acceptance_guidance" }, events, { native });
    expect(p.title).toBe("人工验收");
    expect(p.done[p.stages.indexOf("人工验收")]).toBe(false);
    expect(p.paused).toBe(state === "STOPPED");
    if (state !== "STOPPED") expect(p.next).toContain("指导");
    expect(p.next).not.toContain("自主开发与自测");
  }
});

it("shows the existing before-human review without implying human acceptance or submission", () => {
  const p = workflowProgress(
    { id: "w", state: "REVIEWING", stage: "quality_before_human" },
    [],
    { native: true, humanAccepted: false },
  );
  expect(p.title).toBe("验收前质量审查");
  expect(p.done[p.stages.indexOf("人工验收")]).toBe(false);
  expect(p.next).toContain("进入人工验收");
  expect(p.next).not.toContain("自动提交");
});

it("keeps a paused before-human review in its actual phase", () => {
  const p = workflowProgress(
    { id: "w", state: "BLOCKED", stage: "blocked" },
    [
      {
        workflow_id: "w",
        type: "StateChanged",
        event_seq: 1,
        payload: { to: "REVIEWING", stage: "quality_before_human" },
      },
      {
        workflow_id: "w",
        type: "StateChanged",
        event_seq: 2,
        payload: { from: "REVIEWING", to: "BLOCKED", stage: "blocked" },
      },
    ],
    { native: true },
  );
  expect(p).toMatchObject({ title: "验收前质量审查", paused: true });
  expect(p.done[5]).toBe(false);
});

it("uses confirmation data for the human checkmark, including after-human and legacy reviews", () => {
  for (const native of [true, false]) {
    for (const humanAccepted of [false, true]) {
      const p = workflowProgress(
        { id: "w", state: "REVIEWING", stage: "review" },
        [],
        { native, humanAccepted },
      );
      expect(p.done[p.stages.indexOf("人工验收")]).toBe(humanAccepted);
    }
  }
  expect(
    workflowProgress({ id: "w", state: "HUMAN_PENDING" }, [], { native: true })
      .title,
  ).toBe("人工验收");
});
