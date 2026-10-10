import { describe, expect, it } from "vitest";
import { selectConversationMessageTarget } from "../../apps/web/src/conversation-message-target.js";
import type { ConversationAttempt, ConversationNode } from "../../packages/contracts/src/conversation.js";

const node = (id: string, kind: ConversationNode["kind"] = "main", rootId = id): ConversationNode => ({
  id, root_id: rootId, kind, project_id: "project", workflow_id: "wf", adapter_id: "codex-cli",
  purpose: "implementation", lineage_id: `lineage-${id}`, title: id, created_at: "2026-10-10T00:00:00Z", updated_at: "2026-10-10T00:00:00Z",
});
const attempt = (id: string, generation: number): ConversationAttempt => ({
  id: `attempt-${id}-${generation}`, conversation_id: id, root_id: id, workflow_id: "wf", run_id: `run-${generation}`,
  generation, status: "running", observed_at: "2026-10-10T00:00:00Z", freshness: "fresh",
});

describe("conversation message target refresh", () => {
  it("replaces a disappeared legacy root with the fresh active root and generation", () => {
    expect(selectConversationMessageTarget({ active_root_id: "native-root", nodes: [
      node("native-root"),
    ], attempts: [attempt("native-root", 4)] }, "wf", "leg-old-run", 0))
      .toEqual({ rootId: "native-root", generation: 4 });
  });
  it("keeps an explicitly viewed persistent root while refreshing its generation", () => {
    expect(selectConversationMessageTarget({ active_root_id: "new-root", nodes: [
      node("history-root"), node("new-root"),
    ], attempts: [attempt("history-root", 1), attempt("history-root", 3), attempt("new-root", 1)] }, "wf", "history-root", 2))
      .toEqual({ rootId: "history-root", generation: 3 });
  });
  it("selects a real main node when a stopped tree has no active root, ignoring child and aside nodes", () => {
    expect(selectConversationMessageTarget({ nodes: [
      node("aside", "aside"), node("child", "subagent", "main"), node("main"),
    ], attempts: [attempt("main", 2)] }, "wf", "gone", 6))
      .toEqual({ rootId: "main", generation: 2 });
  });
  it("does not reuse a removed root generation when the active root has no generation", () => {
    expect(selectConversationMessageTarget({ active_root_id: "current-root", nodes: [], attempts: [] }, "wf", "old-root", 5))
      .toEqual({ rootId: "current-root", generation: 0 });
  });
});
