import { expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { decodeAgyConversationEvents } from "../../packages/adapters/agy/src/conversation-source.js";
import { readableLogs } from "../../packages/presentation/src/activity.js";
import { conversationLogs } from "../../packages/presentation/src/conversation-activity.js";

const native = "11111111-1111-4111-8111-111111111111";
it("keeps AGY command/file summaries visible and tool completion separate from session completion", () => {
  const store = new Store(":memory:");
  try {
    const service = new ConversationService(store);
    const context = { project_id: "p", workflow_id: "w", run_id: "r", adapter_id: "agy",
      scope: "implement", lineage_id: "w:implement:agy", purpose: "implement", root_native_id: native };
    const command = 'rg "initialDateRange" src/views\nGet-Content src/report.vue';
    const tool = (index: number, name: string, state: string, parameters?: object, output?: string) => ({
      event: "step_update", step_update: { conversation_id: native, step_index: index,
        step_type: "tool", state, tool_info: { name, parameters, output } },
    });
    const apply = (events: unknown[]) => {
      for (const event of decodeAgyConversationEvents(events, { rootNativeId: native }))
        service.applyEvent(context, event);
    };
    apply([
      { event: "init", conversation_id: native, init: { model: "gemini-3.8-flash-high" } },
      tool(1, "run_command", "ACTIVE", { CommandLine: command, Cwd: "C:/repo" }),
      tool(1, "run_command", "DONE", undefined, "BUILD SUCCESS"),
      tool(2, "view_file", "DONE", { AbsolutePath: "C:/repo/report.vue" }),
      tool(3, "replace_file_content", "ERROR", { TargetFile: "C:/repo/report.vue", ReplacementContent: "private source" }),
    ]);
    const tree = service.getTree("w");
    expect(tree.attempts[0]?.status).toBe("running");
    const events = store.events("w");
    const rows = readableLogs(events, "w").filter(row => row.kind === "tool");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ title: "执行命令", command, cwd: "C:/repo", status: "done", resultText: "本次构建已通过。" });
    expect(rows[1]).toMatchObject({ title: "读取文件", text: "C:/repo/report.vue" });
    expect(rows[2]).toMatchObject({ title: "修改文件", text: "C:/repo/report.vue", status: "error" });
    expect(JSON.stringify(rows)).not.toContain("private source");
    expect(conversationLogs(events, tree.nodes[0]!.id)[0]).toMatchObject({ command, cwd: "C:/repo" });
    apply([{ event: "result", result: { conversation_id: native, status: "SUCCESS" } }]);
    expect(service.getTree("w").attempts[0]?.status).toBe("completed");
    apply([tool(4, "view_file", "DONE", { AbsolutePath: "late.vue" })]);
    expect(service.getTree("w").attempts[0]?.status).toBe("completed");
  } finally { store.close(); }
});

it("retains historical command-only activities without inventing body text", () => {
  const rows = readableLogs([{ workflow_id: "w", event_seq: 1, created_at: "2026-09-28T00:00:00Z",
    type: "ConversationActivity", payload: { conversation_id: "c", root_id: "c", attempt_id: "a",
      activity_id: "t", kind: "tool", title: "run_command", command: "git status", status: "completed" } }], "w");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.command).toBe("git status");
});
