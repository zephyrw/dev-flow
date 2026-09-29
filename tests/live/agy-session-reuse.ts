/** Explicit live acceptance: pnpm exec tsx tests/live/agy-session-reuse.ts
 * Uses the signed-in AGY account and retains its test conversations/evidence.
 * No mocks, account switching, production database writes or history deletion.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../../packages/store/src/store.js";
import { Engine } from "../../packages/core/src/engine.js";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import type { ToolProfile, Run, Workspace } from "../../packages/contracts/src/index.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { AgyAccountJobRunner } from "../../packages/process/src/agy-account-job-runner.js";
import { AgyAccountProbe, createVerifiedUsageAdapter } from "../../packages/adapters/agy/src/account-probe.js";
import { resolveAgyExecutable } from "../../packages/adapters/agy/src/executable-resolver.js";
import Database from "better-sqlite3";
import { repository, proof } from "../helpers.js";

const root = resolve(".cache", "live-agy-session-" + randomUUID());
mkdirSync(root, { recursive: true });
const summary: Record<string, any> = { root, started_at: new Date().toISOString() };
const save = () => writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ evidence: root }));
const historyDir = join(homedir(), ".gemini", "antigravity-cli", "conversations");
const history = () => existsSync(historyDir) ? readdirSync(historyDir).filter(n => n.endsWith(".db")) : [];
const beforeHistory = new Set(history());
const executable = resolveAgyExecutable();
assert(executable.resolvedPath && executable.fingerprint, "Real AGY executable required");
const runner = new AgyAccountJobRunner(executable.resolvedPath);
let modelCalls = 0;
const probe = new AgyAccountProbe(executable.resolvedPath,
  createVerifiedUsageAdapter(executable.fingerprint, "1.2.12"), {
    async runAuxiliaryProbe(options) {
      const isModel = options.args.includes("--model");
      if (isModel) modelCalls++;
      const result = await runner.runAuxiliaryProbe(options);
      if (isModel) {
        writeFileSync(join(root, "probe.jsonl"), result.stdout);
        writeFileSync(join(root, "probe.stderr.txt"), result.stderr);
        summary.probe_exit_code = result.code;
      }
      return result;
    },
  });
const config = ConfigSchema.parse({ storage_root: join(root, "state"), workspace_root: join(root, "worktrees") });
const store = new Store(join(root, "state", "devflow.sqlite"));
const engine = new Engine(store, config);
const runtime = new LocalRuntime(engine);
engine.runtime = runtime;
const starts: Array<{ id: string; cwd: string; args: string[] }> = [];
const start = runtime.processes.start.bind(runtime.processes);
runtime.processes.start = (spec) => {
  if (resolve(spec.executable).toLowerCase() === resolve(executable.resolvedPath!).toLowerCase())
    starts.push({ id: spec.id, cwd: spec.cwd, args: [...spec.args] });
  return start(spec);
};
let workflowId: string | undefined;
const oldScope = process.env.DEVFLOW_ACCOUNT_SCOPE;
try {
  // Read only the controller's verified active-account metadata; do not compete for
  // its OS credential lock or copy secrets into the isolated test instance.
  const production = new Database(resolve(".devflow/devflow.sqlite"), { readonly: true, fileMustExist: true });
  const readMetadata = (kind: string, id: string) => {
    const row = production.prepare("SELECT data FROM entities WHERE kind=? AND id=?").get(kind, id) as { data: string } | undefined;
    assert(row, "Active account metadata required");
    return JSON.parse(row.data);
  };
  const realm = readMetadata("agy_realm", "default-agy-realm");
  const account = readMetadata("agy_account", realm.active_account_id);
  production.close();
  assert(account.identity?.email && account.credential_revision);
  process.env.DEVFLOW_ACCOUNT_SCOPE = account.identity.email;
  const modelId = "gemini-3.8-flash-high";
  const probeOptions = { account_id: account.id, credential_revision: account.credential_revision, timeoutMs: 60_000 };
  assert.deepEqual(await Promise.all([
    probe.probeModelAccess(modelId, probeOptions),
    probe.probeModelAccess(modelId, probeOptions),
  ]), [true, true]);
  assert.equal(await probe.probeModelAccess(modelId, probeOptions), true);
  assert.equal(modelCalls, 1);
  summary.probe = { model_calls: modelCalls, concurrent_waiters: 2, cached_repeat: true };
  console.log("Live probe: two concurrent requests and one repeat used one model process");
  const profile: ToolProfile = { id: "live-agy-session", revision: 1, adapterId: "agy",
    executableRef: executable.resolvedPath, modelSelection: "explicit", modelId, options: {} };
  // Only seed isolated access evidence AFTER the real model probe succeeded.
  seedVerifiedAccess(store, profile);
  const fixtureRoot = join(tmpdir(), "devflow-live-session-" + randomUUID());
  const repo = await repository(fixtureRoot, "session-reuse-source");
  const created = new CreateWorkflowService(store, config).execute({
    request_id: "live-session-" + randomUUID(), workspace_root: repo.repo,
    workspace_mode: "new_worktree", worktree_path: join(fixtureRoot, "task-worktree"),
    planner_profile: profile, executor_profile: profile,
    request_text: "这是 DevFlow 会话复用的真实最小验收任务。需求已经确定，无需澄清：仅将 app.txt 的 before 改成 after，保留末尾换行。规划阶段先读取 app.txt，给出一个工作项、一个验收项的最小完整计划，审批前不要修改文件。执行阶段只修改 app.txt，执行 node 内置 assert 读取文件确认内容严格等于 after 加换行；没有 UI、外部服务或依赖需要安装。请遵循本轮交接文件和输出 schema，不创建额外 Agent。只检查本测试工作区及交接文件，不读取或运行 DevFlow 源码；无需编写验证 schema 的程序、安装依赖或启动服务，最终结构化输出由调度器验证。",
  });
  workflowId = created.workflow.id;
  const workspace = store.list<Workspace>("workspace", workflowId)[0]!;
  assert(workspace && existsSync(join(workspace.root, ".git")));
  assert.notEqual(resolve(workspace.root), resolve(repo.repo));
  assert.equal(store.list("run", workflowId).length, 0);
  summary.workflow_id = workflowId;
  summary.workspace_before_planning = workspace.root;
  save();
  const waitFor = async (target: string) => {
    const deadline = Date.now() + 12 * 60_000;
    let last = "";
    while (Date.now() < deadline) {
      await engine.dispatch();
      const w = engine.get(workflowId!);
      const state = w.state + ":" + w.stage;
      if (state !== last) { console.log(state); last = state; }
      if (w.state === "BLOCKED" || w.state === "WAITING_INPUT") throw new Error(JSON.stringify({ state, blocker: w.blocker }));
      if (w.state === target) { await engine.waitForIdle(workflowId!); return; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error("Timed out awaiting " + target);
  };
  await waitFor("PLAN_PENDING");
  assert.equal(readFileSync(join(workspace.root, "app.txt"), "utf8"), "before\n");
  const binding = store.list<any>("session_binding", workflowId);
  assert.equal(binding.length, 1);
  summary.planning_root = binding[0].conversation_id;
  const approval = proof(engine, workflowId, "approve");
  engine.approve(workflowId, approval.proof, approval.binding);
  await waitFor("HUMAN_PENDING");
  assert.equal(readFileSync(join(workspace.root, "app.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(repo.repo, "app.txt"), "utf8"), "before\n");
  const finalBindings = store.list<any>("session_binding", workflowId);
  assert.equal(finalBindings.length, 1);
  assert.equal(finalBindings[0].conversation_id, summary.planning_root);
  const runs = store.list<Run>("run", workflowId);
  assert(runs.some(r => r.purpose === "planning") && runs.some(r => r.stage === "execute"));
  const formalStarts = starts.filter(s => runs.some(r => r.id === s.id));
  assert(formalStarts.length >= 2, "Real planning and execution processes required");
  for (const invocation of formalStarts) assert.equal(resolve(invocation.cwd), resolve(workspace.root));
  assert(!formalStarts[0]!.args.includes("--conversation"));
  for (const invocation of formalStarts.slice(1)) {
    const flag = invocation.args.indexOf("--conversation");
    assert(flag >= 0, "Later formal turns must explicitly resume the native root");
    assert.equal(invocation.args[flag + 1], summary.planning_root);
  }
  assert.equal(finalBindings[0].latest_run_id, formalStarts.at(-1)!.id);
  summary.native_results = formalStarts.map(invocation => {
    const events = readFileSync(join(config.storage_root, "native-runs", invocation.id, "stdout.jsonl"), "utf8")
      .trim().split(/\r?\n/).map(line => JSON.parse(line));
    const init = events.find(event => event.event === "init");
    assert.equal(init?.conversation_id, summary.planning_root);
    assert.equal(init?.init?.model, modelId);
    assert.equal(resolve(init.init.cwd), resolve(workspace.root));
    assert(events.some(event => event.event === "result" && event.result?.status === "SUCCESS"));
    return { run_id: invocation.id, conversation_id: init.conversation_id, cwd: init.init.cwd, status: "SUCCESS" };
  });
  summary.runs = runs;
  summary.binding = finalBindings[0];
  summary.result = "passed";
} catch (error) {
  summary.result = "failed";
  summary.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (workflowId) {
    summary.workflow = engine.get(workflowId);
    summary.runs = store.list("run", workflowId);
    summary.bindings = store.list("session_binding", workflowId);
    summary.dispatches = store.list("cli_dispatch_record").filter((d: any) => d.workflow_id === workflowId);
    await engine.stop(workflowId).catch(() => {});
    await engine.waitForIdle(workflowId);
  }
  await runtime.close();
  await runner.close();
  store.close();
  if (oldScope === undefined) delete process.env.DEVFLOW_ACCOUNT_SCOPE;
  else process.env.DEVFLOW_ACCOUNT_SCOPE = oldScope;
  summary.new_history = history().filter(n => !beforeHistory.has(n));
  summary.finished_at = new Date().toISOString();
  summary.native_invocations = starts;
  save();
  console.log(JSON.stringify({ result: summary.result, evidence: root, new_history: summary.new_history }));
}
