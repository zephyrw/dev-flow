import { afterEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, project, plan } from "../helpers.js";
import { removeDirWithBoundedRetry } from "../fixtures/isolation.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { AgyNativeCliAdapter } from "../../packages/adapters/agy/src/adapter.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import { frozenInvocationFromProfile, resolveRoutingPreview } from "../../packages/core/src/run-profile.js";
import { readRunContinuation } from "../../packages/core/src/waiting-context.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import type { Run, ToolProfile, Workflow, Workspace } from "../../packages/contracts/src/index.js";
import type { ManagedProcess, ProcessManager, ProcessSpec } from "../../packages/process/src/manager.js";

vi.mock("../../packages/adapters/sdk/src/index.js", async original => ({
  ...await original<object>(),
  createDefaultAdapterRegistry: () => ({ mustGet: () => new AgyNativeCliAdapter() }),
  resolveSessionIdentity: async (_adapter: unknown, input: { frozenProfile: ToolProfile; workspace: { root: string } }) => ({
    resolved: true, adapter_id: "agy", host_id: "fixture-host", client_scope_id: "fixture-client",
    provider_account_scope: "fixture-account", canonical_model_id: input.frozenProfile.modelId,
    workspace_identity: input.workspace.root,
  }),
}));
vi.mock("../../packages/adapters/agy/src/native-record-source.js", async original => ({
  ...await original<object>(), AgyNativeRecordSource: class { read() { return undefined; } },
}));

type Round = { result: Record<string, unknown>; hold?: boolean; denied?: boolean };
const fixtures: Array<ReturnType<typeof setup> & { processes: Map<string, ManagedProcess> }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.engine.runtime = undefined;
    for (const proc of f.processes.values()) await proc.stop();
    f.store.close();
    await removeDirWithBoundedRetry(f.root);
  }
  vi.restoreAllMocks();
});

function fixture(rounds: Round[]) {
  const s = setup();
  const time = new Date().toISOString();
  const w: Workflow = { id: "agy-auto-continuation", project_id: "p1", title: "AGY continuation fixture",
    request: "完成批准的任务", complexity: "simple", workspace_mode: "existing_workspace",
    state: "QUEUED", stage: "execute", quality_policy_version: 2, binding_strategy: "unified",
    version: 1, plan_revision: 1, plan_hash: "approved", environment_revision: 0, feedback: [], created_at: time, updated_at: time };
  const profile: ToolProfile = { id: "fixture-agy", revision: 1, adapterId: "agy", executableRef: process.execPath,
    modelSelection: "explicit", modelId: "gemini-fixture", reasoning: { mode: "explicit", value: "high" },
    options: { prefixArgs: [resolve("tests/fixtures/agy-auto-continuation-cli.mjs")] } };
  s.store.put("project", "p1", "p1", project(s.root));
  s.store.put("workflow", w.id, "p1", w);
  s.store.put("plan", `${w.id}-1`, w.id, { revision: 1, hash: w.plan_hash,
    plan: { ...plan("fixture", "a".repeat(40)), task_model: "native-v2" } });
  writeFileSync(join(s.root, "fixture.json"), JSON.stringify({ model: profile.modelId, rounds }));
  vi.spyOn(ModelAccessService.prototype, "resolveNativeConfig").mockReturnValue({
    identityConfidence: "account", accountId: "fixture-account", accountFingerprint: "fixture-account",
  } as ReturnType<ModelAccessService["resolveNativeConfig"]>);

  // Real adapter and real child_process, with a test-only host port. The
  // production ProcessManager's OS identity / process-tree guarantees are NOT
  // certified here (some containers mount /proc from a different PID namespace).
  const processes = new Map<string, ManagedProcess>();
  const start = vi.fn((spec: ProcessSpec): ManagedProcess => {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: { ...spec.env }, stdio: ["pipe", "pipe", "pipe"] });
    const proc = new EventEmitter() as ManagedProcess;
    proc.id = spec.id;
    proc.pid = child.pid;
    proc.ready = new Promise((resolveReady, reject) => {
      child.once("spawn", resolveReady);
      child.once("error", reject);
    });
    proc.completion = new Promise((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        s.store.put("process_record", spec.id, w.id, { id: spec.id, status: "exited", confirmed: true });
        resolveDone({ code, ...(signal ? { signal } : {}), ...(proc.termination_reason ? { termination_reason: proc.termination_reason } : {}) });
      });
    });
    void proc.ready.catch(() => {});
    void proc.completion.catch(() => {});
    proc.stop = async (reason = "manual") => {
      if (child.exitCode === null && child.signalCode === null) {
        proc.termination_reason = reason;
        child.kill("SIGTERM");
      }
      await proc.completion.catch(() => {});
    };
    proc.writeStdin = value => { child.stdin.write(value); };
    proc.endStdin = () => { child.stdin.end(); };
    child.stdout.on("data", chunk => proc.emit("stdout", chunk));
    child.stderr.on("data", chunk => proc.emit("stderr", chunk));
    if (spec.stdin) child.stdin.write(spec.stdin);
    child.stdin.end();
    s.store.put("process_record", spec.id, w.id, { id: spec.id, status: "running", confirmed: false });
    processes.set(spec.id, proc);
    return proc;
  });
  const runtime = new ProfileRuntime(s.engine, { start } as unknown as ProcessManager);
  const invoke = (runtime as unknown as { invoke(workflow: Workflow, run: Run, materials: unknown, schema: unknown,
    token: string | undefined, workspaces: Workspace[]): Promise<Record<string, unknown>> }).invoke.bind(runtime);
  const f = { ...s, w, profile, processes, start, invoke };
  fixtures.push(f);
  return f;
}

function running(f: ReturnType<typeof fixture>, id: string, source?: Run) {
  const preview = source ? resolveRoutingPreview(f.store, f.config, f.w.id, { purpose: "implement", retry_run_id: source.id }) : undefined;
  const profile = preview?.profile ?? f.profile;
  const run: Run = { id, workflow_id: f.w.id, adapter: "agy", purpose: "implement", stage: "execute", protocol: "lightweight",
    routing_role: "executor", status: "running", plan_revision: 1, package_hash: "fixture", started_at: new Date().toISOString(),
    logical_round_id: preview?.logical_round_id ?? "original-round", profile,
    frozen_invocation: preview?.frozen_invocation ?? { ...frozenInvocationFromProfile(profile, "profile-native"), accountScope: "fixture-account" },
    continuation: readRunContinuation(f.store, f.w.id) };
  f.store.put("run", run.id, f.w.id, run);
  f.store.remove("run_continuation", f.w.id);
  f.store.remove("pending_model_retry", f.w.id);
  f.engine.transition(f.w.id, [f.engine.get(f.w.id).state], "EXECUTING", run.stage, { run_id: run.id, blocker: undefined });
  return run;
}

async function execute(f: ReturnType<typeof fixture>, run: Run) {
  const result = await f.invoke(f.engine.get(f.w.id), run, {}, {}, undefined,
    [{ id: "ws", workflow_id: f.w.id, repo_id: "main", root: f.root, source_root: f.root } as Workspace]);
  await f.engine.receiveRoundResult(f.w.id, run.id, result);
  return result;
}

function invocations(f: ReturnType<typeof fixture>): Array<{ args: string[]; session: string; run_id: string }> {
  return readFileSync(join(f.root, "fixture-invocations.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}
const partial = { status: "incomplete", completed_items: ["T01"], unfinished_items: ["T02"] };

it("uses the real AGY adapter to resume the original native session and frozen model after incomplete", async () => {
  const f = fixture([{ result: partial }, { result: { status: "completed", completed_items: ["T02"], unfinished_items: [] } }]);
  const first = running(f, "first");
  await execute(f, first);
  const source = f.store.must<Run>("run", first.id);
  expect(source.conversation_id).toBeTruthy();
  expect(f.engine.get(f.w.id).state).toBe("QUEUED");
  const next = running(f, "continued", source);
  expect(next.continuation?.kind).toBe("execution_continue");
  await execute(f, next);
  const calls = invocations(f);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.session).toBe(source.conversation_id);
  expect(calls[1]!.args).toContain("--conversation");
  expect(calls[1]!.args[calls[1]!.args.indexOf("--conversation") + 1]).toBe(source.conversation_id);
  expect(calls[1]!.args[calls[1]!.args.indexOf("-p") + 1]).toContain("继续按照已批准的原计划");
  expect(next.profile).toEqual(first.profile);
  expect(next.frozen_invocation).toEqual(first.frozen_invocation);
  expect(f.store.must<Run>("run", next.id).conversation_id).toBe(source.conversation_id);
  expect(f.store.get("execution_completion", next.id)).toMatchObject({ intent: "completed" });
  expect(f.store.list("user_interaction", f.w.id)).toHaveLength(0);
});

it("does not route incomplete output until the actual CLI child has closed", async () => {
  const f = fixture([{ result: partial, hold: true }]);
  const run = running(f, "held");
  const result = execute(f, run);
  await vi.waitFor(() => expect(existsSync(join(f.root, "fixture-emitted-1"))).toBe(true));
  expect(f.store.get("process_record", run.id)).toMatchObject({ status: "running", confirmed: false });
  expect(f.engine.get(f.w.id).state).toBe("EXECUTING");
  expect(f.store.list("execution_auto_continuation", f.w.id)).toHaveLength(0);
  writeFileSync(join(f.root, "fixture-release-1"), "release");
  await result;
  expect(f.store.get("process_record", run.id)).toMatchObject({ status: "exited", confirmed: true });
  expect(f.engine.get(f.w.id).state).toBe("QUEUED");
  expect(f.start).toHaveBeenCalledTimes(1);
});

it("keeps a user pause authoritative after the CLI has emitted incomplete but has not exited", async () => {
  const f = fixture([{ result: partial, hold: true }]);
  const run = running(f, "paused");
  const result = execute(f, run);
  const rejected = expect(result).rejects.toMatchObject({ code: "RUN_REVOKED" });
  await vi.waitFor(() => expect(existsSync(join(f.root, "fixture-emitted-1"))).toBe(true));
  f.engine.runtime = { execute: vi.fn(), review: vi.fn(), check: vi.fn(), close: vi.fn(),
    stop: async id => {
      await f.processes.get(id)!.stop();
      return { status: "confirmed_exited" };
    } };
  await f.engine.stop(f.w.id);
  await rejected;
  expect(f.engine.get(f.w.id).state).toBe("STOPPED");
  expect(f.store.get("run_stop", run.id)).toBeDefined();
  expect(f.store.list("execution_auto_continuation", f.w.id)).toHaveLength(0);
  expect(f.start).toHaveBeenCalledTimes(1);
});

it.each([false, true])("preserves a resumed user request or native permission denial without auto-authorizing (native=%s)", async denied => {
  const question = { kind: "question", title: "确认操作", message: "这项操作需要你决定", question: "是否继续？", allow_free_text: true };
  const f = fixture([{ result: partial }, { denied, result: denied ? partial : { status: "need_user", user_interaction: question } }]);
  const first = running(f, "request-source");
  await execute(f, first);
  const next = running(f, "request-followup", f.store.must<Run>("run", first.id));
  if (denied) await expect(execute(f, next)).rejects.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
  else await execute(f, next);
  expect(f.engine.get(f.w.id).state).toBe("WAITING_INPUT");
  const interaction = new UserInteractionService(f.store).getCurrentInteraction(f.w.id);
  expect(interaction?.status).toBe("pending");
  expect(interaction?.response).toBeUndefined();
  expect(f.store.get("execution_auto_continuation", next.id)).toBeUndefined();
  expect(f.store.get("execution_completion", next.id)).toBeUndefined();
  expect(f.store.list<{ decision?: string }>("native_permission", f.w.id).every(request => request.decision === undefined)).toBe(true);
  expect(invocations(f)).toHaveLength(2);
});
