import { beforeEach, describe, expect, it } from "vitest";
import {
  asidePositionLabel,
  defaultSelectedAsideId,
  isAsideNavDisabled,
  isViewingHistoricalAside,
  nextPendingIds,
  nextProjectAsideSelection,
  peekAsidePromoteDraft,
  promoteDraftText,
  resetProjectAsideUi,
  resolveBackgroundAsideArrival,
  shouldHideAsidePopover,
  shouldPollProjectAsideUpdates,
  shouldRefreshAsideDetail,
  snapshotAfterProjectSwitch,
  summaryFromCreatedAside,
  upsertAside,
  writeAsidePromoteDraft,
  writeProjectAsideUi,
  readProjectAsideUi,
  clearProjectAsideUi,
} from "../../apps/web/src/use-project-asides.js";

const position = {
  index: 1,
  total: 7,
  next_id: "aside_old",
};

describe("SA-D20 project aside 选择与 1/N", () => {
  beforeEach(() => {
    resetProjectAsideUi();
  });

  it("项目切换清空选中 ID 和快照，同项目任务切换保留", () => {
    expect(
      nextProjectAsideSelection({
        previousProjectId: "proj_a",
        nextProjectId: "proj_b",
        previousSelectedId: "aside_1",
      }),
    ).toBeUndefined();
    expect(
      nextProjectAsideSelection({
        previousProjectId: "proj_a",
        nextProjectId: "proj_a",
        previousSelectedId: "aside_1",
      }),
    ).toBe("aside_1");
    expect(
      snapshotAfterProjectSwitch({
        previousProjectId: "proj_a",
        nextProjectId: "proj_b",
        previousSnapshot: 9,
      }),
    ).toBeUndefined();
    expect(
      snapshotAfterProjectSwitch({
        previousProjectId: "proj_a",
        nextProjectId: "proj_a",
        previousSnapshot: 9,
      }),
    ).toBe(9);

    writeProjectAsideUi("proj_a", { selectedId: "aside_1", snapshotCursor: 3 });
    clearProjectAsideUi("proj_a");
    expect(readProjectAsideUi("proj_a").selectedId).toBeUndefined();
  });

  it("1/N 左右边界禁用且不循环，总数来自服务端位置", () => {
    expect(asidePositionLabel(position)).toBe("1/7");
    expect(isAsideNavDisabled("prev", position)).toBe(true);
    expect(isAsideNavDisabled("next", position)).toBe(false);
    expect(
      isAsideNavDisabled("next", { index: 7, total: 7, prev_id: "aside_new" }),
    ).toBe(true);
    expect(isAsideNavDisabled("prev", { index: 7, total: 7, prev_id: "aside_new" })).toBe(
      false,
    );
    expect(isAsideNavDisabled("prev", { index: 1, total: 1 })).toBe(true);
    expect(isAsideNavDisabled("next", { index: 1, total: 1 })).toBe(true);
    expect(defaultSelectedAsideId([{ id: "latest" }, { id: "older" }])).toBe(
      "latest",
    );
    expect(isViewingHistoricalAside({ index: 1 })).toBe(false);
    expect(isViewingHistoricalAside({ index: 2 })).toBe(true);
  });

  it("新提交选中该条；正在看旧问题时后台新增只提示", () => {
    expect(
      resolveBackgroundAsideArrival({
        selectedId: "aside_old",
        newIds: ["aside_new"],
      }),
    ).toEqual({ selectedId: "aside_old", notifyNew: true });
    expect(
      resolveBackgroundAsideArrival({
        selectedId: "aside_new",
        newIds: ["aside_new"],
      }),
    ).toEqual({ selectedId: "aside_new", notifyNew: false });
    expect(
      shouldRefreshAsideDetail({
        selectedId: "aside_old",
        updates: [{ id: "aside_new" }],
      }),
    ).toBe(false);
    expect(
      shouldRefreshAsideDetail({
        selectedId: "aside_old",
        updates: [{ id: "aside_old" }],
      }),
    ).toBe(true);
  });

  it("仅浮窗打开或存在 pending 时轮询，子会话隐藏浮窗", () => {
    expect(
      shouldPollProjectAsideUpdates({ popoverOpen: true, hasPending: false }),
    ).toBe(true);
    expect(
      shouldPollProjectAsideUpdates({ popoverOpen: false, hasPending: true }),
    ).toBe(true);
    expect(
      shouldPollProjectAsideUpdates({ popoverOpen: false, hasPending: false }),
    ).toBe(false);
    expect(
      shouldHideAsidePopover({
        selectedConversationId: "child",
        rootConversationId: "root",
      }),
    ).toBe(true);
    expect(
      shouldHideAsidePopover({
        selectedConversationId: "root",
        rootConversationId: "root",
      }),
    ).toBe(false);
    expect(nextPendingIds(["a"], [{ id: "a", status: "completed" }])).toEqual([]);
    expect(nextPendingIds([], [{ id: "b", status: "queued" }])).toEqual(["b"]);
  });

  it("转正式反馈草稿保留问答，upsert 按 ID 更新", () => {
    expect(
      promoteDraftText({ question: "为什么等待？", answer: "需要稳定输出" }),
    ).toBe("为什么等待？\n需要稳定输出");
    writeAsidePromoteDraft("wf_current", {
      workflowId: "wf_source",
      asideId: "aside_1",
    });
    expect(peekAsidePromoteDraft("wf_current")).toEqual({
      workflowId: "wf_source",
      asideId: "aside_1",
    });
    const created = summaryFromCreatedAside({
      session: {
        id: "aside_2",
        workflow_id: "wf_a",
        question: "新问题",
        status: "active",
        created_at: "2026-09-20T12:00:00.000Z",
      },
      projectId: "proj_a",
      workflowTitle: "任务 A",
    });
    expect(upsertAside([created], { ...created, status: "completed" })).toEqual([
      { ...created, status: "completed" },
    ]);
  });
});
