import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { agySessionAcrossAccounts } from "../../packages/runtime/src/agy-session-resume.js";
import { computeSessionOwnerKey, type SessionBindingKey } from "../../packages/contracts/src/session-binding.js";

let root: string;
let store: Store;
let sessions: ExecutionSessionStore;
const key: SessionBindingKey = { workflow_id: "wf", adapter_id: "agy", host_id: "host", client_scope_id: "client",
  provider_account_scope: "account-a", canonical_model_id: "model", workspace_identity: "workspace" };
const context = { workspace_root: "workspace", source_root: "workspace", repo_id: "main" };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-11T00:00:00.000Z"));
  root = mkdtempSync(join(realpathSync.native(tmpdir()), "devflow-confirm-order-"));
  store = new Store(join(root, "state.db")); sessions = new ExecutionSessionStore(store);
});
afterEach(() => { store.close(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
function reserve(model: string) { return sessions.getOrCreateBinding({ ...key, canonical_model_id: model }, context); }
function chosen() {
  const current = sessions.findReusableBinding(key)!;
  const across = agySessionAcrossAccounts(store, { ...key, provider_account_scope: "account-c" })!;
  expect(across.id).toBe(current.id);
  return current;
}
function reopen() { store.close(); store = new Store(join(root, "state.db")); sessions = new ExecutionSessionStore(store); }

it("same-millisecond native confirmations outrank random IDs and persist after Store reopening", () => {
  const [first, last] = [reserve("one"), reserve("two")].sort((a, b) => a.id.localeCompare(b.id));
  const old = sessions.bindConversationId(first!.id, "old-native", "same-run");
  const latest = sessions.bindConversationId(last!.id, "latest-native", "same-run");
  expect(latest.updated_at).toBe(old.updated_at); expect(latest.created_at).toBe(old.created_at);
  expect(chosen()).toMatchObject({ id: latest.id, conversation_id: "latest-native" });
  reopen(); expect(chosen().id).toBe(latest.id);
});

it("confirmation order follows init rather than reservation order, including a later resumed Run", () => {
  const early = reserve("early"), late = reserve("late");
  sessions.bindConversationId(late.id, "late-reserved-native", "run1");
  const first = sessions.bindConversationId(early.id, "early-reserved-native", "run2");
  expect(chosen().id).toBe(early.id);
  const resumed = sessions.bindConversationId(late.id, "late-reserved-native", "run3");
  expect(chosen().id).toBe(late.id);
  expect(resumed).toMatchObject({ first_run_id: "run1", latest_run_id: "run3", revision: first.revision, generation: first.generation });
  reopen(); expect(chosen().id).toBe(late.id);
  expect(sessions.findReusableBinding(key, "early-reserved-native")?.id).toBe(early.id);
});

it("same-Run replay does not advance confirmation order or change the original binding", () => {
  const one = reserve("one"), two = reserve("two");
  const original = sessions.bindConversationId(one.id, "first-native", "run1");
  sessions.bindConversationId(two.id, "second-native", "run2");
  const order = store.list("session_binding_confirmation", key.workflow_id);
  const version = store.getVersion("session_binding_confirmation", one.id);
  expect(sessions.bindConversationId(one.id, "first-native", "run1")).toEqual(original);
  expect(store.list("session_binding_confirmation", key.workflow_id)).toEqual(order);
  expect(store.getVersion("session_binding_confirmation", one.id)).toBe(version);
  reopen(); expect(chosen().id).toBe(two.id);
});

it("historical bindings without confirmation indexes keep stable persisted tie selection", () => {
  const early = reserve("early"), late = reserve("late");
  sessions.bindConversationId(early.id, "early-native", "same-run");
  sessions.bindConversationId(late.id, "late-native", "same-run");
  store.remove("session_binding_confirmation", early.id); store.remove("session_binding_confirmation", late.id);
  expect(chosen().id).toBe(late.id);
  reopen(); expect(chosen().id).toBe(late.id);
});

it("latest confirmation never bypasses ownership or unavailable-root protection", () => {
  const early = reserve("early"), late = reserve("late");
  sessions.bindConversationId(early.id, "early-native", "run1");
  const latest = sessions.bindConversationId(late.id, "late-native", "run2");
  const owner = computeSessionOwnerKey({ ...latest, conversation_id: "late-native" });
  store.put("session_owner_index", owner, "foreign", { workflow_id: "foreign", binding_id: "foreign-binding" });
  expect(() => sessions.findReusableBinding(key)).toThrowError(expect.objectContaining({ code: "SESSION_ALREADY_OWNED", status: 409 }));
  expect(() => agySessionAcrossAccounts(store, { ...key, provider_account_scope: "account-c" }))
    .toThrowError(expect.objectContaining({ code: "SESSION_ALREADY_OWNED", status: 409 }));
  sessions.updateBindingState(late.id, latest.revision, "unavailable");
  expect(chosen().id).toBe(early.id);
  expect(sessions.getBindingById(late.id)?.conversation_id).toBe("late-native");
});
