import { afterEach, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { setup, project, plan, repository } from "../helpers.js";
import type { Run } from "../../packages/contracts/src/index.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import { readWaitingContext } from "../../packages/core/src/waiting-context.js";
import { NATIVE_PERMISSION_ENTITY, NATIVE_TOOL_PERMISSION_ENTITY, pauseForNativePermission, bindNativePermission, consumeNativePermission, hasNativeMcpToolPermission } from "../../packages/core/src/native-permission.js";
import { Store } from "../../packages/store/src/store.js";
import { nativePermissionPlugin } from "../../apps/api/src/routes/native-permissions.js";
import { userInteractionPlugin } from "../../apps/api/src/routes/user-interactions.js";
import { installAgyPermissionHook } from "../../packages/adapters/agy/src/permission-hook.js";
import { recoverNativePermission } from "../../packages/runtime/src/native-permission-recovery.js";

const call = { name: "run_command", parameters: { CommandLine: "echo permission-fixture" } };
const mcp = { name: "call_mcp_tool", parameters: { ServerName: "opentabs", ToolName: "browser_emulate_device", Arguments: { tabId: 123, width: 390, height: 844, mobile: true } } };
const session = "11111111-1111-4111-8111-111111111111";
const disposals: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

function isolated() {
  const s = setup();
  disposals.push(() => s.store.close());
  const p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({ project_id: p.id, title: "授权测试", request: "测试具体工具授权", complexity: "simple", workspace_mode: "existing_workspace" }, "permission-fixture");
  const workflow = s.engine.transition(created.id, [created.state], "EXECUTING", "execute", {
    run_id: "run-permission-source", plan_revision: 1, plan_hash: "permission-plan",
  });
  s.store.put("plan", `${workflow.id}-1`, workflow.id, { id: `${workflow.id}-1`, revision: 1, plan: { ...plan("a".repeat(64), "0".repeat(40)), task_model: "native-v2" } });
  s.store.put("workspace", `${workflow.id}-main`, workflow.id, { id: `${workflow.id}-main`, repo_id: "main", root: s.root, source_root: s.root });
  return { ...s, workflow, principal: { run_id: workflow.run_id! } };
}

async function fixture(operation = call) {
  const s = isolated();
  const run: Run = {
    id: s.principal.run_id, workflow_id: s.workflow.id, adapter: "agy", stage: "execute", purpose: "implement",
    plan_revision: s.workflow.plan_revision, status: "running", started_at: new Date().toISOString(), package_hash: "native-permission",
    conversation_id: session,
    profile: { id: "executor", adapterId: "agy", revision: 1, modelSelection: "explicit", modelId: "fixture-only", options: {} },
  };
  s.store.put("run", run.id, s.workflow.id, run);
  const rootId = "cnv-permission";
  s.store.put("conversation_node", rootId, s.workflow.id, {
    id: rootId, root_id: rootId, workflow_id: s.workflow.id, native_session_id: session, current_attempt_id: "cva-permission",
  });
  s.store.put("conversation_attempt", "cva-permission", s.workflow.id, {
    id: "cva-permission", conversation_id: rootId, root_id: rootId, workflow_id: s.workflow.id, run_id: run.id, generation: 1,
  });
  const interaction = pauseForNativePermission(s.engine, run, [operation], "denied")!;
  const app = Fastify();
  disposals.push(() => app.close());
  const human = () => {};
  await app.register(nativePermissionPlugin, { engine: s.engine, human });
  await app.register(userInteractionPlugin, { engine: s.engine, interactionService: new UserInteractionService(s.store), human });
  return { ...s, run, interaction, app };
}

async function answer(s: Awaited<ReturnType<typeof fixture>>, choice_id = "allow_once", request_id = "permission-answer") {
  return new UserInteractionService(s.store).respondInteraction(s.workflow.id, s.interaction.id,
    { source_run_id: s.run.id, action: "answer", choice_id, request_id }, s.engine);
}

function resume(s: Awaited<ReturnType<typeof fixture>>) {
  const continuation = s.store.must<NonNullable<Run["continuation"]>>("run_continuation", s.workflow.id);
  const run: Run = { ...s.run, id: "run-permission-resume", continuation, status: "running" };
  s.engine.transition(s.workflow.id, ["QUEUED"], "EXECUTING", "execute", { run_id: run.id });
  s.store.put("run", run.id, s.workflow.id, run);
  return run;
}

it("exposes the exact operation to the UI, waits without dispatch, and answers through the production HTTP route", async () => {
  const s = await fixture();
  const current = await s.app.inject({ method: "GET", url: `/api/workflows/${s.workflow.id}/user-interactions/current` });
  expect(current.json().interaction.request).toMatchObject({ kind: "question", allow_free_text: false, action_label: "提交授权决定" });
  expect(current.json().interaction.request.message).toContain("echo permission-fixture");
  expect(readWaitingContext(s.store, s.workflow.id)).toMatchObject({ run_id: s.run.id, conversation_id: session });
  expect(s.store.list("delivery", s.workflow.id)).toEqual([]);
  const payload = { request_id: "permission-http", source_run_id: s.run.id, source_plan_revision: s.run.plan_revision, action: "answer", choice_id: "allow_once" };
  const url = `/api/workflows/${s.workflow.id}/user-interactions/${s.interaction.id}/respond`;
  expect((await s.app.inject({ method: "POST", url, payload })).statusCode).toBe(200);
  expect((await s.app.inject({ method: "POST", url, payload })).statusCode).toBe(200);
  expect(s.engine.get(s.workflow.id).state).toBe("QUEUED");
  expect(s.store.list("user_interaction_receipt", s.workflow.id)).toHaveLength(1);
  expect(s.store.get("run_continuation", s.workflow.id)).toMatchObject({ source_run_id: s.run.id, conversation_id: session });
});

it("lets the same session execute only the exact approved call once through the authenticated hook route", async () => {
  const s = await fixture();
  await answer(s);
  const run = resume(s);
  expect(bindNativePermission(s.store, run)?.bound_run_id).toBe(run.id);
  const token = s.engine.auth.issue({ role: "worker", workflow_id: s.workflow.id, run_id: run.id });
  const request = (parameters = call.parameters, conversationId = session) => s.app.inject({
    method: "POST", url: "/api/worker/native-permission", headers: { authorization: `Bearer ${token}` },
    payload: { conversationId, toolCall: { name: call.name, args: parameters } },
  });
  expect((await request(call.parameters, "another-session")).json().decision).toBe("ask");
  expect((await request({ ...call.parameters, CommandLine: "echo different" })).json().decision).toBe("ask");
  expect((await request()).json().decision).toBe("allow");
  expect((await request()).json().decision).toBe("ask");
  s.engine.auth.revokeRun(run.id);
  expect((await request()).statusCode).not.toBe(200);
});

it("denial resumes the original model with an explicit denial and creates no usable grant", async () => {
  const s = await fixture();
  await answer(s, "deny");
  expect(s.store.get<any>("run_continuation", s.workflow.id).answer).toContain("用户拒绝");
  expect(bindNativePermission(s.store, resume(s))).toBeUndefined();
  expect(s.store.get<any>(NATIVE_PERMISSION_ENTITY, s.interaction.id).decision).toBe("deny");
});

it("permanently approves MCP across parameters, servers, tasks, sessions, accounts and store reopen", async () => {
  const s = await fixture(mcp as any);
  expect(s.interaction.request.choices?.[0]).toEqual({ id: "allow_tool", label: "永久授权此工具" });
  await answer(s, "allow_tool");
  expect(hasNativeMcpToolPermission(s.store)).toBe(true);
  expect(s.store.list(NATIVE_TOOL_PERMISSION_ENTITY)).toHaveLength(1);
  expect(s.store.must<any>("run_continuation", s.workflow.id).answer).toContain("任意参数均已授权");
  const run = resume(s);
  const allowed = (args: Record<string, unknown>) => consumeNativePermission(s.engine, run, session, { name: mcp.name, parameters: args });
  expect(allowed(mcp.parameters)).toBe(true);
  expect(allowed({ ServerName: "other-server", ToolName: "other-tool", Arguments: { any: 2 } })).toBe(true);
  expect(allowed({})).toBe(true);
  expect(allowed({})).toBe(true);
  expect(consumeNativePermission(s.engine, run, session, call)).toBe(false);
  expect(consumeNativePermission(s.engine, run, "other-session", mcp)).toBe(false);
  expect(consumeNativePermission(s.engine, { ...run, deadline_at: Date.now() - 1 }, session, mcp)).toBe(false);
  s.store.put("run_stop", run.id, s.workflow.id, {});
  expect(allowed({})).toBe(false);
  s.store.remove("run_stop", run.id);
  const newWorkflow = s.engine.create({ project_id: s.workflow.project_id, title: "后续任务", request: "new task", complexity: "simple", workspace_mode: "existing_workspace" }, "new-mcp-task");
  s.engine.transition(newWorkflow.id, [newWorkflow.state], "EXECUTING", "execute", { run_id: "run-new-task" });
  const newRun: Run = { ...run, id: "run-new-task", workflow_id: newWorkflow.id, conversation_id: "new-native-session", continuation: undefined,
    profile: { ...run.profile!, modelId: "different-model" }, frozen_invocation: { accountScope: "different-account" } as any };
  s.store.put("run", newRun.id, newWorkflow.id, newRun);
  expect(bindNativePermission(s.store, newRun)?.calls).toContainEqual({ name: "call_mcp_tool" });
  expect(consumeNativePermission(s.engine, newRun, newRun.conversation_id!, mcp)).toBe(true);
  const reopened = new Store(s.store.file);
  try { expect(hasNativeMcpToolPermission(reopened)).toBe(true); } finally { reopened.close(); }
});

it("human-only persistent grant uses the production route and never promotes prior once-only consent", async () => {
  const s = await fixture();
  await answer(s);
  expect(hasNativeMcpToolPermission(s.store)).toBe(false);
  const invalid = await s.app.inject({ method: "POST", url: "/api/native-tool-permissions", payload: { adapter: "agy", tool: "run_command", decision: "allow" } });
  expect(invalid.statusCode).not.toBe(200);
  const payload = { adapter: "agy", tool: "call_mcp_tool", decision: "allow" };
  expect((await s.app.inject({ method: "POST", url: "/api/native-tool-permissions", payload })).statusCode).toBe(200);
  expect((await s.app.inject({ method: "POST", url: "/api/native-tool-permissions", payload })).statusCode).toBe(200);
  expect(s.store.list(NATIVE_TOOL_PERMISSION_ENTITY)).toHaveLength(1);
});

it.each(["plan", "workspace", "session", "profile"])("rejects a stale %s before recording an approval", async changed => {
  const s = await fixture();
  if (changed === "plan") s.store.put("workflow", s.workflow.id, s.workflow.id, { ...s.engine.get(s.workflow.id), plan_hash: "changed" });
  if (changed === "workspace") {
    const workspace = s.store.list<any>("workspace", s.workflow.id)[0]!;
    s.store.put("workspace", workspace.id, s.workflow.id, { ...workspace, root: join(s.root, "changed") });
  }
  if (changed === "session") s.store.put("run", s.run.id, s.workflow.id, { ...s.run, conversation_id: "changed" });
  if (changed === "profile") s.store.put("run", s.run.id, s.workflow.id, { ...s.run, profile: { ...s.run.profile!, modelId: "changed" } });
  await expect(answer(s)).rejects.toMatchObject({ code: "INTERACTION_STALE" });
  expect(s.store.get<any>(NATIVE_PERMISSION_ENTITY, s.interaction.id).decision).toBeUndefined();
  expect(s.store.list("user_interaction_receipt", s.workflow.id)).toEqual([]);
});

it("cannot consume permission after expiry, stop, account changes, or a different continuation", async () => {
  const s = await fixture();
  await answer(s);
  const run = resume(s);
  bindNativePermission(s.store, run);
  const consume = (changed: Partial<Run>) => consumeNativePermission(s.engine, { ...run, ...changed }, session, call);
  expect(consume({ deadline_at: Date.now() - 1 })).toBe(false);
  expect(consume({ continuation: { ...run.continuation!, source_run_id: "other-run" } })).toBe(false);
  expect(consume({ frozen_invocation: { accountScope: "other-account" } as any })).toBe(false);
  s.store.put("run_stop", run.id, s.workflow.id, {});
  expect(consume({})).toBe(false);
  s.store.remove("run_stop", run.id);
  expect(consume({})).toBe(true);
});

it.each(["footer", "immediate", "redacted-footer", "historical-footer", "historical-error-footer"])("attributes spawned CLI permission results to the current turn: %s", async mode => {
  const immediate = mode === "immediate";
  const historical = mode.startsWith("historical-");
  const s = isolated();
  const repo = await repository(s.root);
  const p = s.engine.project(s.workflow.project_id);
  p.repositories[0]!.path = repo.repo;
  s.store.put("project", p.id, p.id, p);
  s.store.put("workspace", `${s.workflow.id}-main`, s.workflow.id, { id: `${s.workflow.id}-main`, repo_id: "main", root: repo.repo, source_root: repo.repo });
  const cli = join(s.root, "permission-cli.mjs");
  const events = [
    { event: "init", conversation_id: session },
    ...(mode === "redacted-footer" ? [{ type: "login", status: "completed" }] : []),
    ...(immediate || historical ? [{ event: "step_update", step_update: { conversation_id: session, step_type: "user_input", state: "DONE", step_index: 0 } }] : []),
    { event: "step_update", step_update: { conversation_id: session, step_type: "tool", state: historical ? "DONE" : "ERROR", step_index: 1, tool_info: {
      name: mcp.name, parameters: mcp.parameters,
      error: { type: "TOOL_ERROR", message: 'permission check failed for mcp "opentabs/browser_emulate_device": user denied permission for mcp(opentabs/browser_emulate_device)' },
    } } },
    immediate ? { status: "ERROR", diagnostic: "敏感认证操作：仅保留状态" }
      : { event: "result", result: { status: mode === "historical-error-footer" ? "ERROR" : "SUCCESS", response: "{}",
        ...(mode === "historical-error-footer" ? { error: "API error: Post https://example.invalid/: EOF" } : {}),
        denied_actions: [{ action: "mcp", display_name: "CallMcpTool" }] } },
  ];
  writeFileSync(cli, `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`);
  const run: Run = { id: s.principal.run_id, workflow_id: s.workflow.id, adapter: "agy", stage: "execute", purpose: "implement",
    plan_revision: 1, status: "running", started_at: new Date().toISOString(), package_hash: "native-permission", execution_spec_id: "permission-spec",
    profile: { id: "executor", adapterId: "agy", revision: 1, modelSelection: "explicit", modelId: "fixture-only", executableRef: process.execPath, options: { prefixArgs: [cli] } } };
  s.store.put("execution_spec", "permission-spec", s.workflow.id, { workflow_id: s.workflow.id });
  s.store.put("run", run.id, s.workflow.id, run);
  const processes = new ProcessManager();
  const runtime = new ProfileRuntime(s.engine, processes);
  disposals.push(() => processes.close());
  const invocation = (runtime as any).invoke(s.engine.get(s.workflow.id), run, { instructions: "permission fixture" }, {}, "fixture-token");
  if (historical) {
    if (mode === "historical-error-footer") await expect(invocation).rejects.not.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
    else {
      await expect(invocation).resolves.toEqual({});
      expect(s.store.must<Run>("run", run.id).status).toBe("completed");
    }
    expect(new UserInteractionService(s.store).getCurrentInteraction(s.workflow.id)).toBeUndefined();
    expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
    return;
  }
  await expect(invocation).rejects.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
  expect(s.store.must<Run>("run", run.id).status).toBe("waiting");
  const interaction = new UserInteractionService(s.store).getCurrentInteraction(s.workflow.id)!;
  expect(interaction.request.choices?.map(choice => choice.id)).toEqual(["allow_tool", "deny"]);
  expect(interaction.request.message).toContain('"tabId":123');
  expect(s.engine.get(s.workflow.id).state).toBe("WAITING_INPUT");
});

it("the generated native hook repeatedly allows permanent MCP grants and restores pre-existing hooks", async () => {
  const s = await fixture(mcp as any);
  await answer(s, "allow_tool");
  const run = resume(s);
  const grant = bindNativePermission(s.store, run)!;
  const path = join(s.root, ".agents", "hooks.json");
  mkdirSync(join(s.root, ".agents"), { recursive: true });
  const original = '{\n  "user-hook": {"enabled": false}\n}\n';
  writeFileSync(path, original);
  const restore = installAgyPermissionHook(s.root, s.root, grant);
  disposals.push(restore);
  const base = await s.app.listen({ host: "127.0.0.1", port: 0 });
  const token = s.engine.auth.issue({ role: "worker", workflow_id: s.workflow.id, run_id: run.id });
  const invoke = (parameters: Record<string, unknown> = mcp.parameters) => new Promise<string>((resolve, reject) => {
    const command = Object.values(JSON.parse(readFileSync(path, "utf8"))).find((item: any) => item.PreToolUse) as any;
    const executable = process.platform === "win32" ? "cmd.exe" : process.execPath;
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command.PreToolUse[0].hooks[0].command] : [join(s.root, "permission-hook.mjs")];
    const child = execFile(executable, args, {
      env: { ...process.env, DEVFLOW_BASE_URL: base, DEVFLOW_RUN_TOKEN: token }, windowsHide: true,
      ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    // Native hooks may leave stdin open while waiting for the decision.
    child.stdin!.write(JSON.stringify({ conversationId: session, transcriptPath: 'C:\\fixture\\a "}\\file', toolCall: { name: mcp.name, args: parameters, id: "native-id" } }));
  });
  expect(JSON.parse(await invoke())).toMatchObject({ decision: "allow", permissionOverrides: ["mcp(opentabs/browser_emulate_device)"] });
  expect(JSON.parse(await invoke({ ServerName: "other", ToolName: "another", Arguments: { any: 3 } }))).toMatchObject({ decision: "allow", permissionOverrides: ["mcp(other/another)"] });
  expect(JSON.parse(await invoke({ ServerName: "*", ToolName: "*" })).permissionOverrides).toBeUndefined();
  expect(JSON.parse(await invoke()).decision).toBe("allow");
  restore();
  expect(readFileSync(path, "utf8")).toBe(original);
});

it("preserves concurrent hook edits and removes only its own temporary entry", async () => {
  const s = await fixture();
  await answer(s);
  const run = resume(s);
  const restore = installAgyPermissionHook(s.root, s.root, bindNativePermission(s.store, run)!);
  const path = join(s.root, ".agents", "hooks.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config["other-user-hook"] = { enabled: true };
  writeFileSync(path, JSON.stringify(config));
  restore();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "other-user-hook": { enabled: true } });
});

it("converts an older blocked run into an authorization popup using its own log, without restarting it", async () => {
  const s = await fixture();
  s.engine.transition(s.workflow.id, ["WAITING_INPUT"], "BLOCKED", "blocked", { blocker: { code: "NATIVE_PERMISSION_DENIED", message: "denied" } });
  const path = join(s.engine.config.storage_root, "native-runs", s.run.id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "stdout.jsonl"), [
    { event: "step_update", step_update: { step_index: 1, step_type: "tool", state: "ERROR", tool_info: { name: mcp.name, parameters: mcp.parameters,
      error: { type: "TOOL_ERROR", message: 'permission check failed for mcp "opentabs/browser_emulate_device": user denied permission for mcp(opentabs/browser_emulate_device)' } } } },
    { event: "result", result: { denied_actions: [{ display_name: "CallMcpTool" }] } },
  ].map(value => JSON.stringify(value)).join("\n"));
  const interaction = recoverNativePermission(s.engine, s.workflow.id, s.engine.get(s.workflow.id).version)!;
  expect(interaction.request.kind).toBe("question");
  expect(s.engine.get(s.workflow.id).state).toBe("WAITING_INPUT");
  expect(s.engine.get(s.workflow.id).run_id).toBe(s.run.id);
});

it("missing operation metadata asks for manual repair and cannot create a generic approval", async () => {
  const s = await fixture();
  s.engine.transition(s.workflow.id, ["WAITING_INPUT"], "EXECUTING", "execute");
  const unknown = pauseForNativePermission(s.engine, s.run, [], "CallMcpTool")!;
  expect(unknown.request.kind).toBe("action_required");
  expect(unknown.request.message).toContain("不会自动授予未知操作权限");
  expect(s.store.get(NATIVE_PERMISSION_ENTITY, unknown.id)).toBeUndefined();
});

it("recovers the second task pattern even when the final error lost its type during redaction", async () => {
  const s = await fixture();
  s.engine.transition(s.workflow.id, ["WAITING_INPUT"], "BLOCKED", "blocked", { blocker: { code: "EXECUTION_FAILED", message: "敏感认证操作：仅保留状态" } });
  const path = join(s.engine.config.storage_root, "native-runs", s.run.id);
  mkdirSync(path, { recursive: true });
  const hover = { ...mcp.parameters, ToolName: "browser_hover_element", Arguments: { selector: ".flow-nav-btn", tabId: 123 } };
  writeFileSync(join(path, "stdout.jsonl"), [
    { event: "step_update", step_update: { step_index: 10, step_type: "user_input", state: "DONE" } },
    { event: "step_update", step_update: { step_index: 11, conversation_id: session, step_type: "tool", state: "ERROR", tool_info: {
      name: mcp.name, parameters: hover,
      error: { type: "TOOL_ERROR", message: 'permission check failed for mcp "opentabs/browser_hover_element": user denied permission for mcp(opentabs/browser_hover_element)' },
    } } },
    { status: "ERROR", diagnostic: "敏感认证操作：仅保留状态" },
  ].map(value => JSON.stringify(value)).join("\n"));
  const response = await s.app.inject({ method: "POST", url: `/api/workflows/${s.workflow.id}/native-permissions/request`,
    payload: { expected_version: s.engine.get(s.workflow.id).version } });
  expect(response.statusCode).toBe(200);
  expect(response.json().interaction.request.message).toContain("browser_hover_element");
  expect(s.engine.get(s.workflow.id).state).toBe("WAITING_INPUT");
});

it("does not turn an unconfirmed generic runtime failure into authorization", async () => {
  const s = await fixture();
  s.engine.transition(s.workflow.id, ["WAITING_INPUT"], "BLOCKED", "blocked", { blocker: { code: "EXECUTION_FAILED", message: "EACCES" } });
  expect(() => recoverNativePermission(s.engine, s.workflow.id, s.engine.get(s.workflow.id).version)).toThrow("本轮日志未确认");
  expect(s.engine.get(s.workflow.id).state).toBe("BLOCKED");
});

it("keeps sensitive or incompletely displayed calls out of automated permission grants", async () => {
  const s = await fixture();
  s.engine.transition(s.workflow.id, ["WAITING_INPUT"], "EXECUTING", "execute");
  const sensitive = pauseForNativePermission(s.engine, s.run, [{ name: "run_command", parameters: { CommandLine: "tool login --token private-value" } }], "denied")!;
  expect(sensitive.request.kind).toBe("action_required");
  expect(sensitive.request.message).not.toContain("private-value");
  expect(s.store.get(NATIVE_PERMISSION_ENTITY, sensitive.id)).toBeUndefined();
});
