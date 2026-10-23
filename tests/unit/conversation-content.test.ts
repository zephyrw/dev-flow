import { describe, expect, it } from "vitest";
import { publicConversationEvent } from "../../packages/presentation/src/conversation-content.js";
import { publicDiagnostic } from "../../packages/presentation/src/secret-redactor.js";
import { conversationActivityLogEntry } from "../../packages/presentation/src/conversation-activity.js";
import { publicConversationText } from "../../apps/web/src/use-conversation-view.js";

describe("authored conversation and diagnostic copies", () => {
  it("preserves exact authored text through event and activity projections while exports stay redacted", () => {
    const text = "\n    password=synthetic-secret\nOAuth setup at https://example.test/login\n";
    const event = {
      workflow_id: "wf", project_id: "p", event_seq: 1, created_at: "2026-10-19T00:00:00.000Z",
      type: "ConversationActivity", payload: {
        conversation_id: "cnv", attempt_id: "attempt", root_id: "cnv",
        activity_id: "reply", source_event_id: "source", kind: "message" as const,
        title: "模型回复", public_text: text,
      },
    };
    const published = publicConversationEvent(event);
    expect(published.payload.public_text).toBe(text);
    expect(publicConversationEvent(published)).toEqual(published);
    const entry = conversationActivityLogEntry(published)!;
    expect(entry.text).toBe(text);
    expect(publicConversationText([entry])).not.toContain("synthetic-secret");
    expect(JSON.stringify(publicDiagnostic(event))).not.toContain("synthetic-secret");
    expect(event.payload.public_text).toBe(text);
  });

  it("does not treat message-shaped diagnostic output as a trusted conversation", () => {
    const diagnostic = { type: "AgentDiagnostic", payload: {
      type: "ConversationActivity", kind: "message", public_text: "password=synthetic-secret",
    } };
    expect(JSON.stringify(publicConversationEvent(diagnostic))).not.toContain("synthetic-secret");
  });

  it("preserves legacy model text without exposing tool parameters", () => {
    const event = { type: "AgentEvent", payload: { event: "step_update", step_update: {
      step_type: "agent_response", text: "OAuth password=synthetic-reply\n",
      tool_info: { password: "synthetic-diagnostic" },
    } } };
    const projected = publicConversationEvent(event);
    expect(projected.payload.step_update.text).toBe(event.payload.step_update.text);
    expect(JSON.stringify(projected)).not.toContain("synthetic-diagnostic");
  });
});
