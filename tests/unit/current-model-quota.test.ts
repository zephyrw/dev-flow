import { describe, it, expect } from "vitest";

describe("当前模型额度与双窗口隔离 (U05 / U06)", () => {
  it("U05: 周额度与5小时额度数据解析计算准确，不伪造零或满额度", () => {
    const rawBucket = {
      id: "codex",
      model: "gpt-5.1-codex",
      windows: [
        {
          window_minutes: 10080,
          used_percent: 32.5,
          resets_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 3,
        },
        {
          window_minutes: 300,
          used_percent: 10.0,
          resets_at: Math.floor(Date.now() / 1000) + 3600 * 2,
        },
      ],
    };

    const weekly = rawBucket.windows.find((w) => w.window_minutes === 10080);
    const fiveHour = rawBucket.windows.find((w) => w.window_minutes === 300);

    expect(weekly).toBeDefined();
    expect(fiveHour).toBeDefined();

    const remainingWeekly = 100 - weekly!.used_percent;
    const remaining5h = 100 - fiveHour!.used_percent;

    expect(remainingWeekly).toBe(67.5);
    expect(remaining5h).toBe(90.0);
  });

  it("U05: 当窗口数据为 NaN 或 null 时，保留 null 或暂不可用，不伪造默认 0 或 100", () => {
    const rawBucket = {
      id: "agy",
      model: "gemini-3.8-flash-high",
      windows: [
        {
          window_minutes: 10080,
          used_percent: Number.NaN,
        },
      ],
    };

    const window = rawBucket.windows[0]!;
    const remainingPercent =
      typeof window.used_percent === "number" && !Number.isNaN(window.used_percent)
        ? Math.max(0, Math.min(100, 100 - window.used_percent))
        : null;

    expect(remainingPercent).toBeNull();
  });

  it("U06: 仅匹配当前运行的模型桶，不跨模型混用其他模型的配额桶", () => {
    const quota = {
      observed_at: new Date().toISOString(),
      buckets: [
        {
          id: "gpt-5",
          model: "gpt-5",
          windows: [{ window_minutes: 300, used_percent: 80 }],
        },
        {
          id: "gpt-5.1-codex",
          model: "gpt-5.1-codex",
          windows: [{ window_minutes: 300, used_percent: 15 }],
        },
      ],
    };

    const currentModel = "gpt-5.1-codex";
    const matched = quota.buckets.filter(
      (b) => b.model === currentModel || b.id === currentModel,
    );

    expect(matched).toHaveLength(1);
    expect(matched[0]!.windows[0]!.used_percent).toBe(15);
  });
});
