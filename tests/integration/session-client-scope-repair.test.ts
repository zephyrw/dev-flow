import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { hostname } from "node:os";
import { setup } from "../helpers.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { SessionBindingRepairService } from "../../packages/core/src/session-binding-repair.js";
import { computeSessionBindingKey, computeSessionOwnerKey, type SessionBindingKey } from "../../packages/contracts/src/session-binding.js";
import { runtimeFailureResolution } from "../../packages/contracts/src/runtime-failure.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

let s: ReturnType<typeof setup>;
let sessions: ExecutionSessionStore;
let repair: SessionBindingRepairService;
let key: SessionBindingKey;
let oldKey: SessionBindingKey;
let bindingId: string;
let platform: PropertyDescriptor;
let originalStat: typeof statSync;

beforeEach(async () => {
  platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  originalStat = fs.statSync;
  vi.mocked(statSync).mockImplementation(originalStat);
  s = setup();
  sessions = new ExecutionSessionStore(s.store);
  repair = new SessionBindingRepairService(s.store);
  const home = join(s.root, "Original-Codex-Home");
  mkdirSync(home);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ account_id: "scope-account" }));
  vi.stubEnv("CODEX_HOME", home);
  vi.stubEnv("DEVFLOW_HOST_ID", hostname().trim().toLowerCase());
  key = { workflow_id: "wf", adapter_id: "codex", host_id: process.env.DEVFLOW_HOST_ID!,
    client_scope_id: normalize(resolve(home)), provider_account_scope: "scope-account",
    canonical_model_id: "gpt-6.1-sol", workspace_identity: normalize(resolve(s.root)).toLowerCase() };
  oldKey = { ...key, client_scope_id: key.client_scope_id.toLowerCase() };
  s.store.put("workflow", "wf", "p", { id: "wf", project_id: "p", version: 1 });
  s.store.put("workspace", "ws", "wf", { id: "ws", workflow_id: "wf", repo_id: "main", root: s.root, source_root: s.root });
  s.store.put("workflow_dispatch_control", "wf", "wf", { workflow_id: "wf", dispatch_enabled: false, revision: 1, writer_state: "idle" });
  const initial = sessions.getOrCreateBinding(oldKey, { workspace_root: s.root, source_root: s.root, repo_id: "main" });
  const bound = sessions.bindConversationId(initial.id, "original-native-thread", "original-run", "native-project");
  bindingId = bound.id;
  s.store.put("session_binding", computeSessionBindingKey(oldKey), "wf", { ...bound, metadata: { history: "original-history" } });
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  // Model the old lower-case alias with the same real directory inode. This
  // exercises POSIX normalization on Windows as well, without changing user paths.
  vi.mocked(statSync).mockImplementation(((path: Parameters<typeof statSync>[0], options: Parameters<typeof statSync>[1]) =>
    originalStat(path === oldKey.client_scope_id ? home : path, options as never)) as typeof statSync);
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.mocked(statSync).mockReset();
  vi.unstubAllEnvs();
  s.store.close();
});

function selectedRepair(requestId = "repair") {
  const preview = repair.previewRepair("wf");
  const candidate = preview.candidates.find(c => c.candidate_id === `cand:binding:${bindingId}`)!;
  return { preview, candidate, input: { request_id: requestId, expected_workflow_version: 1,
    source_digest: preview.source_digest,
    selections: [{ candidate_id: candidate.candidate_id, expected_binding_revision: candidate.expected_binding_revision }] } };
}

it("requires explicit repair and preserves native identity, history, indexes and rollback versions", () => {
  expect(() => sessions.findReusableBinding(key)).toThrow(/禁止自动新建替代根/);
  expect(() => sessions.getOrCreateBinding(key, { workspace_root: s.root, source_root: s.root, repo_id: "main" })).toThrow(/禁止自动新建替代根/);
  expect(sessions.listBindings("wf")).toHaveLength(1);
  expect(runtimeFailureResolution("SESSION_BINDING_REPAIR_REQUIRED")?.steps.join(" ")).toContain("会话修复");
  const before = sessions.getBindingById(bindingId)!;
  const { candidate, input } = selectedRepair();
  expect(candidate.status).toBe("verified");
  expect(candidate.client_scope_id).toBe(key.client_scope_id);
  expect(candidate.reason).toContain(`${oldKey.client_scope_id} → ${key.client_scope_id}`);
  const result = repair.applyRepair("wf", input);
  const after = sessions.getBindingById(bindingId)!;
  expect(after).toMatchObject({ id: bindingId, conversation_id: "original-native-thread", native_project_id: "native-project",
    first_run_id: "original-run", latest_run_id: "original-run", metadata: before.metadata, client_scope_id: key.client_scope_id,
    revision: before.revision + 1, generation: before.generation + 1 });
  expect(sessions.getBinding(oldKey)).toBeUndefined();
  expect(sessions.findReusableBinding(key)?.id).toBe(bindingId);
  expect(s.store.get("session_owner_index", computeSessionOwnerKey({ ...oldKey, conversation_id: "original-native-thread" }))).toMatchObject({ binding_id: bindingId, workflow_id: "wf" });
  expect(s.store.get("session_owner_index", computeSessionOwnerKey({ ...key, conversation_id: "original-native-thread" }))).toMatchObject({ binding_id: bindingId, workflow_id: "wf" });
  expect(repair.applyRepair("wf", input).replayed).toBe(true);
  repair.rollbackRepair("wf", { request_id: "rollback", migration_id: result.migration_id, expected_workflow_version: 1,
    expected_binding_revisions: [{ binding_id: bindingId, revision: after.revision }] });
  const restored = sessions.getBindingById(bindingId)!;
  expect(restored).toMatchObject({ conversation_id: "original-native-thread", metadata: before.metadata,
    client_scope_id: oldKey.client_scope_id, revision: after.revision + 1, generation: after.generation + 1 });
  expect(sessions.getBinding(key)).toBeUndefined();
  expect(sessions.listBindings("wf")).toHaveLength(1);
  expect(s.store.get("session_owner_index", computeSessionOwnerKey({ ...oldKey, conversation_id: "original-native-thread" }))).toMatchObject({ binding_id: bindingId, workflow_id: "wf" });
  expect(s.store.get("session_owner_index", computeSessionOwnerKey({ ...key, conversation_id: "original-native-thread" }))).toBeUndefined();
});

function adoptForeign(scope: string) {
  s.store.put("workflow", "foreign", "p", { id: "foreign", project_id: "p", version: 1 });
  s.store.put("workspace", "foreign-ws", "foreign", { id: "foreign-ws", workflow_id: "foreign", root: s.root, source_root: s.root, repo_id: "main" });
  s.store.put("workflow_dispatch_control", "foreign", "foreign", { workflow_id: "foreign", revision: 1, dispatch_enabled: false, writer_state: "idle" });
  return sessions.adoptExistingSession("foreign", {
    request_id: `adopt-${scope}`, expected_workflow_version: 1, expected_control_revision: 1,
    expected_binding_revision: 0, profile_ref: { id: "p", revision: 1 },
    workspace_id: "foreign-ws", conversation_id: "original-native-thread",
  }, { ...key, client_scope_id: scope, workspace_root: s.root, source_root: s.root, repo_id: "main",
    expected_workflow_version: 1, expected_control_revision: 1 });
}

it.each(["before", "after"] as const)("rejects cross-task adopt and init through both aliases %s confirmed repair", phase => {
  if (phase === "after") repair.applyRepair("wf", selectedRepair().input);
  for (const scope of [key.client_scope_id, oldKey.client_scope_id]) {
    expect(() => adoptForeign(scope)).toThrow(/原生会话已由其他任务认领/);
    expect(sessions.listBindings("foreign")).toHaveLength(scope === key.client_scope_id ? 0 : 1);
    const foreign = sessions.getOrCreateBinding({ ...key, workflow_id: "foreign", client_scope_id: scope },
      { workspace_root: s.root, source_root: s.root, repo_id: "main" });
    expect(() => sessions.bindConversationId(foreign.id, "original-native-thread", "foreign-run")).toThrow(/原生会话已由其他任务认领/);
    expect(sessions.getBindingById(foreign.id)).toMatchObject({ state: "reserved", conversation_id: "" });
  }
  expect(sessions.getBindingById(bindingId)?.conversation_id).toBe("original-native-thread");
});

it("keeps unknown alias ownership closed and exposes only a fixed repair instruction", () => {
  vi.mocked(statSync).mockImplementation(((path: Parameters<typeof statSync>[0], options: Parameters<typeof statSync>[1]) => {
    if (path === oldKey.client_scope_id) throw new Error("secret raw filesystem diagnostic");
    return originalStat(path, options as never);
  }) as typeof statSync);
  expect(() => adoptForeign(key.client_scope_id)).toThrow(/请核对原目录并通过会话修复/);
  expect(sessions.listBindings("foreign")).toHaveLength(0);
});

it("allows independent real POSIX directories with different inodes despite case-related names", () => {
  const other = join(s.root, "Other-Physical-Home"); mkdirSync(other);
  vi.mocked(statSync).mockImplementation(((path: Parameters<typeof statSync>[0], options: Parameters<typeof statSync>[1]) =>
    originalStat(path === oldKey.client_scope_id ? other : path, options as never)) as typeof statSync);
  expect(adoptForeign(key.client_scope_id)).toMatchObject({ workflow_id: "foreign", conversation_id: "original-native-thread" });
  expect(sessions.getBindingById(bindingId)?.workflow_id).toBe("wf");
});

it.each(["different-directory", "missing-directory", "account", "host", "workspace", "owner"] as const)("refuses an unproved %s identity without creating a replacement", reason => {
  if (reason === "different-directory") {
    const other = join(s.root, "Other-Physical-Home"); mkdirSync(other);
    vi.mocked(statSync).mockImplementation(((path: Parameters<typeof statSync>[0], options: Parameters<typeof statSync>[1]) =>
      originalStat(path === oldKey.client_scope_id ? other : path, options as never)) as typeof statSync);
  } else if (reason === "missing-directory") {
    vi.mocked(statSync).mockImplementation(((path: Parameters<typeof statSync>[0], options: Parameters<typeof statSync>[1]) => {
      if (path === oldKey.client_scope_id) throw new Error("missing original directory");
      return originalStat(path, options as never);
    }) as typeof statSync);
  } else if (reason === "account") {
    writeFileSync(join(key.client_scope_id, "auth.json"), JSON.stringify({ account_id: "different-account" }));
  } else if (reason === "host") vi.stubEnv("DEVFLOW_HOST_ID", "other-host");
  else if (reason === "workspace") s.store.put("workspace", "ws", "wf", { id: "ws", root: join(s.root, "other-workspace"), source_root: s.root });
  else s.store.put("session_owner_index", computeSessionOwnerKey({ ...key, conversation_id: "original-native-thread" }), "other", { workflow_id: "other", binding_id: "foreign" });
  const { candidate, input } = selectedRepair();
  expect(candidate.status).toBe(reason === "owner" ? "conflict" : "unverifiable");
  expect(() => repair.applyRepair("wf", input)).toThrow(/不可应用/);
  expect(sessions.getBindingById(bindingId)?.conversation_id).toBe("original-native-thread");
  expect(sessions.listBindings("wf")).toHaveLength(1);
  expect(() => sessions.findReusableBinding(key)).toThrow(/禁止自动新建替代根/);
});

it("rechecks physical identity and account after preview before applying", () => {
  const { input } = selectedRepair();
  writeFileSync(join(key.client_scope_id, "auth.json"), JSON.stringify({ account_id: "changed-after-preview" }));
  expect(() => repair.applyRepair("wf", input)).toThrow(/修复候选列表已发生变化/);
  expect(sessions.getBindingById(bindingId)?.client_scope_id).toBe(oldKey.client_scope_id);
  expect(readFileSync(join(key.client_scope_id, "auth.json"), "utf8")).toContain("changed-after-preview");
});

it("requires a fresh preview if registered and recorded source context changes together", () => {
  const { input } = selectedRepair();
  const source = join(s.root, "changed-source-root"); mkdirSync(source);
  const original = sessions.getBindingById(bindingId)!;
  s.store.put("workspace", "ws", "wf", { id: "ws", workflow_id: "wf", repo_id: "main", root: s.root, source_root: source });
  s.store.put("session_binding", computeSessionBindingKey(oldKey), "wf", { ...original, source_root: source });
  expect(selectedRepair().candidate.status).toBe("verified");
  expect(() => repair.applyRepair("wf", input)).toThrow(/修复候选列表已发生变化/);
  expect(sessions.getBindingById(bindingId)).toMatchObject({ source_root: source, client_scope_id: oldKey.client_scope_id });
});

it("repairs a missing historical owner index without losing its alias protection", () => {
  const oldOwner = computeSessionOwnerKey({ ...oldKey, conversation_id: "original-native-thread" });
  s.store.remove("session_owner_index", oldOwner);
  repair.applyRepair("wf", selectedRepair().input);
  expect(s.store.get("session_owner_index", oldOwner)).toMatchObject({ workflow_id: "wf", binding_id: bindingId });
  expect(() => adoptForeign(oldKey.client_scope_id)).toThrow(/原生会话已由其他任务认领/);
});

it("does not overwrite a target binding or foreign owner appearing after explicit repair", () => {
  const { input } = selectedRepair();
  const result = repair.applyRepair("wf", input);
  const after = sessions.getBindingById(bindingId)!;
  const ownerKey = computeSessionOwnerKey({ ...key, conversation_id: "original-native-thread" });
  s.store.put("session_owner_index", ownerKey, "other", { workflow_id: "other", binding_id: "foreign" });
  expect(() => repair.rollbackRepair("wf", { request_id: "rollback-owner-conflict", migration_id: result.migration_id,
    expected_workflow_version: 1, expected_binding_revisions: [{ binding_id: bindingId, revision: after.revision }] })).toThrow(/禁止回滚覆盖/);
  expect(sessions.getBindingById(bindingId)).toEqual(after);
  expect(sessions.getBinding(oldKey)).toBeUndefined();
  expect(s.store.get("session_owner_index", ownerKey)).toMatchObject({ workflow_id: "other", binding_id: "foreign" });
});

it("refuses a conflicting target key and keeps the original binding", () => {
  const original = sessions.getBindingById(bindingId)!;
  s.store.put("session_binding", computeSessionBindingKey(key), "wf", { ...original, id: "other-binding", client_scope_id: key.client_scope_id });
  const { candidate, input } = selectedRepair();
  expect(candidate.status).toBe("conflict");
  expect(() => repair.applyRepair("wf", input)).toThrow(/不可应用/);
  expect(sessions.getBindingById(bindingId)).toEqual(original);
  expect(sessions.getBinding(key)?.id).toBe("other-binding");
});
