import { afterEach, expect, it, vi } from "vitest";
import { setup, prepared } from "../helpers.js";
import { FlowError, inheritRoleOverrides, type FrozenInvocation, type Run, type ToolProfile, type Workflow } from "../../packages/contracts/src/index.js";
import { now } from "../../packages/core/src/util.js";
import { beginRunConversation, retainRunConversation, conversationLineageKey } from "../../packages/core/src/conversation-lineage.js";
import { bindProfile, buildDispatchContext, frozenInvocationFromProfile, invocationFingerprintFromFrozen, workflowWorkspaceIdentity } from "../../packages/core/src/run-profile.js";
import { AgyNativeAdapter } from "../../packages/adapters/agy/src/native-adapter.js";
import type { ProcessManager } from "../../packages/process/src/manager.js";

const stores: Array<ReturnType<typeof setup>["store"]> = [];
afterEach(() => { vi.restoreAllMocks(); for (const store of stores.splice(0)) store.close(); });
function profile(adapterId: ToolProfile["adapterId"], modelId: string): ToolProfile {
  return { id: "profile-" + modelId, revision: 1, adapterId,
    executableRef: process.execPath, modelSelection: "explicit", modelId,
    reasoning: { mode: "native-default" }, selectionKind: "fixed", options: {} };
}
function run(id: string, selected: ToolProfile): Run {
  const frozen = frozenInvocationFromProfile(selected, "profile-native");
  return { id, workflow_id: "wf-lineage", plan_revision: 1, adapter: selected.adapterId,
    profile: selected, frozen_invocation: frozen,
    invocation_fingerprint: invocationFingerprintFromFrozen(frozen, "workspace", "write"),
    purpose: "implement", stage: "execute", status: "running", started_at: now(), package_hash: "pkg" };
}

it("跨 ProfileRuntime 与 agy 的 A-B-A 在 B 尚未产生会话时也不能复活旧 A", () => {
  const s = setup(); stores.push(s.store);
  const a = run("run-a", profile("cursor-agent", "model-a"));
  const b = run("run-b", profile("agy", "model-b"));
  beginRunConversation(s.store, a);
  retainRunConversation(s.store, a, "conversation-a");
  const start = vi.fn().mockReturnValue({});
  const adapter = new AgyNativeAdapter({ start } as unknown as ProcessManager, s.config, s.store);
  adapter.startSession({ workflow: { id: a.workflow_id } as Workflow, run: b,
    directory: s.root, token: "test-token", conversationId: "conversation-a",
    projectBindingId: "p1", prompt: "test", remainingMs: 1000 });
  expect(start.mock.calls[0]?.[0].args).not.toContain("conversation-a");
  expect(s.store.get<any>("native_conversation", conversationLineageKey(a.workflow_id, "execution")))
    .toMatchObject({ run_id: b.id, fingerprint: b.invocation_fingerprint });
  retainRunConversation(s.store, a, "late-a");
  expect(s.store.get<any>("conversation", a.workflow_id)?.id).toBeUndefined();
  expect(beginRunConversation(s.store, run("run-a2", a.profile!))).toBeUndefined();
});

it("两个 agy 入口沿用最近兼容会话，并同时更新共享记录", () => {
  const s = setup(); stores.push(s.store);
  const first = run("run-agy-1", profile("agy", "same-model"));
  beginRunConversation(s.store, first); retainRunConversation(s.store, first, "agy-current");
  const next = run("run-agy-2", first.profile!);
  const start = vi.fn().mockReturnValue({});
  const adapter = new AgyNativeAdapter({ start } as unknown as ProcessManager, s.config, s.store);
  adapter.startSession({ workflow: { id: first.workflow_id } as Workflow, run: next,
    directory: s.root, token: "test-token", projectBindingId: "p1", prompt: "test", remainingMs: 1000 });
  expect(start.mock.calls[0]?.[0].args).toContain("agy-current");
  expect(s.store.get<any>("conversation", first.workflow_id)).toMatchObject({ id: "agy-current", run_id: next.id });
});

it("冻结指纹区分账号、提供方、真实默认参数、可执行路径及工作区", () => {
  const original = frozenInvocationFromProfile(profile("agy", "model-a"), "profile-native");
  const fingerprint = (value: FrozenInvocation, root = "root-a") => invocationFingerprintFromFrozen(value, root, "write");
  for (const change of [
    { accountScope: "account-b" }, { providerScope: "provider-b" },
    { executable: "other-client" }, { modelToken: "resolved-native-default" },
    { effortArgs: ["--effort", "high"] }, { effortEnv: { EFFORT: "high" } },
  ]) expect(fingerprint({ ...original, ...change })).not.toBe(fingerprint(original));
  expect(fingerprint(original, "root-b")).not.toBe(fingerprint(original));
  expect(fingerprint({ ...original, capabilityRevision: "refreshed", catalogEntryId: "renamed" }))
    .toBe(fingerprint(original));
  const s = setup(); stores.push(s.store);
  s.store.put("workspace", "ws", "wf", { repo_id: "main", root: "root-a" });
  const before = workflowWorkspaceIdentity(s.store, "wf");
  s.store.put("workspace", "ws", "wf", { repo_id: "main", root: "root-b" });
  expect(workflowWorkspaceIdentity(s.store, "wf")).not.toEqual(before);
});

it("普通执行故障自动恢复固定到失败轮次，不读取执行中更新的模型", async () => {
  const s = await prepared(); stores.push(s.store);
  const oldProfile = profile("agy", "old-model");
  const saveSpec = (revision: number, selected: ToolProfile) => s.store.put("execution_spec", "retry-spec-" + revision, s.workflow.id, {
    schema_version: 2, id: "retry-spec-" + revision, workflow_id: s.workflow.id, revision,
    plannerProfile: profile("codex", "planner-model"), executorProfile: selected,
    roleOverrides: inheritRoleOverrides(), template_id: "native-development", template_revision: 3,
    mode: "composite", created_at: now(),
  });
  saveSpec(1, oldProfile);
  s.engine.transition(s.workflow.id, ["EXECUTING"], "QUEUED", "execute");
  vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  s.engine.runtime = {
    execute: async () => {
      saveSpec(2, profile("agy", "new-model"));
      throw new FlowError("NATIVE_RUN_FAILED", "fixture execution failed");
    }, stop: async () => {}, review: async () => ({}),
    check: async () => { throw new Error("unused"); }, close: async () => {},
  };
  await (s.engine as unknown as { run(key: string, id: string, review: boolean, leases: string[]): Promise<void> })
    .run(s.workflow.id, "failed-model-run", false, []);
  expect(s.engine.get(s.workflow.id).state).toBe("QUEUED");
  expect(s.store.get<any>("pending_model_retry", s.workflow.id)?.retry_run_id).toBe("failed-model-run");
  const failed = s.store.must<Run>("run", "failed-model-run");
  const retry = bindProfile(s.store, s.config, s.workflow.id, "implement", buildDispatchContext(s.store, s.workflow.id, "implement"));
  expect(retry.profile.modelId).toBe("old-model");
  expect(retry.frozen_invocation).toEqual(failed.frozen_invocation);
  expect(retry.logical_round_id).toBe(failed.logical_round_id);
});


it.each(["MODEL_AUTH", "MODEL_LOGIN_REQUIRED", "MODEL_FORBIDDEN", "MODEL_CONNECTION_FAILED", "MODEL_QUOTA", "UNAUTHORIZED"])(
  "真实运行 %s 仅在明确模型授权失效时清理冻结身份对应缓存", (code) => {
    const s = setup(); stores.push(s.store);
    const selected = profile("agy", "model-a");
    const active = run("run-auth", selected);
    active.frozen_invocation = { ...active.frozen_invocation!, accountScope: "account-a", providerScope: "provider-a" };
    s.store.put("run", active.id, active.workflow_id, active);
    s.store.put("workflow", active.workflow_id, "p1", {
      id: active.workflow_id, project_id: "p1", title: "授权", request: "授权", complexity: "simple",
      workspace_mode: "existing_workspace", state: "EXECUTING", stage: "execute", version: 1,
      plan_revision: 1, environment_revision: 0, run_id: active.id, created_at: now(), updated_at: now(), feedback: [],
    } satisfies Workflow);
    const records = [
      { key: "same-model", accountScope: "account-a", providerScope: "provider-a", accessModelKey: "model-a" },
      { key: "other-model", accountScope: "account-a", providerScope: "provider-a", accessModelKey: "model-b" },
      { key: "other-account", accountScope: "account-b", providerScope: "provider-a", accessModelKey: "model-a" },
      { key: "other-provider", accountScope: "account-a", providerScope: "provider-b", accessModelKey: "model-a" },
    ];
    for (const record of records) s.store.put("model_access", record.key, "agy", {
      ...record, status: "verified", checked_at: now(), adapterId: "agy", cliFingerprint: "fixture-cli",
      verification_method: "fixture", identityConfidence: "credential", last_success_at: now(),
    });
    s.engine.block(active.workflow_id, new FlowError(code, "fixture cause"));
    const login = code === "MODEL_AUTH" || code === "MODEL_LOGIN_REQUIRED";
    expect(s.store.get<any>("model_access", "same-model")?.status)
      .toBe(login ? "login_required" : code === "MODEL_FORBIDDEN" ? "model_forbidden" : "verified");
    expect(s.store.get<any>("model_access", "other-model")?.status).toBe(login ? "login_required" : "verified");
    expect(s.store.get<any>("model_access", "other-account")?.status).toBe("verified");
    expect(s.store.get<any>("model_access", "other-provider")?.status).toBe("verified");
  },
);
