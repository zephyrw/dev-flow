import { afterEach, expect, it, vi } from "vitest";
import { setup, project } from "../helpers.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { agySessionAcrossAccounts } from "../../packages/runtime/src/agy-session-resume.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import { computeSessionBindingKey, computeSessionOwnerKey, type SessionBindingKey } from "../../packages/contracts/src/session-binding.js";
import type { Run, ToolProfile, Workflow } from "../../packages/contracts/src/index.js";

const sdk = vi.hoisted(() => ({ adapter: undefined as any, identity: undefined as any }));
vi.mock("../../packages/adapters/sdk/src/index.js", async (original) => ({
  ...await original<object>(),
  createDefaultAdapterRegistry: () => ({ mustGet: () => sdk.adapter }),
  resolveSessionIdentity: async () => sdk.identity,
}));
const stores: ReturnType<typeof setup>["store"][] = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const s = setup(); stores.push(s.store);
  const key: SessionBindingKey = { workflow_id: "wf-account-session", adapter_id: "agy", host_id: "fixture-host",
    client_scope_id: "fixture-client", provider_account_scope: "account-a", canonical_model_id: "gemini-fixture",
    workspace_identity: "fixture-workspace" };
  const sessions = new ExecutionSessionStore(s.store);
  const context = { workspace_root: s.root, source_root: s.root, repo_id: "main" };
  const source: Run = { id: "source-stopped", workflow_id: key.workflow_id, adapter: "agy", purpose: "implement",
    plan_revision: 0, stage: "execute", status: "stopped", started_at: "2026-09-29T01:00:00Z", package_hash: "fixture" };
  s.store.put("run", source.id, key.workflow_id, source);
  const a = sessions.getOrCreateBinding(key, context);
  sessions.bindConversationId(a.id, "original-local-session", source.id);
  return { ...s, key, sessions, context, source };
}
function invocationFixture() {
  const s = fixture();
  s.store.put("project", "p1", "p1", project(s.root));
  const workflow = { id: s.key.workflow_id, project_id: "p1", title: "fixture", request: "fixture",
    complexity: "simple", workspace_mode: "existing_workspace", state: "EXECUTING", stage: "execute",
    version: 1, plan_revision: 0, environment_revision: 0, created_at: "2026-09-29T01:00:00Z",
    updated_at: "2026-09-29T01:00:00Z", feedback: [], binding_strategy: "unified" } as Workflow;
  s.store.put("workflow", workflow.id, "p1", workflow);
  sdk.adapter = new AgyNativeCliAdapter();
  vi.spyOn(sdk.adapter, "probe").mockResolvedValue({ available: true } as any);
  const resume = vi.spyOn(sdk.adapter, "resume"); // Real resume/prepare and CLI argument construction.
  const start = vi.fn((_input: any) => { throw new Error("fixture-before-process-start"); });
  const runtime = new ProfileRuntime(s.engine, { start } as any) as any;
  const identity = vi.spyOn(ModelAccessService.prototype, "resolveNativeConfig");
  const invoke = async (account: string, id: string, purpose: Run["purpose"] = "implement", frozenAccount = account) => {
    sdk.identity = { ...s.key, provider_account_scope: account, resolved: true };
    identity.mockReturnValue({ identityConfidence: "account", accountId: account, accountFingerprint: frozenAccount } as any);
    const profile: ToolProfile = { id: "fixture-agy", revision: 1, adapterId: "agy", executableRef: process.execPath,
      modelSelection: "explicit", modelId: "gemini-fixture", reasoning: { mode: "native-default" }, selectionKind: "fixed", options: {} };
    const run = { ...s.source, id, purpose, status: "running", profile,
      frozen_invocation: { executable: process.execPath, accountScope: account, modelToken: "gemini-fixture", modelArgs: ["--model", "gemini-fixture"], effortArgs: [], effortEnv: {} },
      continuation: { kind: "runtime_resume", purpose: "execute", role: "executor", source_run_id: s.source.id } } as Run;
    s.store.put("run", id, workflow.id, run);
    try {
      return await runtime.invoke(workflow, run, { instructions: "fixture" }, {}, undefined,
        [{ id: "ws", workflow_id: workflow.id, ...s.context, root: s.root }]);
    } finally {
      // The fixture stops before process launch; mirror Engine's terminal Run update.
      s.store.put("run", id, workflow.id, { ...run, status: "stopped" });
    }
  };
  return { ...s, invoke, resume, start };
}

it("stopped AGY task switches A → B → A through ProfileRuntime and real adapter.resume without new native roots", async () => {
  const s = invocationFixture();
  s.store.put("feedback_message", "feedback-1", s.key.workflow_id, {
    workflow_id: s.key.workflow_id, seq: 1, text: "继续原工作，并回答浏览器测试是否完成", ack_run: s.source.id,
  });
  await expect(s.invoke("account-b", "resumed-b")).rejects.toThrow("fixture-before-process-start");
  expect(s.resume).toHaveBeenLastCalledWith(expect.objectContaining({ previousConversationId: "original-local-session" }));
  expect(s.start.mock.calls[0]?.[0]).toMatchObject({ args: expect.arrayContaining(["--conversation", "original-local-session"]) });
  expect(s.sessions.getBinding({ ...s.key, provider_account_scope: "account-b" })).toBeUndefined();
  expect(s.store.get<any>("cli_dispatch_record", `disp_${s.key.workflow_id}_resumed-b`))
    .toMatchObject({ binding_id: s.sessions.getBinding(s.key)!.id, expected_conversation_id: "original-local-session" });
  expect(readFileSync(join(s.config.storage_root, "native-runs", "resumed-b", "HANDOFF.json"), "utf8"))
    .toContain("继续原工作，并回答浏览器测试是否完成");
  s.sessions.bindConversationId(s.sessions.getBinding(s.key)!.id, "original-local-session", "resumed-b");
  await expect(s.invoke("account-a", "resumed-a")).rejects.toThrow("fixture-before-process-start");
  expect(s.resume).toHaveBeenLastCalledWith(expect.objectContaining({ previousConversationId: "original-local-session" }));
  expect(new Set(s.sessions.listBindings(s.key.workflow_id).map((x) => x.conversation_id)))
    .toEqual(new Set(["original-local-session"]));
});

it("A → B → A stays on latest root instead of reviving historical account forks", async () => {
  const s = invocationFixture();
  const b = s.sessions.getOrCreateBinding({ ...s.key, provider_account_scope: "account-b" }, s.context);
  s.sessions.bindConversationId(b.id, "existing-b-root", s.source.id);
  await expect(s.invoke("account-b", "existing-b")).rejects.toThrow("fixture-before-process-start");
  expect(s.resume).toHaveBeenLastCalledWith(expect.objectContaining({ previousConversationId: "existing-b-root" }));
  s.sessions.bindConversationId(b.id, "existing-b-root", "existing-b");
  await expect(s.invoke("account-a", "back-to-a")).rejects.toThrow("fixture-before-process-start");
  expect(s.resume).toHaveBeenLastCalledWith(expect.objectContaining({ previousConversationId: "existing-b-root" }));
  expect(s.sessions.getBinding(s.key)?.conversation_id).toBe("original-local-session");
});

it("explicit exact_resume selects source binding even when destination account has another root", async () => {
  const s = invocationFixture();
  const b = s.sessions.getOrCreateBinding({ ...s.key, provider_account_scope: "account-b" }, s.context);
  s.sessions.bindConversationId(b.id, "other-b-root", s.source.id);
  s.store.put("account_recovery_continuation", "exact-b", s.key.workflow_id,
    { decision: "exact_resume", original_conversation_id: "original-local-session" });
  await expect(s.invoke("account-b", "exact-b")).rejects.toThrow("fixture-before-process-start");
  expect(s.resume).toHaveBeenLastCalledWith(expect.objectContaining({ previousConversationId: "original-local-session" }));
  expect(s.sessions.getBindingById(b.id)?.conversation_id).toBe("other-b-root");
});

it("aside remains isolated and frozen identity mismatch still blocks before resume", async () => {
  const s = invocationFixture();
  await expect(s.invoke("account-b", "aside-b", "aside")).rejects.toThrow("fixture-before-process-start");
  expect(s.resume).not.toHaveBeenCalled();
  expect(s.start.mock.calls[0]?.[0]).toMatchObject({ args: expect.not.arrayContaining(["--conversation"]) });
  await expect(s.invoke("account-b", "mismatch", "implement", "other-account"))
    .rejects.toMatchObject({ code: "SESSION_IDENTITY_CHANGED" });
  expect(s.resume).not.toHaveBeenCalled();
});

it.each(["workflow_id", "adapter_id", "host_id", "client_scope_id", "canonical_model_id", "workspace_identity"] as const)(
  "cross-account fallback keeps %s isolation", (dimension) => {
    const s = fixture();
    expect(agySessionAcrossAccounts(s.store, { ...s.key, provider_account_scope: "account-b", [dimension]: "different" })).toBeUndefined();
  },
);
it.each(["reserved", "needs_reconcile", "unavailable", "retired"] as const)("does not revive %s bindings", (state) => {
  const s = fixture();
  const a = s.sessions.getBinding(s.key)!;
  s.sessions.updateBindingState(a.id, a.revision, state);
  expect(agySessionAcrossAccounts(s.store, { ...s.key, provider_account_scope: "account-b" })).toBeUndefined();
});
it("selects latest confirmed compatible root and rejects conflicting ownership", () => {
  const s = fixture();
  const c = s.sessions.getOrCreateBinding({ ...s.key, provider_account_scope: "account-c" }, s.context);
  s.sessions.bindConversationId(c.id, "latest-root", s.source.id);
  const key = { ...s.key, provider_account_scope: "account-b" };
  expect(agySessionAcrossAccounts(s.store, key)?.conversation_id).toBe("latest-root");
  s.store.put("session_owner_index", computeSessionOwnerKey({ ...key, conversation_id: "latest-root" }), "other-workflow",
    { workflow_id: "other-workflow" });
  expect(() => agySessionAcrossAccounts(s.store, key)).toThrowError(expect.objectContaining({ code: "SESSION_ALREADY_OWNED" }));
});

it("timestamp ties select the same confirmed root independently of active account", () => {
  const s = fixture();
  const b = s.sessions.getOrCreateBinding({ ...s.key, provider_account_scope: "account-b" }, s.context);
  s.sessions.bindConversationId(b.id, "second-root", s.source.id);
  for (const binding of s.sessions.listBindings(s.key.workflow_id)) {
    s.store.put("session_binding", computeSessionBindingKey(binding), s.key.workflow_id,
      { ...binding, updated_at: "2026-09-29T01:00:00Z", created_at: "2026-09-29T01:00:00Z" });
  }
  const chosen = agySessionAcrossAccounts(s.store, s.key)?.id;
  expect(chosen).toBeDefined();
  expect(agySessionAcrossAccounts(s.store, { ...s.key, provider_account_scope: "account-b" })?.id).toBe(chosen);
});

it("a binding polluted by an aside run is not a cross-account main session candidate", () => {
  const s = fixture();
  s.store.put("run", s.source.id, s.source.workflow_id, { ...s.source, purpose: "aside" });
  expect(agySessionAcrossAccounts(s.store, { ...s.key, provider_account_scope: "account-b" })).toBeUndefined();
});
