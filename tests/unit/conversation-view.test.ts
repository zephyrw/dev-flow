import { describe, expect, it, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationAttemptSchema,
  ConversationNodeSchema,
  type ConversationAttempt,
  type ConversationNode,
} from "../../packages/contracts/src/index.js";
import { ExecutionPanel } from "../../apps/web/src/execution-panel.js";
import {
  CONVERSATION_INVALID_NOTICE,
  ConversationRequestGuard,
  buildConversationPath,
  publicConversationText,
  readConversationDraftMarker,
  readConversationSearchParam,
  readConversationViewport,
  resetConversationViewStores,
  resolveConversationView,
  shouldRenderConversationInteraction,
  writeConversationSearchParam,
  writeConversationViewport,
  type ConversationViewEntry,
} from "../../apps/web/src/use-conversation-view.js";

function node(
  id: string,
  extra: Partial<ConversationNode> & { parent_id?: string } = {},
): ConversationNode {
  return ConversationNodeSchema.parse({
    id,
    project_id: "proj1",
    workflow_id: extra.workflow_id ?? "wf1",
    root_id: extra.root_id ?? "root1",
    parent_id: extra.parent_id,
    kind: extra.parent_id ? "subagent" : "main",
    adapter_id: "codex",
    title: extra.title ?? id,
    purpose: "implement",
    lineage_id: "lineage-1",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    replaces_conversation_id: extra.replaces_conversation_id,
  });
}

function attempt(
  id: string,
  conversationId: string,
  extra: Partial<ConversationAttempt> = {},
): ConversationAttempt {
  return ConversationAttemptSchema.parse({
    id,
    conversation_id: conversationId,
    root_id: extra.root_id ?? "root1",
    workflow_id: extra.workflow_id ?? "wf1",
    run_id: extra.run_id ?? "run1",
    generation: extra.generation ?? 0,
    status: extra.status ?? "running",
    observed_at: extra.observed_at ?? "2026-09-20T00:00:00.000Z",
    actual_model: extra.actual_model,
    requested_model: extra.requested_model,
    actual_effort: extra.actual_effort,
    requested_effort: extra.requested_effort,
  });
}

function log(
  extra: Partial<ConversationViewEntry> & { key: string; sequence: number },
): ConversationViewEntry {
  return {
    created_at: "2026-09-20T00:00:00.000Z",
    title: extra.title ?? extra.key,
    text: extra.text ?? extra.key,
    raw: extra.raw ?? [],
    kind: extra.kind ?? "message",
    ...extra,
  };
}

const tree = [
  node("root1", { title: "需求实现" }),
  node("child1", { parent_id: "root1", title: "开发测试" }),
  node("grand1", { parent_id: "child1", title: "核心接口测试" }),
];

beforeEach(() => {
  resetConversationViewStores();
});

describe("SA-U03 conversation view", () => {
  it("builds a deep breadcrumb path with only the current item marked", () => {
    const view = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      activeRootConversationId: "root1",
      requestedConversationId: "grand1",
    });
    expect(view.breadcrumb.map((item) => item.title)).toEqual([
      "需求实现",
      "开发测试",
      "核心接口测试",
    ]);
    expect(view.breadcrumb.map((item) => item.current)).toEqual([
      false,
      false,
      true,
    ]);
    expect(view.isChildView).toBe(true);
    expect(view.showInteraction).toBe(false);
    expect(view.selectedConversationId).toBe("grand1");
    expect(view.activeRootConversationId).toBe("root1");
  });

  it("returns to an ancestor without changing the running root", () => {
    const view = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      activeRootConversationId: "root1",
      requestedConversationId: "child1",
      previousSelectedId: "grand1",
    });
    expect(view.selectedConversationId).toBe("child1");
    expect(view.activeRootConversationId).toBe("root1");
    expect(view.isChildView).toBe(true);
    expect(view.breadcrumb.map((item) => item.id)).toEqual(["root1", "child1"]);
    expect(view.breadcrumb.at(-1)).toMatchObject({
      id: "child1",
      current: true,
    });
    expect(buildConversationPath(tree, "wf1", "child1").at(-1)?.current).toBe(
      true,
    );
  });

  it("rejects illegal ids instead of filling in the hottest child", () => {
    const hot = [
      ...tree,
      node("hot1", { parent_id: "root1", title: "最近活跃" }),
    ];
    const view = resolveConversationView({
      workflowId: "wf1",
      nodes: hot,
      attempts: [
        attempt("a-root", "root1", { status: "waiting" }),
        attempt("a-hot", "hot1", { status: "running" }),
      ],
      activeRootConversationId: "root1",
      search: "?workflow=wf1&conversation=expired-id",
    });
    expect(view.selectedConversationId).toBe("root1");
    expect(view.selectedConversationId).not.toBe("hot1");
    expect(view.notice).toBe(CONVERSATION_INVALID_NOTICE);
    expect(view.isChildView).toBe(false);
    expect(view.nextSearch).toContain("workflow=wf1");
    expect(view.nextSearch).not.toContain("conversation=");
    const stolen = resolveConversationView({
      workflowId: "wf1",
      nodes: [
        node("root1", { title: "需求实现" }),
        node("other1", { workflow_id: "wf2", title: "其他任务" }),
      ],
      activeRootConversationId: "root1",
      requestedConversationId: "other1",
    });
    expect(stolen.selectedConversationId).toBe("root1");
    expect(stolen.notice).toBe(CONVERSATION_INVALID_NOTICE);
  });

  it("keeps workflow query when selecting a child conversation", () => {
    const view = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      activeRootConversationId: "root1",
      search: "?workflow=wf1&conversation=grand1",
    });
    expect(readConversationSearchParam("?workflow=wf1&conversation=grand1")).toBe(
      "grand1",
    );
    expect(view.selectedConversationId).toBe("grand1");
    expect(view.nextSearch).toContain("workflow=wf1");
    expect(view.nextSearch).toContain("conversation=grand1");
    expect(
      writeConversationSearchParam(
        "https://app.local/?workflow=wf1&view=guide",
        "child1",
        "root1",
      ),
    ).toBe("/?workflow=wf1&view=guide&conversation=child1");
  });

  it("stores scroll, follow, history cursor and read cursor per conversation", () => {
    writeConversationViewport("wf1", "root1", {
      scrollTop: 80,
      followLatest: false,
      beforeSeq: 12,
      readCursor: 40,
    });
    writeConversationViewport("wf1", "child1", {
      scrollTop: 8,
      followLatest: true,
      beforeSeq: 90,
      readCursor: 3,
    });
    expect(readConversationViewport("wf1", "root1")).toMatchObject({
      scrollTop: 80,
      followLatest: false,
      beforeSeq: 12,
      readCursor: 40,
    });
    expect(readConversationViewport("wf1", "child1")).toMatchObject({
      scrollTop: 8,
      followLatest: true,
      beforeSeq: 90,
      readCursor: 3,
    });
    const back = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      activeRootConversationId: "root1",
      requestedConversationId: "root1",
    });
    expect(back.viewport).toMatchObject({
      scrollTop: 80,
      followLatest: false,
      beforeSeq: 12,
      readCursor: 40,
    });
  });

  it("marks the left conversation draft as preserved for restore", () => {
    const leaving = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      activeRootConversationId: "root1",
      requestedConversationId: "child1",
      previousSelectedId: "root1",
    });
    expect(leaving.draft.preserved).toBe(false);
    expect(readConversationDraftMarker("wf1", "root1").preserved).toBe(true);
    const back = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      activeRootConversationId: "root1",
      requestedConversationId: "root1",
      previousSelectedId: "child1",
    });
    expect(back.draft.preserved).toBe(true);
    expect(back.draft.key).toContain("root1");
  });

  it("keeps a finished child selected and only its own entries", () => {
    const entries = [
      log({
        key: "root-msg",
        sequence: 1,
        conversation_id: "root1",
        text: "主会话公开消息",
      }),
      log({
        key: "child-msg",
        sequence: 2,
        conversation_id: "child1",
        text: "子会话公开消息",
      }),
      log({
        key: "sibling-msg",
        sequence: 3,
        conversation_id: "grand1",
        text: "更深一级命令",
      }),
    ];
    const view = resolveConversationView({
      workflowId: "wf1",
      nodes: tree,
      attempts: [attempt("done1", "child1", { status: "completed" })],
      activeRootConversationId: "root1",
      requestedConversationId: "child1",
      entries,
    });
    expect(view.selectedConversationId).toBe("child1");
    expect(view.entries.map((entry) => entry.key)).toEqual(["child-msg"]);
    expect(view.viewedRuntimeText).toContain("开发测试");
    expect(view.viewedRuntimeText).toContain("已完成");
    expect(view.activeRootConversationId).toBe("root1");
  });

  it("adds a continuation line and a new-attempt separator", () => {
    const continued = node("child2", {
      parent_id: "root1",
      title: "开发测试",
      replaces_conversation_id: "child1",
    });
    const view = resolveConversationView({
      workflowId: "wf1",
      nodes: [...tree, continued],
      attempts: [
        attempt("g0", "child2", { generation: 0, status: "interrupted" }),
        attempt("g1", "child2", { generation: 1, status: "running" }),
      ],
      activeRootConversationId: "root1",
      requestedConversationId: "child2",
      entries: [
        log({
          key: "old",
          sequence: 4,
          conversation_id: "child2",
          attempt_id: "g0",
        }),
        log({
          key: "new",
          sequence: 8,
          conversation_id: "child2",
          attempt_id: "g1",
        }),
      ],
    });
    expect(view.entries[0]?.presentation).toBe("continuation");
    expect(view.entries[0]?.text).toBe("接续自开发测试");
    expect(view.entries.some((entry) => entry.presentation === "separator")).toBe(
      true,
    );
    expect(publicConversationText(view.entries)).toContain("接续自开发测试");
    expect(publicConversationText(view.entries)).not.toContain("新的运行尝试");
  });

  it("does not render the child input slot and keeps log chrome", () => {
    expect(shouldRenderConversationInteraction(true)).toBe(false);
    expect(shouldRenderConversationInteraction(false)).toBe(true);
    const html = renderToStaticMarkup(
      React.createElement(ExecutionPanel, {
        entries: [],
        connected: true,
        close: () => undefined,
        width: 380,
        resize: () => undefined,
        read: () => undefined,
        loadHistory: async () => undefined,
        isChildView: true,
        footer: React.createElement("div", null, "work-card"),
        viewedRuntime: "核心接口测试 · 正在工作",
        interaction: React.createElement(
          "div",
          { className: "task-interaction" },
          React.createElement("button", { type: "button" }, "+"),
          React.createElement("textarea", { "aria-label": "输入指导" }),
          React.createElement("button", { type: "button" }, "发送"),
          React.createElement("div", null, "临时提问"),
        ),
      }),
    );
    expect(html).toContain("执行过程");
    expect(html).toContain("已连接");
    expect(html).toContain("复制公开文本");
    expect(html).toContain("加载更早的执行记录");
    expect(html).toContain("核心接口测试 · 正在工作");
    expect(html).toContain("work-card");
    expect(html).not.toContain("task-interaction");
    expect(html).not.toContain("发送");
    expect(html).not.toContain("临时提问");
    expect(html).not.toContain("输入指导");
    const rootHtml = renderToStaticMarkup(
      React.createElement(ExecutionPanel, {
        entries: [],
        connected: false,
        close: () => undefined,
        width: 380,
        resize: () => undefined,
        read: () => undefined,
        interaction: React.createElement(
          "div",
          { className: "task-interaction" },
          React.createElement("button", { type: "button" }, "发送"),
        ),
      }),
    );
    expect(rootHtml).toContain("重连中");
    expect(rootHtml).toContain("task-interaction");
    expect(rootHtml).toContain("发送");
  });

  it("cancels a stale conversation history request", () => {
    const guard = new ConversationRequestGuard();
    const first = guard.start("wf1", "child1");
    const second = guard.start("wf1", "grand1");
    expect(first.accept()).toBe(false);
    expect(second.accept()).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });
});
