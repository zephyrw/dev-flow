import { expect, it } from "vitest";
import Fastify from "fastify";
import { conversationPlugin } from "../../apps/api/src/routes/conversations.js";
import { Store } from "../../packages/store/src/store.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { AgyConversationDecoder, decodeAgyConversationEvents } from "../../packages/adapters/agy/src/conversation-source.js";
import { readableLogs, userFacingLogs } from "../../packages/presentation/src/activity.js";
import { conversationLogs } from "../../packages/presentation/src/conversation-activity.js";
import { filterConversationEntries } from "../../apps/web/src/use-conversation-view.js";
import { modelReplyText } from "../../packages/presentation/src/model-reply.js";

const native = "11111111-1111-4111-8111-111111111111";
const context = { project_id: "p", workflow_id: "w", run_id: "r", adapter_id: "agy",
  scope: "acceptance_guidance", lineage_id: "w:agy", purpose: "acceptance_guidance", root_native_id: native };

it("omits historical identity-only records from HTTP history while retaining actual replies", async () => {
  const store = new Store(":memory:");
  const app = Fastify({ logger: false });
  try {
    store.put("workflow", "w", "p", { id: "w", project_id: "p", run_id: "r", plan_revision: 1 });
    const conversations = new ConversationService(store);
    conversations.applyEvent(context, { source_id: "s", source_seq: "1", root_native_id: native,
      session_native_id: native, kind: "discovered", payload: { status: "running" } });
    const tree = conversations.getTree("w");
    const root = tree.nodes[0]!;
    const payload = { conversation_id: root.id, root_id: root.id, attempt_id: tree.attempts[0]!.id, source_event_id: "fixture" };
    store.event("w", "p", "ConversationActivity", { ...payload, activity_id: "run-stream:391" }, "r");
    store.event("w", "p", "ConversationActivity", { ...payload, activity_id: "reply", kind: "message", public_text: "已修复标题，等待验收。" }, "r");
    await app.register(conversationPlugin, { conversations, store, human: () => {} });
    const response = await app.inject({ method: "GET", url: `/api/workflows/w/conversations/${root.id}/activities` });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([expect.objectContaining({ text: "已修复标题，等待验收。" })]);
  } finally { await app.close(); store.close(); }
});

it("ignores raw protocol envelopes but preserves status-only tool completion and its arguments", () => {
  const store = new Store(":memory:");
  try {
    const service = new ConversationService(store);
    const apply = (seq: number, payload: object) => service.applyEvent(context, {
      source_id: "run-stream", source_seq: String(seq), root_native_id: native,
      session_native_id: native, kind: "activity", payload,
    });
    apply(1, { event: "step_update", step_update: { step_type: "user_input", state: "DONE" } });
    apply(2, { event: "step_update", step_update: { step_type: "finish", state: "DONE" } });
    expect(store.events("w").filter(e => e.type === "ConversationActivity")).toHaveLength(0);
    apply(3, { activity_id: "tool", kind: "tool", title: "执行命令", command: "git status", cwd: "C:/repo", status: "running" });
    apply(4, { activity_id: "tool", status: "completed" });
    const logs = readableLogs(store.events("w"), "w");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ command: "git status", cwd: "C:/repo", status: "done" });
  } finally { store.close(); }
});

it("restores stored guidance replies to the root timeline and removes historical identity-only rows", () => {
  const summary = "已按指导修复数据概览标题和样式。\n当前等待人工验收。";
  const notes = "未处理线上发布：用户尚未要求发布。";
  const events = [
    { type: "ConversationActivity", payload: { conversation_id: "root", root_id: "root", attempt_id: "a", activity_id: "run-stream:391" } },
    { type: "ConversationActivity", payload: { conversation_id: "root", root_id: "root", attempt_id: "a", activity_id: "old", title: "会话活动" } },
    { type: "ConversationActivity", payload: { conversation_id: "root", root_id: "root", attempt_id: "a", activity_id: "mcp", kind: "tool", title: "call_mcp_tool", status: "completed" } },
    { type: "UserGuidanceCompleted", payload: { summary, notes } },
  ].map((event, index) => ({ ...event, event_seq: index + 1, workflow_id: "w", run_id: "r", created_at: "2026-09-29T12:49:13Z" }));
  const logs = readableLogs(events, "w");
  expect(logs).toHaveLength(1);
  const rows = filterConversationEntries(userFacingLogs(logs, "r"), "root", "root");
  expect(rows).toEqual([expect.objectContaining({ title: "执行模型回复", kind: "message", status: "done", text: summary + "\n\n" + notes })]);
});

it("keeps streamed public replies across chunks, including usage-only DONE and final responses without text_delta", () => {
  const store = new Store(":memory:");
  try {
    const service = new ConversationService(store);
    const decoder = new AgyConversationDecoder(native);
    const accept = (value: object) => {
      const data = JSON.stringify(value) + "\n";
      // The transport may split an individual JSON line at any position.
      for (const part of [data.slice(0, 23), data.slice(23)]) {
        for (const event of decoder.push({ stream: "stdout", data: part, timestamp: "2026-09-29T12:49:13Z", runId: "r" }))
          service.applyEvent(context, event);
      }
    };
    const step = (extra: object) => ({ event: "step_update", step_update: { conversation_id: native, step_index: 2423, step_type: "agent_response", state: "ACTIVE", ...extra } });
    accept({ event: "init", conversation_id: native, init: { model: "gemini" } });
    accept(step({ text_delta: "已修复标题。" }));
    accept(step({ text_delta: "继续核对表格。" }));
    accept(step({ state: "DONE", usage: { output_tokens: 5917 } }));
    accept({ event: "result", result: { conversation_id: native, status: "SUCCESS", response: JSON.stringify({
      summary: "已完成标题和表格修复。", notes: "截图核对通过；尚未发布，等待验收。", artifacts: [],
    }) } });
    const tree = service.getTree("w");
    const events = store.events("w");
    for (const rows of [readableLogs(events, "w"), conversationLogs(events, tree.nodes[0]!.id)]) {
      expect(rows.map(row => row.text)).toEqual(["已修复标题。继续核对表格。", "已完成标题和表格修复。\n\n截图核对通过；尚未发布，等待验收。"]);
      expect(rows.every(row => row.status === "done")).toBe(true);
    }
  } finally { store.close(); }
});

it("retains ordinary Markdown final replies and does not synthesize a reply for an empty completion", () => {
  expect(modelReplyText("### 结果\n已修复，等待验收。")).toBe("### 结果\n已修复，等待验收。");
  expect(modelReplyText(" ")).toBeUndefined();
  expect(modelReplyText(JSON.stringify({ summary: "完成", notes: "完成" }))).toBe("完成");
});

it("projects the actual MCP operation instead of its generic dispatch wrapper", () => {
  const events = decodeAgyConversationEvents(["browser_execute_script", "view_file"].map((name, index) => ({
    event: "step_update", step_update: { conversation_id: native, step_index: 2193 + index,
      step_type: "tool", state: "DONE", tool_name: "call_mcp_tool", tool_info: { name: "call_mcp_tool",
        parameters: { ServerName: "example", ToolName: name, Arguments: { AbsolutePath: "C:/repo/app.ts" } } } },
  })), { rootNativeId: native });
  expect(events.map(event => event.payload)).toEqual([
    expect.objectContaining({ title: "browser_execute_script", public_text: "C:/repo/app.ts" }),
    expect.objectContaining({ title: "读取文件", public_text: "C:/repo/app.ts" }),
  ]);
});
