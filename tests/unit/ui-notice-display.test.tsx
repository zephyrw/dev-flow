import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { unknownSubagentCapabilities } from "../../packages/contracts/src/conversation.js";
import { resolveConversationRuntimeDisplay } from "../../packages/core/src/conversation-input.js";
import { conversationRuntimeLabels } from "../../packages/presentation/src/model-display.js";
import { SubagentWorkCard } from "../../apps/web/src/components/SubagentWorkCard.js";
import { WorkflowOverview } from "../../apps/web/src/components/WorkflowOverview.js";
import { RuntimeFailureNotice } from "../../apps/web/src/components/RuntimeFailureNotice.js";
import { viewedConversationRuntimeText } from "../../apps/web/src/use-conversation-view.js";
import { formatApiError } from "../../apps/web/src/components/model-api.js";

const noop = () => {};

describe("user-facing notices", () => {
  it.each(["unknown", "unavailable"] as const)(
    "does not render an empty child-agent capability card: %s",
    (discovery) => {
      const html = renderToStaticMarkup(
        <SubagentWorkCard
          workflowId="wf"
          rootConversationId="root"
          expanded={false}
          nodes={[]}
          attempts={[]}
          capabilities={{
            ...unknownSubagentCapabilities(),
            discovery,
            reason: "internal discovery diagnostic",
          }}
          onToggle={noop}
          onSelect={noop}
          onPauseAll={noop}
          onCollapse={noop}
        />,
      );
      expect(html).toBe("");
    },
  );

  it("retains real child-agent work even when capability discovery is unavailable", () => {
    const html = renderToStaticMarkup(
      <SubagentWorkCard
        workflowId="wf"
        rootConversationId="root"
        expanded
        nodes={[
          {
            id: "child",
            root_id: "root",
            parent_id: "root",
            kind: "subagent",
            title: "检查接口",
            workflow_id: "wf",
            created_at: "2026-09-30T00:00:00Z",
          },
        ]}
        attempts={[
          {
            id: "attempt",
            conversation_id: "child",
            status: "running",
            freshness: "fresh",
            generation: 1,
            activity_summary: "运行接口测试",
            observed_at: "2026-09-30T00:00:00Z",
          },
        ]}
        capabilities={{
          ...unknownSubagentCapabilities(),
          discovery: "unavailable",
          reason: "internal discovery diagnostic",
        }}
        onToggle={noop}
        onSelect={noop}
        onPauseAll={noop}
        onCollapse={noop}
      />,
    );
    expect(html).toContain("运行接口测试");
    expect(html).toContain("正在工作");
    expect(html).toContain("暂停全部");
    expect(html).not.toContain("internal discovery diagnostic");
  });

  it("omits absent overview sections, including placeholders supplied by the API", () => {
    const html = renderToStaticMarkup(
      <WorkflowOverview
        workflow={{
          title: "修复导出",
          state: "PLAN_PENDING",
          plan_revision: 1,
        }}
        overview={
          {
            goal: { status: "missing", summary: "尚未提供任务目标说明" },
            background: {
              status: "missing",
              summary: "当前尚未记录结构化背景与边界约束",
              items: [],
            },
            tasks: [],
            tests: [],
            findings: [],
            unresolved: [],
            progress: { tasks: null, tests: null },
          } as any
        }
        onOpenPlan={noop}
      />,
    );
    expect(html).toContain("修复导出");
    expect(html).toContain("查看完整计划");
    expect(html).not.toContain("尚未");
    for (const card of [
      "overview-background-card",
      "overview-findings-card",
      "overview-tasks-card",
      "overview-tests-card",
      "overview-grid-row",
    ])
      expect(html).not.toContain(card);
  });

  it("preserves findings, user constraints and real progress without an approval identifier", () => {
    const html = renderToStaticMarkup(
      <WorkflowOverview
        workflow={{ title: "修复导出", state: "COMMITTED" }}
        overview={
          {
            background: {
              status: "available",
              summary: "保留现有格式",
              items: [],
            },
            findings: [{ id: "finding", title: "大文件会超时" }],
            unresolved: ["导出数量限制"],
            tasks: [{ id: "task", title: "分批导出", status: "completed" }],
            tests: [{ id: "test", scenario: "导出十万条", status: "passed" }],
            execution_constraints: {
              approval_id: "approval-internal-id",
              text: "保持旧接口兼容",
            },
            progress: {
              tasks: { total: 1, completed: 1, percentage: 100 },
              tests: null,
            },
          } as any
        }
      />,
    );
    for (const text of [
      "保留现有格式",
      "大文件会超时",
      "导出数量限制",
      "分批导出",
      "导出十万条",
      "保持旧接口兼容",
      "代码已提交至本地仓库",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("approval-internal-id");
    expect(html).not.toContain("均已完整交付");
  });

  it("keeps recovery actions visible and technical diagnostics in a closed disclosure", () => {
    const html = renderToStaticMarkup(
      <RuntimeFailureNotice
        detail={{
          workflow: { id: "wf", state: "BLOCKED", version: 1 },
          attention: {
            resolution: {
              code: "CLI_NOT_FOUND",
              title: "找不到执行工具",
              message: "请检查工具路径",
              steps: ["安装对应 CLI"],
            },
            runtime_context: {
              adapter: "codex",
              executable_ref: "C:/missing/cli",
              exit_code: 17,
              diagnostic: "ENOENT",
            },
          },
        }}
        send={async () => {}}
        refresh={async () => {}}
      />,
    );
    expect(html).toContain("安装对应 CLI");
    expect(html).toContain("已处理，继续原任务");
    expect(html).toMatch(
      /<details><summary>技术详情<\/summary>[\s\S]*C:\/missing\/cli[\s\S]*ENOENT[\s\S]*<\/details>/,
    );
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("整改失败次数");
  });

  it("omits missing runtime metadata while preserving configured and observed values", () => {
    expect(
      conversationRuntimeLabels(resolveConversationRuntimeDisplay({})),
    ).toEqual([]);
    expect(
      conversationRuntimeLabels(
        resolveConversationRuntimeDisplay({
          actual_model: "gpt-test",
          supports_effort: false,
        }),
      ),
    ).toEqual(["gpt-test"]);
    expect(
      conversationRuntimeLabels(
        resolveConversationRuntimeDisplay({
          requested_model: "gpt-test",
          requested_effort: "high",
        }),
      ),
    ).toEqual(["gpt-test（请求）", "high（请求）"]);
    expect(
      viewedConversationRuntimeText({
        title: "检查接口",
        status: "running",
        adapterId: "codex",
      }),
    ).toBe("检查接口 · 正在工作 · Codex CLI");
    expect(
      formatApiError({ code: "INTERNAL_CODE", message: "请重新登录" }),
    ).toBe("请重新登录");
  });
});
