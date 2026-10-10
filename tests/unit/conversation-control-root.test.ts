import { describe, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import type { ConversationTreeSnapshot } from "../../packages/contracts/src/conversation.js";

function fixture() {
  const store = new Store(":memory:");
  store.put("workflow", "wf", "wf", { id: "wf", run_id: "current" });
  const run = { id: "current", workflow_id: "wf", adapter: "agy", purpose: "implement",
    profile: { adapterId: "agy", modelId: "gemini-flash" }, status: "failed" };
  store.put("run", run.id, "wf", run);
  const tree = {
    active_root_id: "review-root",
    nodes: [
      { id: "execute-root", root_id: "execute-root", adapter_id: "agy", native_session_id: "native-agy", kind: "main" },
      { id: "review-root", root_id: "review-root", adapter_id: "codex", native_session_id: "native-codex", kind: "main" },
    ],
    attempts: [
      { conversation_id: "execute-root", run_id: "prior-execute", generation: 1 },
      { conversation_id: "review-root", run_id: "prior-review", generation: 2 },
    ],
  } as ConversationTreeSnapshot;
  return { store, service: new ConversationService(store), run, tree };
}

describe("control root follows the current role rather than the display root", () => {
  it("uses the explicit continuation when prelaunch failure has no current native attempt", () => {
    const s = fixture();
    try {
      s.store.put("run", "current", "wf", { ...s.run, continuation: { conversation_id: "execute-root" } });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBe("execute-root");
      expect(s.tree.active_root_id).toBe("review-root");
    } finally { s.store.close(); }
  });

  it("prefers the current attempt over stale continuation and resolves its owning root", () => {
    const s = fixture();
    try {
      s.tree.nodes.push({ id: "new-root", root_id: "new-root", adapter_id: "agy", native_session_id: "new-native", kind: "main" } as any);
      s.tree.attempts.push({ conversation_id: "new-root", run_id: "current", generation: 3 } as any);
      s.store.put("run", "current", "wf", { ...s.run, continuation: { conversation_id: "execute-root" } });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBe("new-root");
    } finally { s.store.close(); }
  });

  it("can resolve the continuation source Run or matching session binding", () => {
    const s = fixture();
    try {
      s.store.put("run", "prior-execute", "wf", { ...s.run, id: "prior-execute", root_session_id: "native-agy" });
      s.store.put("run", "current", "wf", { ...s.run, continuation: { source_run_id: "prior-execute" } });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBe("execute-root");
      s.store.put("run", "current", "wf", s.run);
      s.store.put("session_binding", "binding", "wf", { adapter_id: "agy", canonical_model_id: "gemini-flash", state: "bound", conversation_id: "native-agy" });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBe("execute-root");
    } finally { s.store.close(); }
  });

  it("keeps the native session across model changes and refuses ambiguous ownership scopes", () => {
    const s = fixture();
    try {
      expect(s.service.resolveControlRoot("wf", s.tree)).toBeUndefined();
      s.store.put("session_binding", "wrong", "wf", { adapter_id: "agy", canonical_model_id: "other-model", state: "bound", conversation_id: "native-agy" });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBe("execute-root");
      s.store.remove("session_binding", "wrong");
      s.tree.nodes.push({ id: "another-root", root_id: "another-root", adapter_id: "agy", native_session_id: "another-native", kind: "main" } as any);
      for (const conversation of ["native-agy", "another-native"])
        s.store.put("session_binding", conversation, "wf", { adapter_id: "agy", canonical_model_id: "gemini-flash", state: "bound", conversation_id: conversation, workspace_identity: conversation });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBeUndefined();
    } finally { s.store.close(); }
  });

  it("does not bind aside to the main session and preserves legacy fallback without a current Run", () => {
    const s = fixture();
    try {
      s.store.put("session_binding", "binding", "wf", { adapter_id: "agy", canonical_model_id: "gemini-flash", state: "bound", conversation_id: "native-agy" });
      s.store.put("run", "current", "wf", { ...s.run, purpose: "aside" });
      expect(s.service.resolveControlRoot("wf", s.tree)).toBeUndefined();
      s.store.remove("run", "current");
      expect(s.service.resolveControlRoot("wf", s.tree)).toBe("review-root");
    } finally { s.store.close(); }
  });
});
