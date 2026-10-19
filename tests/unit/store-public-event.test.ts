import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationActivityPayload, DomainEvent } from "../../packages/contracts/src/index.js";
import { Store } from "../../packages/store/src/store.js";

describe("public event cache", () => {
  let store: Store;

  beforeEach(() => { store = new Store(":memory:"); });
  afterEach(() => { store.close(); });

  const diagnostic = (payload: unknown): DomainEvent => ({
    workflow_id: "wf-cache",
    project_id: "project-cache",
    event_seq: 1,
    type: "AgentDiagnostic",
    payload,
    created_at: "2026-10-19T08:42:11.442Z",
  });

  it("never serializes raw diagnostic credentials or cache metadata on misses or hits", () => {
    const event = diagnostic({
      text: "Build failed: missing module",
      password: "synthetic-password",
      nested: { token: "synthetic-token" },
    });
    const before = JSON.stringify(event);
    const first = store.publicEvent(event);
    const cached = store.publicEvent(event);

    expect(cached).toBe(first);
    for (const result of [first, cached]) {
      expect(result).toEqual({
        ...event,
        payload: {
          text: "Build failed: missing module",
          password: "[REDACTED]",
          nested: { token: "[REDACTED]" },
        },
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("synthetic-password");
      expect(serialized).not.toContain("synthetic-token");
      expect(serialized).not.toContain("__contentSignature");
    }
    expect(JSON.stringify(event)).toBe(before);
  });

  it("refreshes a cached message when the same persisted event is corrected", () => {
    const payload: ConversationActivityPayload = {
      conversation_id: "cnv-cache",
      attempt_id: "attempt-cache",
      root_id: "cnv-cache",
      activity_id: "reply-cache",
      source_event_id: "source-cache",
      kind: "message",
      title: "模型回复",
      public_text: "[敏感认证操作：仅保留状态]",
    };
    const event: DomainEvent = {
      ...diagnostic(payload),
      type: "ConversationActivity",
    };
    const first = store.publicEvent(event);
    const restoredText = "已完成页面修复。\n详情见 https://example.test/login。";
    const corrected: DomainEvent = {
      ...event,
      payload: {
        ...payload,
        public_text: restoredText,
      },
    };

    const restored = store.publicEvent(corrected);
    expect(restored).not.toBe(first);
    expect(restored.payload).toMatchObject({ public_text: restoredText });
    expect(restored.event_seq).toBe(event.event_seq);
    expect(restored.created_at).toBe(event.created_at);
    expect(store.publicEvent(corrected)).toBe(restored);
    expect(JSON.stringify(restored)).not.toContain("__contentSignature");
  });

  it("invalidates only the requested event or workflow", () => {
    const first = diagnostic({ text: "First diagnostic" });
    const second = { ...first, event_seq: 2 };
    const unrelated = { ...first, workflow_id: "wf-unrelated" };
    const firstCached = store.publicEvent(first);
    const secondCached = store.publicEvent(second);
    const unrelatedCached = store.publicEvent(unrelated);

    store.invalidatePublicEvent(first.workflow_id, first.event_seq);
    const firstReloaded = store.publicEvent(first);
    expect(firstReloaded).not.toBe(firstCached);
    expect(firstReloaded).toEqual(firstCached);
    expect(store.publicEvent(second)).toBe(secondCached);

    store.invalidatePublicEvent(first.workflow_id);
    expect(store.publicEvent(first)).not.toBe(firstReloaded);
    expect(store.publicEvent(second)).not.toBe(secondCached);
    expect(store.publicEvent(unrelated)).toBe(unrelatedCached);
  });
});
