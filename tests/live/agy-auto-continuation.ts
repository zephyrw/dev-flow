/** Explicit live check: pnpm exec tsx tests/live/agy-auto-continuation.ts
 * Uses the signed-in account, new native sessions and an isolated temporary Store.
 * Does not access the production database, credentials or existing conversations.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { Store } from "../../packages/store/src/store.js";
import { Engine } from "../../packages/core/src/engine.js";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import type { Run, ToolProfile, ExecutionSpec } from "../../packages/contracts/src/index.js";
import { createWorkflowSpec } from "../../packages/core/src/create-workflow.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { objectHash, redact } from "../../packages/core/src/util.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { agyArguments, observeAgy } from "../../packages/adapters/agy/src/session.js";
import { resolveFingerprintedAgyExecutable } from "../../packages/adapters/agy/src/executable-resolver.js";
import { repository, project, plan, proof, publishPlanFixture } from "../helpers.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "devflow-live-auto-continue-")));
const model = "gemini-3.8-flash-high";
const portReservation = createServer();
await new Promise<void>(resolve => portReservation.listen(0, "127.0.0.1", resolve));
const isolatedPort = (portReservation.address() as AddressInfo).port;
await new Promise<void>((resolve, reject) => portReservation.close(error => error ? reject(error) : resolve()));
const config = ConfigSchema.parse({ storage_root: join(root, "state"), workspace_root: join(root, "worktrees"),
  server: { port: isolatedPort, human_origin: `http://localhost:${isolatedPort}` },
  timeouts: { agent_minutes: 4 }, host: { required: false } });
const store = new Store(join(config.storage_root, "devflow.sqlite"));
const engine = new Engine(store, config);
const runtime = new LocalRuntime(engine);
const probeProcesses = new ProcessManager();
const summary: Record<string, unknown> = { root, model, started_at: new Date().toISOString() };
const workflowIds: string[] = [];
console.log(JSON.stringify({ evidence: root, model }));

try {
  const executable = await resolveFingerprintedAgyExecutable();
  assert(executable.resolvedPath, "AGY executable unavailable");
  const probeRoot = join(root, "probe");
  mkdirSync(probeRoot);
  const marker = "AUTO-CONTINUE-" + randomUUID();
  const proc = probeProcesses.start({ id: "probe-" + randomUUID(), executable: executable.resolvedPath,
    args: agyArguments(model, `Do not call tools. Return exactly ${marker}`, 1),
    cwd: probeRoot, env: {}, timeout_ms: 75000 });
  const probe = await observeAgy(proc, { model, cwd: probeRoot, log: join(root, "probe.jsonl"),
    onEvent: () => {}, onDiagnostic: () => {} });
  assert(String(probe.result.response).includes(marker), "Actual model access probe failed");
  const profile: ToolProfile = { id: "live-auto-continuation", revision: 1, adapterId: "agy",
    executableRef: executable.resolvedPath, modelSelection: "explicit", modelId: model, options: {} };
  // The isolated admission record follows an actual successful model invocation.
  seedVerifiedAccess(store, profile);
  summary.probe_passed = true;

  const execute = runtime.execute.bind(runtime);
  runtime.execute = async (workflow, run, token) => {
    await execute(workflow, run, token);
    // Scope this live check to execution; never launch an unrelated review model.
    if (store.get("execution_completion", run.id)) engine.runtime = undefined;
  };

  const runScenario = async (scenario: "continue" | "need_user") => {
    const repo = await repository(root, scenario);
    const p = { ...project(repo.repo), id: "live-" + scenario };
    store.put("project", p.id, p.id, p);
    const request = scenario === "continue"
      ? "这是自动续执行的隔离验收。只在当前临时工作区操作 app.txt，不创建额外 Agent，不读取 DevFlow 源码、用户目录或其他项目，不联网。必须分两轮完成：第一轮仅把 app.txt 写成 first 加换行，返回 JSON {status:incomplete,summary:第一部分完成,completed_items:[T01],unfinished_items:[{id:T02,reason:第二部分待续接}]} 后结束本轮。收到自动继续后再把 app.txt 写成 first 加换行再加 second 加换行，使用 node 内置 assert 验证实际内容，返回 status completed。第一轮的结束是测试步骤，不是用户暂停，不请求用户确认。不要提前完成第二部分。不编写输出格式校验器，不做额外 Git 检查；输出格式中的其他可空字段填 null，直接结束该轮。"
      : "这是需要用户决定的隔离验收，不读取或修改任何文件、不调用工具。输出 status need_user 和 user_interaction {kind:question,title:请选择报告语言,message:报告语言需要用户决定,question:报告使用中文还是英文,choices:[{id:zh,label:中文},{id:en,label:英文}],allow_free_text:false}。必须等待真实用户选择，不自行选择，不继续执行。";
    const w = engine.create({ project_id: p.id, title: scenario === "continue" ? "真实模型自动续执行" : "真实模型必要提问",
      request, complexity: "simple", workspace_mode: "existing_workspace" }, "live-" + randomUUID());
    workflowIds.push(w.id);
    await engine.git.prepare(p, w.id, "existing_workspace", { main: repo.baseline });
    const original = store.list<ExecutionSpec>("execution_spec", w.id)[0]!;
    const spec = createWorkflowSpec(store, w.id, { planner_profile: profile, executor_profile: profile }, config);
    store.put("execution_spec", original.id, w.id, { ...spec, id: original.id });
    const contract = plan(objectHash(p), repo.baseline);
    contract.task_model = "native-v2";
    contract.markdown = "# 已批准的隔离验收步骤\n\n" + request;
    contract.tasks[0]!.implementation = request;
    contract.tasks[0]!.completion = scenario === "continue" ? "app.txt 内容为 first\\nsecond\\n，实际断言通过" : "提出报告语言选择，保持等待";
    engine.submitPlan(w.id, contract, w.version, "live-plan");
    publishPlanFixture(engine, w.id);
    const approval = proof(engine, w.id, "approve");
    engine.approve(w.id, approval.proof, approval.binding);
    engine.runtime = runtime;
    const deadline = Date.now() + 480000;
    let reached = false;
    while (Date.now() < deadline) {
      await engine.dispatch();
      const current = engine.get(w.id);
      const runs = store.list<Run>("run", w.id);
      if (current.state === "BLOCKED" || current.state === "WAITING_AUTHORIZATION")
        throw new Error(redact(JSON.stringify({ scenario, state: current.state, blocker: current.blocker })));
      if (scenario === "need_user" ? current.state === "WAITING_INPUT" : store.list("execution_completion", w.id).length > 0) {
        reached = true;
        break;
      }
      if (scenario === "continue" && current.state === "WAITING_INPUT")
        throw new Error(redact(JSON.stringify({ scenario, blocker: current.blocker })));
      assert(runs.length <= 4, "Unexpected repeated live model calls");
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert(reached, "Timed out awaiting " + scenario);
    await engine.waitForIdle(w.id);
    const runs = store.list<Run>("run", w.id).filter(run => run.purpose === "implement");
    const interactions = store.list<{ status: string; request: { kind: string; title: string } }>("user_interaction", w.id);
    if (scenario === "continue") {
      assert.equal(runs.length, 2, "Expected exactly two execution turns");
      assert(runs[0]!.conversation_id, "Native conversation was not recorded");
      assert.equal(runs[0]!.conversation_id, runs[1]!.conversation_id);
      assert.deepEqual(runs[0]!.profile, runs[1]!.profile);
      assert.equal(interactions.length, 0);
      assert.equal(readFileSync(join(repo.repo, "app.txt"), "utf8"), "first\nsecond\n");
    } else {
      assert.equal(runs.length, 1);
      assert.equal(interactions.length, 1);
      assert.equal(interactions[0]!.status, "pending");
      assert.equal(interactions[0]!.request.kind, "question");
      assert.equal(readFileSync(join(repo.repo, "app.txt"), "utf8"), "before\n");
      await engine.dispatch();
      assert.equal(store.list("run", w.id).length, 1, "Real question was automatically answered");
    }
    const result = { workflow_id: w.id, state: engine.get(w.id).state,
      runs: runs.map(run => ({ id: run.id, conversation_id: run.conversation_id, status: run.status })),
      interactions: interactions.map(interaction => ({ status: interaction.status, kind: interaction.request.kind })) };
    summary[scenario] = result;
    console.log(JSON.stringify({ scenario, result: "passed", turns: runs.length }));
    // Retire this isolated scenario before the next one enables dispatch again.
    await engine.stop(w.id);
    await engine.waitForIdle(w.id);
  };
  await runScenario("continue");
  await runScenario("need_user");
  summary.result = "passed";
} catch (error) {
  summary.result = "failed";
  summary.error = redact(String(error));
  process.exitCode = 1;
  console.error(summary.error);
} finally {
  engine.runtime = runtime;
  for (const id of workflowIds) {
    await engine.stop(id).catch(() => {});
    await engine.waitForIdle(id);
  }
  await runtime.close();
  await probeProcesses.close();
  store.close();
  summary.finished_at = new Date().toISOString();
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ result: summary.result, evidence: root }));
}
