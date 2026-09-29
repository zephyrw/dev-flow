import { describe, expect, it } from "vitest";
import { ConversationHistoryCache } from "../../apps/web/src/conversation-history.js";

describe("conversation history raw pages (U4 / I3)", () => {
  it("retains a start loaded from history when refreshing a completion-only latest page", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, {
      items: [{ sequence: 20, key: "command", status: "done" }],
      has_more: true, next_before_seq: 20,
    });
    cache.applyPage(cache.begin("older")!, {
      items: [{ sequence: 10, key: "command", command: "git status", status: "active" }],
      has_more: true, next_before_seq: 10,
    });
    const snapshot = cache.applyPage(cache.begin("latest")!, {
      items: [{ sequence: 20, key: "command", status: "done" }, { sequence: 21, text: "next" }],
      has_more: true, next_before_seq: 20,
    });
    expect(snapshot?.items).toEqual([
      { sequence: 10, key: "command", command: "git status", status: "active" },
      { sequence: 20, key: "command", status: "done" },
      { sequence: 21, text: "next" },
    ]);
    expect(snapshot?.nextBeforeSeq).toBe(10);
  });

  it("advances an empty page using the server cursor and keeps exhaustion after refresh", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, { items: [], has_more: true, next_before_seq: 50 });
    const older = cache.begin("older")!;
    expect(older.beforeSeq).toBe(50);
    cache.applyPage(older, { items: [], has_more: true, next_before_seq: 25 });
    const last = cache.begin("older")!;
    expect(last.beforeSeq).toBe(25);
    cache.applyPage(last, { items: [], has_more: false, next_before_seq: null });
    cache.applyPage(cache.begin("latest")!, { items: [], has_more: true, next_before_seq: 50 });
    expect(cache.snapshot().hasMore).toBe(false);
    expect(cache.begin("older")).toBeNull();
  });

  it("rejects late A responses after A to B and A to B to A selection changes", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, { items: [], has_more: true, next_before_seq: 50 });
    const oldLatest = cache.begin("latest")!;
    const oldHistory = cache.begin("older")!;
    cache.select("wf", "b");
    cache.applyPage(cache.begin("latest")!, { items: [{ sequence: 30, conversation_id: "b" }] });
    expect(cache.applyPage(oldHistory, { items: [{ sequence: 10, conversation_id: "a" }] })).toBeNull();
    expect(cache.snapshot().items).toEqual([{ sequence: 30, conversation_id: "b" }]);
    cache.select("wf", "a");
    expect(cache.isCurrent(oldLatest)).toBe(false);
    expect(cache.applyPage(oldLatest, { items: [{ sequence: 20, conversation_id: "a" }] })).toBeNull();
    expect(cache.snapshot().items).toEqual([]);
  });

  it("rejects superseded refreshes and preserves cache and cursor on request failure", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, {
      items: [{ sequence: 30 }], has_more: true, next_before_seq: 30,
    });
    const old = cache.begin("latest")!;
    const current = cache.begin("latest")!;
    expect(cache.finish(old)).toBe(false);
    expect(cache.applyPage(old, { items: [{ sequence: 31 }] })).toBeNull();
    expect(cache.finish(current)).toBe(true);
    expect(cache.snapshot()).toEqual({ items: [{ sequence: 30 }], hasMore: true, nextBeforeSeq: 30 });
    const older = cache.begin("older")!;
    expect(cache.begin("older")).toBeNull();
    expect(cache.finish(older)).toBe(true);
    expect(cache.begin("older")?.beforeSeq).toBe(30);
  });

  it("allows refresh and history to finish in either order without rolling back history", () => {
    for (const refreshFirst of [true, false]) {
      const cache = new ConversationHistoryCache();
      cache.select("wf", "a");
      cache.applyPage(cache.begin("latest")!, { items: [{ sequence: 30 }], has_more: true, next_before_seq: 30 });
      const latest = cache.begin("latest")!;
      const older = cache.begin("older")!;
      const refresh = () => cache.applyPage(latest, { items: [{ sequence: 40 }], has_more: true, next_before_seq: 40 });
      const history = () => cache.applyPage(older, { items: [{ sequence: 20 }], has_more: true, next_before_seq: 20 });
      if (refreshFirst) { refresh(); history(); } else { history(); refresh(); }
      // The latest page does not overlap the loaded head: recover that interval
      // first, then continue from the unchanged oldest history boundary.
      expect(cache.snapshot().nextBeforeSeq).toBe(40);
      const gap = cache.begin("older")!;
      expect(gap.beforeSeq).toBe(40);
      cache.applyPage(gap, { items: [{ sequence: 30 }], has_more: true, next_before_seq: 30 });
      expect(cache.snapshot()).toEqual({ items: [{ sequence: 20 }, { sequence: 30 }, { sequence: 40 }], hasMore: true, nextBeforeSeq: 20 });
    }
  });

  it("recovers a refresh gap even when the previously loaded history was exhausted", () => {
    const cache = new ConversationHistoryCache();
    const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ sequence: from + i }));
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, { items: rows(1, 20), has_more: false, next_before_seq: 1 });
    cache.applyPage(cache.begin("latest")!, { items: rows(101, 200), has_more: true, next_before_seq: 101 });
    expect(cache.snapshot().hasMore).toBe(true);
    const gap = cache.begin("older")!;
    expect(gap.beforeSeq).toBe(101);
    cache.applyPage(gap, { items: rows(1, 100), has_more: false, next_before_seq: 1 });
    expect(cache.snapshot()).toEqual({ items: rows(1, 200), hasMore: false, nextBeforeSeq: 1 });
    expect(cache.begin("older")).toBeNull();
  });

  it("keeps an in-flight gap separate from a newer refresh and retries failures", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, { items: [{ sequence: 20 }], has_more: false, next_before_seq: 20 });
    cache.applyPage(cache.begin("latest")!, { items: [{ sequence: 60 }], has_more: true, next_before_seq: 60 });
    const firstGap = cache.begin("older")!;
    cache.applyPage(cache.begin("latest")!, { items: [{ sequence: 100 }], has_more: true, next_before_seq: 100 });
    cache.applyPage(firstGap, { items: [{ sequence: 40 }, { sequence: 20 }], has_more: false, next_before_seq: 20 });
    expect(cache.snapshot().nextBeforeSeq).toBe(100);
    const failed = cache.begin("older")!;
    expect(cache.finish(failed)).toBe(true);
    const retry = cache.begin("older")!;
    expect(retry.beforeSeq).toBe(100);
    cache.applyPage(retry, { items: [{ sequence: 80 }, { sequence: 60 }], has_more: true, next_before_seq: 60 });
    expect(cache.snapshot()).toEqual({
      items: [20, 40, 60, 80, 100].map((sequence) => ({ sequence })), hasMore: false, nextBeforeSeq: 20,
    });
  });

  it("advances filtered gap pages by raw cursors and rejects them after reselection", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf", "a");
    cache.applyPage(cache.begin("latest")!, { items: [], has_more: false, next_before_seq: 10 });
    cache.applyPage(cache.begin("latest")!, { items: [], has_more: true, next_before_seq: 50 });
    cache.applyPage(cache.begin("older")!, { items: [], has_more: true, next_before_seq: 30 });
    expect(cache.snapshot().nextBeforeSeq).toBe(30);
    cache.applyPage(cache.begin("older")!, { items: [], has_more: true, next_before_seq: 10 });
    expect(cache.snapshot().hasMore).toBe(false);
    cache.applyPage(cache.begin("latest")!, { items: [], has_more: true, next_before_seq: 90 });
    const stale = cache.begin("older")!;
    cache.select("wf", "b");
    cache.select("wf", "a");
    expect(cache.applyPage(stale, { items: [{ sequence: 80 }], has_more: true, next_before_seq: 50 })).toBeNull();
    expect(cache.snapshot()).toEqual({ items: [], hasMore: false, nextBeforeSeq: null });
  });

  it("isolates the same conversation id in another workflow and ignores foreign DTOs", () => {
    const cache = new ConversationHistoryCache();
    cache.select("wf-one", "a");
    const old = cache.begin("latest")!;
    cache.select("wf-two", "a");
    expect(cache.applyPage(old, { items: [{ sequence: 1 }] })).toBeNull();
    cache.applyPage(cache.begin("latest")!, { items: [{ sequence: 2, conversation_id: "b" }, { sequence: 3, conversation_id: "a" }] });
    expect(cache.snapshot().items).toEqual([{ sequence: 3, conversation_id: "a" }]);
  });
});
