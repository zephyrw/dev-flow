import { describe, it, expect } from "vitest";
import { readableLogs, userFacingLogs } from "../../packages/presentation/src/activity.js";
import {
  isMeaningfulLogEntry,
  conversationActivityLogEntry,
  mergeConversationLogEntry,
  conversationLogs,
} from "../../packages/presentation/src/conversation-activity.js";

describe("conversation-activity-meaningful (U3 & U4: 执行活动有效投影与增量合并)", () => {
  it("merged log filtering retains cwd-only and failed tools while removing empty cards", () => {
    const rows = readableLogs([
      { id: "empty", kind: "tool", title: "执行命令", text: "", status: "done" },
      { id: "message", kind: "message", title: "模型输出", text: "", status: "done" },
      { id: "cwd", kind: "tool", title: "执行命令", text: "", cwd: "/repo", status: "done" },
      { id: "failed", kind: "tool", title: "执行命令", text: "", status: "error" },
    ].map((payload, index) => ({
      event_seq: index + 1, workflow_id: "wf", run_id: "run", created_at: String(index),
      type: "NativeActivity", payload,
    })), "wf");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ cwd: "/repo" });
    expect(rows[1]).toMatchObject({ status: "error" });
  });

  it("U4: legacy native completion retains command and path from an earlier increment", () => {
    const events = [
      { event_seq: 2, workflow_id: "wf", run_id: "run", created_at: "later", type: "NativeActivity",
        payload: { id: "cmd", kind: "tool", title: "执行命令", text: "   ", status: "done" } },
      { event_seq: 1, workflow_id: "wf", run_id: "run", created_at: "earlier", type: "NativeActivity",
        payload: { id: "cmd", kind: "tool", title: "执行命令", text: "git status", command: "git status", cwd: "/repo", status: "active" } },
    ];
    const rows = userFacingLogs(readableLogs(events, "wf"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ command: "git status", cwd: "/repo", text: "git status", status: "done" });
  });

  it("U4: reversed conversation increments finish at the latest status without losing details", () => {
    const payload = { conversation_id: "c", attempt_id: "a", activity_id: "cmd", kind: "tool" };
    const rows = conversationLogs([
      { event_seq: 2, created_at: "later", type: "ConversationActivity", payload: { ...payload, status: "completed", command: "  " } },
      { event_seq: 1, created_at: "earlier", type: "ConversationActivity", payload: { ...payload, status: "running", command: "git status", cwd: "/repo" } },
    ], "c");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sequence: 2, command: "git status", cwd: "/repo", status: "done" });
  });

  it("U3: 无标题、空白或纯占位活动被正确判定为无意义", () => {
    expect(isMeaningfulLogEntry({})).toBe(false);
    expect(isMeaningfulLogEntry({ title: "会话活动", text: "", command: "" })).toBe(false);
    expect(isMeaningfulLogEntry({ title: "活动", text: "   " })).toBe(false);
    expect(isMeaningfulLogEntry({ title: "", text: "" })).toBe(false);
    expect(isMeaningfulLogEntry({ title: "模型输出", kind: "message", status: "done" })).toBe(false);
    expect(isMeaningfulLogEntry({ title: "执行命令", kind: "tool", status: "active" })).toBe(false);
    expect(isMeaningfulLogEntry({ title: "会话活动", kind: "event", status: "done" })).toBe(false);
  });

  it("U3: 含有命令、公开文字、结果文本或错误状态的活动被判定为有意义", () => {
    expect(isMeaningfulLogEntry({ command: "pnpm test" })).toBe(true);
    expect(isMeaningfulLogEntry({ text: "正在分析项目结构..." })).toBe(true);
    expect(isMeaningfulLogEntry({ resultText: "所有测试通过" })).toBe(true);
    expect(isMeaningfulLogEntry({ status: "error" })).toBe(true);
    expect(isMeaningfulLogEntry({ exitCode: 0 })).toBe(true);
    expect(isMeaningfulLogEntry({ output: "构建成功" })).toBe(true);
    expect(isMeaningfulLogEntry({ cwd: "/repo" })).toBe(true);
  });

  it("U3: preserves explicit operation titles and workflow facts without reviving empty model cards", () => {
    expect(isMeaningfulLogEntry({ title: "工具 · list_agents", kind: "tool" })).toBe(true);
    expect(isMeaningfulLogEntry({ title: "等待用户确认部署", kind: "event" })).toBe(true);
    expect(isMeaningfulLogEntry({ title: "模型输出 · 完成", kind: "message" })).toBe(false);
    const entries = readableLogs([
      { event_seq: 1, workflow_id: "wf", created_at: "now", type: "ProcessesReconciled", payload: {} },
      { event_seq: 2, workflow_id: "wf", created_at: "now", type: "ModelRetryStarted", payload: {} },
      { event_seq: 3, workflow_id: "wf", created_at: "now", type: "OperationCompleted", payload: {} },
    ], "wf");
    expect(userFacingLogs(entries).map((entry) => entry.title)).toEqual([
      "任务已恢复", "额度恢复后继续执行", "授权操作已结束",
    ]);
  });

  it("U3: conversationActivityLogEntry 依据命令、消息、状态生成清晰具体标题", () => {
    const commandEvent = {
      event_seq: 1,
      created_at: "2026-09-28T10:00:00Z",
      payload: {
        conversation_id: "c1",
        attempt_id: "a1",
        activity_id: "act-1",
        command: "git status",
      },
    };
    const entry1 = conversationActivityLogEntry(commandEvent as any);
    expect(entry1?.title).toBe("执行命令");
    expect(entry1?.command).toBe("git status");

    const messageEvent = {
      event_seq: 2,
      created_at: "2026-09-28T10:00:01Z",
      payload: {
        conversation_id: "c1",
        attempt_id: "a1",
        activity_id: "act-2",
        kind: "message" as const,
        public_text: "正在执行代码重构",
      },
    };
    const entry2 = conversationActivityLogEntry(messageEvent as any);
    expect(entry2?.title).toBe("模型输出");
    expect(entry2?.text).toBe("正在执行代码重构");

    const failedEvent = {
      event_seq: 3,
      created_at: "2026-09-28T10:00:02Z",
      payload: {
        conversation_id: "c1",
        attempt_id: "a1",
        activity_id: "act-3",
        status: "failed" as const,
      },
    };
    const entry3 = conversationActivityLogEntry(failedEvent as any);
    expect(entry3?.title).toBe("执行失败");
    expect(entry3?.status).toBe("error");
  });

  it("U4: 开始含命令、完成仅含状态/结果时合并后命令保留且更新成功状态与退出码0", () => {
    const existing = {
      key: "c1-a1-act-cmd",
      sequence: 10,
      created_at: "2026-09-28T10:00:00Z",
      title: "执行命令",
      text: "npm run build",
      raw: [],
      command: "npm run build",
      cwd: "/repo",
      status: "active" as const,
    };

    const incoming = {
      key: "c1-a1-act-cmd",
      sequence: 11,
      created_at: "2026-09-28T10:00:05Z",
      title: "会话活动", // 完成事件可能未带命令或通用占位
      text: "",
      raw: [],
      status: "done" as const,
      resultText: "构建成功 (exit code: 0)",
    };

    const merged = mergeConversationLogEntry(existing, incoming);
    expect(merged.command).toBe("npm run build");
    expect(merged.cwd).toBe("/repo");
    expect(merged.title).toBe("执行命令"); // 不会被通用占位降级
    expect(merged.status).toBe("done");
    expect(merged.resultText).toBe("构建成功 (exit code: 0)");
  });

  it("U4: conversationLogs 统一过滤空活动且正确聚合多条增量事件", () => {
    const events = [
      // 空占位事件
      {
        event_seq: 1,
        workflow_id: "wf-1",
        created_at: "2026-09-28T10:00:00Z",
        type: "ConversationActivity",
        payload: {
          conversation_id: "c1",
          root_id: "c1",
          attempt_id: "a1",
          activity_id: "empty-1",
          title: "会话活动",
        },
      },
      // 有效命令开始
      {
        event_seq: 2,
        workflow_id: "wf-1",
        created_at: "2026-09-28T10:00:01Z",
        type: "ConversationActivity",
        payload: {
          conversation_id: "c1",
          root_id: "c1",
          attempt_id: "a1",
          activity_id: "cmd-1",
          command: "vitest run",
          status: "running",
        },
      },
      // 有效命令结束
      {
        event_seq: 3,
        workflow_id: "wf-1",
        created_at: "2026-09-28T10:00:05Z",
        type: "ConversationActivity",
        payload: {
          conversation_id: "c1",
          root_id: "c1",
          attempt_id: "a1",
          activity_id: "cmd-1",
          status: "completed",
          result_text: "3 pass",
        },
      },
    ];

    const logs = conversationLogs(events as any, "c1");
    // 空占位事件被过滤，只剩 cmd-1 合并后的一条记录
    expect(logs).toHaveLength(1);
    expect(logs[0]?.command).toBe("vitest run");
    expect(logs[0]?.status).toBe("done");
    expect(logs[0]?.resultText).toBe("3 pass");
  });
});
