import { afterEach, expect, it } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import type { SessionBindingKey } from "../../packages/contracts/src/session-binding.js";
import type { Run } from "../../packages/contracts/src/index.js";
import { beginRunConversation, retainRunConversation } from "../../packages/core/src/conversation-lineage.js";
import { sessionHandoffForRun, sessionHandoffMaterials } from "../../packages/core/src/session-handoff.js";
import { inputStageKey, isSessionFollowup } from "../../packages/core/src/session-input.js";
import { nativeRootForRun } from "../../packages/core/src/native-session.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const sessions = new ExecutionSessionStore(store);
  const key: SessionBindingKey = { workflow_id: "w", adapter_id: "codex", host_id: "host", client_scope_id: "client",
    provider_account_scope: "account", canonical_model_id: "astra", workspace_identity: "workspace" };
  const bind = (suffix: string, model = "astra", changes = {}) => {
    const b = sessions.getOrCreateBinding({ ...key, canonical_model_id: model, ...changes },
      { workspace_root: "workspace", source_root: "workspace", repo_id: "main" });
    return sessions.bindConversationId(b.id, suffix, "run-" + suffix);
  };
  return { store, sessions, key, bind };
}
function run(id: string, adapter: "codex" | "agy", native?: string): Run {
  return { id, workflow_id: "w", plan_revision: 1, adapter, purpose: "implement", stage: "execute", status: "stopped",
    package_hash: "pkg", started_at: `2026-09-30T01:00:0${id.slice(-1)}Z`, conversation_id: native,
    profile: { id: adapter, revision: 1, adapterId: adapter, modelSelection: "explicit", modelId: "model", options: {} } };
}
it("model-only resume selects the confirmed source root even with an empty new-model reservation", () => {
  const { sessions, key, bind } = fixture(); const old = bind("original");
  sessions.getOrCreateBinding({ ...key, canonical_model_id: "sol" }, { workspace_root: "workspace", source_root: "workspace", repo_id: "main" });
  bind("other", "other-model");
  expect(sessions.findReusableBinding({ ...key, canonical_model_id: "sol" }, "original")?.id).toBe(old.id);
  expect(sessions.getBinding(key)?.canonical_model_id).toBe("astra");
});
it("target-tool lookup ignores model but retains account, client, host, workspace and task isolation", () => {
  const { sessions, key, bind } = fixture(); bind("native");
  expect(sessions.findReusableBinding({ ...key, canonical_model_id: "sol" })?.conversation_id).toBe("native");
  for (const change of [{ adapter_id: "agy" }, { provider_account_scope: "other" }, { host_id: "other" },
    { client_scope_id: "other" }, { workspace_identity: "other" }, { workflow_id: "other" }])
    expect(sessions.findReusableBinding({ ...key, ...change })).toBeUndefined();
});
it("same-tool A-B-A models keep one native session and preserve invocation settings", () => {
  const { store } = fixture(); const a = run("run1", "codex", "native");
  store.put("run", a.id, "w", a); beginRunConversation(store, a); retainRunConversation(store, a, "native");
  const b = { ...a, id: "run2", profile: { ...a.profile!, modelId: "sol", reasoning: { mode: "explicit" as const, value: "high" } },
    continuation: { kind: "runtime_resume" as const, purpose: "execute" as const, role: "executor" as const, source_run_id: a.id } };
  expect(beginRunConversation(store, b)?.id).toBe("native");
  expect(sessionHandoffForRun(store, b, "native")).toBeUndefined();
  expect(b.profile.modelId).toBe("sol");
});
it("cross-tool start is allowed; switching back reuses its own root and carries missed progress", () => {
  const { store } = fixture(); const a = run("run1", "codex", "codex-native");
  store.put("run", a.id, "w", a); beginRunConversation(store, a); retainRunConversation(store, a, "codex-native");
  const b = { ...run("run2", "agy"), continuation: { kind: "runtime_resume" as const, purpose: "execute" as const,
    role: "executor" as const, source_run_id: a.id } };
  store.put("run", b.id, "w", b);
  expect(isSessionFollowup(store, b, undefined, [])).toBe(false);
  expect(beginRunConversation(store, b)).toBeUndefined();
  const handoff = sessionHandoffForRun(store, b)!;
  expect(handoff).toMatchObject({ source_adapter: "codex", target_adapter: "agy" });
  retainRunConversation(store, b, "agy-native");
  const next = { ...run("run3", "codex"), continuation: { ...b.continuation, source_run_id: b.id } };
  expect(beginRunConversation(store, next)?.id).toBe("codex-native");
  const back = sessionHandoffForRun(store, next, "codex-native")!;
  expect(back.since_run_id).toBe(a.id);
  expect(sessionHandoffMaterials(store, next, back).progress.map(p => p.run_id)).toEqual([b.id]);
});
it("handoff delivery is idempotent and an unknown delivery cannot create or reinject a session", () => {
  const { store } = fixture(); const source = run("run1", "codex", "codex-native"); store.put("run", source.id, "w", source);
  const target = { ...run("run2", "agy"), continuation: { kind: "runtime_resume" as const, purpose: "execute" as const,
    role: "executor" as const, source_run_id: source.id } };
  const h = sessionHandoffForRun(store, target, "agy-native")!;
  const receipt = { run_id: "previous", target_adapter: "agy", conversation_id: "agy-native", handoff_context_hash: h.context_hash,
    kind: "cross_tool_handoff", stage_key: inputStageKey(target), message_ids: [], state: "started" };
  store.put("session_input", "previous", "w", receipt);
  expect(() => sessionHandoffForRun(store, target, "agy-native")).toThrow("投递结果尚未确认");
  store.put("session_input", "previous", "w", { ...receipt, state: "delivered" });
  expect(sessionHandoffForRun(store, target, "agy-native")).toBeUndefined();
  expect(sessionHandoffForRun(store, target, "different-native")).toBeDefined();
});
it("internal display IDs are never used as native session IDs", () => {
  const { store } = fixture(); const a = run("run1", "codex", "cnv-display");
  expect(nativeRootForRun(store, a)).toBeUndefined();
  store.put("conversation_node", "cnv-display", "w", { id: "cnv-display", root_id: "cnv-display", adapter_id: "codex", native_session_id: "actual-native" });
  expect(nativeRootForRun(store, a)).toBe("actual-native");
});
