import { describe, expect, it } from "vitest";
import {
  unknownSubagentCapabilities,
  type ConversationStatus,
  type SubagentCapabilities,
} from "../../packages/contracts/src/conversation.js";
import {
  COLLAPSE_WORK_CARD_LABEL,
  PAUSE_ALL_LABEL,
  SUMMARY_MAX_CHARS,
  buildSubagentWorkCardModel,
  clipWorkSummary,
  conversationDisplayName,
  readWorkCardPreference,
  shouldAutoExpandWorkCard,
  workCardPreferenceKey,
  writeWorkCardPreference,
  type WorkCardAttempt,
  type WorkCardNode,
} from "../../apps/web/src/components/SubagentWorkCard.js";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function node(
  id: string,
  extra: Partial<WorkCardNode> = {},
): WorkCardNode {
  return {
    id,
    workflow_id: "wf1",
    root_id: extra.root_id ?? "root1",
    parent_id: extra.parent_id,
    kind: extra.kind ?? (extra.parent_id ? "subagent" : "main"),
    title: extra.title ?? id,
    task_summary: extra.task_summary,
    created_at: extra.created_at ?? "2026-09-20T00:00:00.000Z",
  };
}

function attempt(
  conversationId: string,
  status: ConversationStatus,
  extra: Partial<WorkCardAttempt> = {},
): WorkCardAttempt {
  return {
    id: extra.id ?? `${conversationId}-a1`,
    conversation_id: conversationId,
    status,
    freshness: extra.freshness ?? "fresh",
    generation: extra.generation ?? 1,
    activity_summary: extra.activity_summary,
    observed_at: extra.observed_at ?? "2026-09-20T00:00:00.000Z",
    activity_at: extra.activity_at,
    actual_model: extra.actual_model,
    requested_model: extra.requested_model,
    actual_effort: extra.actual_effort,
    requested_effort: extra.requested_effort,
  };
}

function model(input: {
  nodes?: WorkCardNode[];
  attempts?: WorkCardAttempt[];
  capabilities?: SubagentCapabilities;
  rootConversationId?: string;
}) {
  return buildSubagentWorkCardModel({
    rootConversationId: input.rootConversationId ?? "root1",
    nodes: input.nodes ?? [],
    attempts: input.attempts ?? [],
    capabilities: input.capabilities ?? {
      discovery: "native",
      activity: "native",
      stop: "native",
      resume: "native",
      readonly_delegation: "verified",
      file_input: { text: true, image: true, binary: false },
    },
  });
}

describe("SA-U02 conversation display", () => {
  it("counts only starting and running as Working N", () => {
    const built = model({
      nodes: [
        node("root1"),
        node("child-start", { parent_id: "root1", title: "启动中" }),
        node("child-run", { parent_id: "root1", title: "运行中" }),
        node("child-wait", { parent_id: "root1", title: "等待中" }),
        node("child-pause", { parent_id: "root1", title: "已暂停" }),
        node("child-fail", { parent_id: "root1", title: "失败" }),
        node("child-unknown", { parent_id: "root1", title: "未知" }),
      ],
      attempts: [
        attempt("child-start", "starting"),
        attempt("child-run", "running"),
        attempt("child-wait", "waiting"),
        attempt("child-pause", "paused"),
        attempt("child-fail", "failed"),
        attempt("child-unknown", "unknown"),
      ],
    });
    expect(built.counts.working).toBe(2);
    expect(built.headline).toBe("Working 2");
    expect(built.chips.map((chip) => chip.label)).toEqual([
      "Working 2",
      "等待 1",
      "暂停 1",
      "异常 2",
    ]);
    expect(built.rows.map((row) => [row.name, row.statusLabel])).toEqual([
      ["启动中", "正在启动"],
      ["运行中", "正在工作"],
      ["等待中", "等待中"],
      ["已暂停", "已暂停"],
      ["失败", "失败"],
      ["未知", "状态未知"],
    ]);
  });

  it("dedupes by conversation id and keeps the latest attempt", () => {
    const built = model({
      nodes: [
        node("root1"),
        node("child-a", { parent_id: "root1", title: "同一会话" }),
        node("child-a", { parent_id: "root1", title: "重复节点" }),
      ],
      attempts: [
        attempt("child-a", "starting", {
          id: "old",
          generation: 1,
          observed_at: "2026-09-20T00:00:00.000Z",
        }),
        attempt("child-a", "running", {
          id: "new",
          generation: 2,
          observed_at: "2026-09-20T00:01:00.000Z",
          activity_summary: "正在运行指定测试文件",
        }),
      ],
    });
    expect(built.counts.working).toBe(1);
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]?.name).toBe("同一会话");
    expect(built.rows[0]?.summary).toBe("正在运行指定测试文件");
  });

  it("does not count a waiting ancestor as working", () => {
    const built = model({
      nodes: [
        node("root1"),
        node("parent", { parent_id: "root1", title: "父会话" }),
        node("nested", {
          parent_id: "parent",
          title: "子会话",
          created_at: "2026-09-20T00:00:01.000Z",
        }),
      ],
      attempts: [
        attempt("parent", "waiting"),
        attempt("nested", "running", {
          activity_summary: "检查会话归属",
        }),
      ],
    });
    expect(built.counts.working).toBe(1);
    expect(built.counts.waiting).toBe(1);
    expect(built.headline).toBe("Working 1");
    const nested = built.rows.find((row) => row.conversationId === "nested");
    expect(nested?.parentPath).toBe("父会话");
    expect(nested?.statusLabel).toBe("正在工作");
  });

  it("shows 状态待确认 for stale work and never claims everything finished", () => {
    const built = model({
      nodes: [
        node("root1"),
        node("child-stale", { parent_id: "root1", title: "待确认" }),
      ],
      attempts: [
        attempt("child-stale", "running", {
          freshness: "stale",
          activity_at: "2026-09-20T01:00:00.000Z",
          actual_model: "gpt-5",
        }),
      ],
    });
    expect(built.visibility).toBe("active");
    expect(built.headline).not.toContain("已完成");
    expect(built.headline).toBe("Working 1");
    expect(built.rows[0]?.statusLabel).toBe("状态待确认");
    expect(built.rows[0]?.secondaryTitle).toContain("gpt-5");
    expect(built.chips.some((chip) => chip.label.startsWith("状态待确认"))).toBe(
      true,
    );

    const unconfirmedIdle = model({
      nodes: [
        node("root1"),
        node("child-stale", { parent_id: "root1", title: "待确认" }),
      ],
      attempts: [
        attempt("child-stale", "unknown", { freshness: "unavailable" }),
      ],
    });
    expect(unconfirmedIdle.visibility).toBe("active");
    expect(unconfirmedIdle.headline).toBe("状态待确认");
    expect(unconfirmedIdle.headline).not.toBe("Working 0");
    expect(unconfirmedIdle.rows[0]?.statusLabel).toBe("状态待确认");
  });

  it("hides an empty card when discovery is readable", () => {
    const readable = model({
      nodes: [node("root1")],
      attempts: [attempt("root1", "running")],
      capabilities: {
        discovery: "scoped-record",
        activity: "summary-only",
        stop: "unavailable",
        resume: "parent-instruction",
        readonly_delegation: "unknown",
        file_input: { text: false, image: false, binary: false },
      },
    });
    expect(readable.visibility).toBe("hidden");
    expect(readable.counts.working).toBe(0);
  });

  it("shows a capability notice when discovery is unknown or unavailable", () => {
    const unknown = model({
      capabilities: unknownSubagentCapabilities(),
    });
    expect(unknown.visibility).toBe("capability");
    expect(unknown.capabilityNotice).toBe(
      "当前工具尚未报告子 Agent 能力，不能据此认为没有子 Agent。",
    );
    const unavailable = model({
      capabilities: {
        ...unknownSubagentCapabilities(),
        discovery: "unavailable",
        reason: "当前 CLI 无法列出子 Agent",
      },
    });
    expect(unavailable.visibility).toBe("capability");
    expect(unavailable.capabilityNotice).toBe("当前 CLI 无法列出子 Agent");
  });

  it("shows 子 Agent · 已完成 N and keeps history rows", () => {
    const built = model({
      nodes: [
        node("root1"),
        node("done-a", { parent_id: "root1", title: "已完成甲" }),
        node("done-b", {
          parent_id: "root1",
          title: "已完成乙",
          created_at: "2026-09-20T00:00:01.000Z",
        }),
      ],
      attempts: [
        attempt("done-a", "completed"),
        attempt("done-b", "completed"),
      ],
    });
    expect(built.visibility).toBe("complete");
    expect(built.headline).toBe("子 Agent · 已完成 2");
    expect(built.rows).toEqual([]);
    expect(built.historyRows.map((row) => row.name)).toEqual([
      "已完成甲",
      "已完成乙",
    ]);
    expect(built.hasActiveWork).toBe(false);
  });

  it("ignores aside trees and the main session when counting work", () => {
    const built = model({
      nodes: [
        node("root1", { title: "主会话" }),
        node("aside-1", {
          kind: "aside",
          root_id: "aside-1",
          title: "临时提问",
        }),
        node("child-run", { parent_id: "root1", title: "真正的子 Agent" }),
      ],
      attempts: [
        attempt("root1", "running"),
        attempt("aside-1", "running"),
        attempt("child-run", "running"),
      ],
    });
    expect(built.counts.working).toBe(1);
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]?.name).toBe("真正的子 Agent");
  });

  it("falls back through native title, task summary, then short id", () => {
    expect(
      conversationDisplayName(
        node("agent-core-loop", { title: "核心接口闭环" }),
      ),
    ).toBe("核心接口闭环");
    expect(
      conversationDisplayName(
        node("agent-core-loop", {
          title: "agent-core-loop",
          task_summary: "修复附件读取状态",
        }),
      ),
    ).toBe("修复附件读取状态");
    expect(
      conversationDisplayName(
        node("agent-core-loop", { title: "agent-core-loop" }),
      ),
    ).toBe("子 Agent · agent-co");
  });

  it("clips summaries to 500 characters", () => {
    const long = "测".repeat(520);
    expect(clipWorkSummary(long).length).toBe(SUMMARY_MAX_CHARS);
  });

  it("auto-expands once and keeps a collapsed preference", () => {
    expect(shouldAutoExpandWorkCard(undefined, true, false)).toBe(true);
    expect(shouldAutoExpandWorkCard("expanded", true, false)).toBe(true);
    expect(shouldAutoExpandWorkCard("collapsed", true, false)).toBe(false);
    expect(shouldAutoExpandWorkCard(undefined, false, false)).toBe(false);
    expect(shouldAutoExpandWorkCard(undefined, true, true)).toBe(false);

    const storage = memoryStorage();
    const key = workCardPreferenceKey("wf1", "root1");
    expect(key).toBe("devflow.subagent-work-card.wf1:root1");
    writeWorkCardPreference("wf1", "root1", "collapsed", storage);
    expect(readWorkCardPreference("wf1", "root1", storage)).toBe("collapsed");
    expect(shouldAutoExpandWorkCard(
      readWorkCardPreference("wf1", "root1", storage),
      true,
      false,
    )).toBe(false);
  });

  it("keeps collapse and pause labels distinct", () => {
    expect(COLLAPSE_WORK_CARD_LABEL).toBe("收起子 Agent 工作卡");
    expect(PAUSE_ALL_LABEL).toBe("暂停当前主工作会话及全部子 Agent");
    expect(COLLAPSE_WORK_CARD_LABEL).not.toBe(PAUSE_ALL_LABEL);
  });
});
