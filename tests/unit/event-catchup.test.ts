import { describe, it, expect } from "vitest";
import {
  applyCatchupPage,
  catchupRound,
  type CatchupCursor,
  type CatchupPage,
} from "../../apps/web/src/event-catchup.js";

function historyReader(total: number, pageSize = 200) {
  return (path: string): CatchupPage => {
    const before = Number(
      new URL(path, "http://local.test").searchParams.get("before") ??
        Number.MAX_SAFE_INTEGER,
    );
    const events: { workflow_id: string; event_seq: number }[] = [];
    for (
      let seq = Math.min(total, before - 1);
      seq >= 1 && events.length < pageSize;
      seq -= 1
    ) {
      events.unshift({ workflow_id: "wf", event_seq: seq });
    }
    return {
      events,
      next_before: events.length === pageSize ? events[0]!.event_seq : null,
    };
  };
}

function seqs(events: { event_seq: number }[]) {
  return events.map((event) => event.event_seq);
}

describe("事件补拉分页续传", () => {
  it("一次逆序追赶时每页只读一次，第一页即投递较新事件", async () => {
    const readLog: string[] = [];
    const pages = historyReader(1000, 200);
    const received: number[][] = [];
    const cursor = await catchupRound({
      cursor: { watermark: 0 },
      workflow: "wf",
      read: async (path) => {
        readLog.push(path);
        return pages(path);
      },
      receive: (events) => received.push(seqs(events)),
      isStopped: () => false,
      pageLimit: 20,
      eventLimit: 4000,
    });
    expect(received[0]).toEqual(
      Array.from({ length: 200 }, (_, i) => 801 + i),
    );
    expect(readLog).toEqual([...new Set(readLog)]);
    expect(readLog).toHaveLength(5);
    expect(readLog[0]).not.toContain("before=");
    expect(readLog[1]).toContain("before=801");
    expect(cursor.watermark).toBe(1000);
    expect(cursor.targetUpper).toBeUndefined();
    expect(cursor.before).toBeUndefined();
  });

  it("预算中断后从 before 继续，不重新从最新页启动同一轮", async () => {
    const pages = historyReader(1000, 200);
    const firstReads: string[] = [];
    const first = await catchupRound({
      cursor: { watermark: 0 },
      workflow: "wf",
      read: async (path) => {
        firstReads.push(path);
        return pages(path);
      },
      receive: () => {},
      isStopped: () => false,
      pageLimit: 2,
      eventLimit: 4000,
    });
    expect(first.watermark).toBe(0);
    expect(first.targetUpper).toBe(1000);
    expect(first.startWatermark).toBe(0);
    expect(first.before).toBe(601);
    expect(firstReads).toHaveLength(2);
    expect(firstReads[0]).not.toContain("before=");

    const secondReads: string[] = [];
    const second = await catchupRound({
      cursor: first,
      workflow: "wf",
      read: async (path) => {
        secondReads.push(path);
        return pages(path);
      },
      receive: () => {},
      isStopped: () => false,
      pageLimit: 20,
      eventLimit: 4000,
    });
    expect(secondReads[0]).toContain("before=601");
    expect(secondReads.some((path) => !path.includes("before="))).toBe(false);
    expect(second.watermark).toBe(1000);
    expect(second.before).toBeUndefined();
  });

  it("断连保留目标与已推进位置，不从最新页重开同一轮", async () => {
    const pages = historyReader(1000, 200);
    let calls = 0;
    const failedReads: string[] = [];
    const failed = await catchupRound({
      cursor: { watermark: 0 },
      workflow: "wf",
      read: async (path) => {
        failedReads.push(path);
        calls += 1;
        if (calls === 3) throw new Error("network");
        return pages(path);
      },
      receive: () => {},
      isStopped: () => false,
      pageLimit: 20,
      eventLimit: 4000,
    });
    expect(failed.targetUpper).toBe(1000);
    expect(failed.watermark).toBe(0);
    expect(failed.before).toBe(601);
    expect(failedReads.filter((path) => !path.includes("before="))).toHaveLength(
      1,
    );

    const resumeReads: string[] = [];
    await catchupRound({
      cursor: failed,
      workflow: "wf",
      read: async (path) => {
        resumeReads.push(path);
        return pages(path);
      },
      receive: () => {},
      isStopped: () => false,
      pageLimit: 1,
      eventLimit: 4000,
    });
    expect(resumeReads).toEqual([
      "/workflows/wf/history?limit=200&before=601",
    ]);
  });

  it("切换任务时丢弃旧请求响应，不把旧页投递给新任务", async () => {
    let resolvePage: (page: CatchupPage) => void = () => {};
    const received: number[] = [];
    let stopped = false;
    const pending = catchupRound({
      cursor: { watermark: 0 },
      workflow: "wf-a",
      read: () =>
        new Promise<CatchupPage>((resolve) => {
          resolvePage = resolve;
        }),
      receive: (events) => received.push(...seqs(events)),
      isStopped: () => stopped,
    });
    stopped = true;
    resolvePage({
      events: [{ workflow_id: "wf-a", event_seq: 99 }],
      next_before: null,
    });
    const cursor = await pending;
    expect(received).toEqual([]);
    expect(cursor).toEqual({ watermark: 0 });
  });

  it("第一页即 deliver，展示较新页不提前推进完成水位", () => {
    const first = applyCatchupPage(
      { watermark: 10 },
      {
        events: [4010, 4011, 4012].map((event_seq) => ({
          workflow_id: "wf",
          event_seq,
        })),
        next_before: 4010,
      },
      "wf",
    );
    expect(seqs(first.deliver)).toEqual([4010, 4011, 4012]);
    expect(first.more).toBe(true);
    expect(first.cursor.watermark).toBe(10);
    expect(first.cursor.targetUpper).toBe(4012);
    expect(first.cursor.startWatermark).toBe(10);
    expect(first.cursor.before).toBe(4010);
    expect(first.cursor).not.toHaveProperty("pending");

    const last = applyCatchupPage(
      first.cursor,
      {
        events: [11, 12].map((event_seq) => ({
          workflow_id: "wf",
          event_seq,
        })),
        next_before: null,
      },
      "wf",
    );
    expect(seqs(last.deliver)).toEqual([11, 12]);
    expect(last.more).toBe(false);
    expect(last.cursor.watermark).toBe(4012);
    expect(last.cursor.before).toBeUndefined();
  });
});
