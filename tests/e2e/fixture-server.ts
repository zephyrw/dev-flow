import { startTask } from "../../packages/core/src/progress.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { Engine, type Runtime } from "../../packages/core/src/engine.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { objectHash, hash, atomicWrite } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";
import { buildServer } from "../../apps/api/src/server.js";
import type {
  Workflow,
  Run,
  MergeConflictRequest,
} from "../../packages/contracts/src/index.js";
import { seedSourceChange } from "../fixtures/source-change.js";
import {
  attachmentArchiveKey,
  createArchiveJobFromManifest,
  drainArchiveOutbox,
} from "../../packages/evidence/src/archive-consumer.js";
const s = setup();
s.config.server.port = 14811;
s.config.server.human_origin = "http://localhost:14811";
s.config.host.required = true;
s.config.host.executable = resolve(
  "dist/host/" +
    (process.platform === "win32" ? "devflow-host.exe" : "devflow-host"),
);
const engine = new Engine(s.store, s.config);
const repo = await repository(s.root);
writeFileSync(
  join(repo.repo, "verify.cjs"),
  `const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('updates content',()=>assert.equal(fs.readFileSync('app.txt','utf8'),'after\\n'));`,
);
await git(repo.repo, ["add", "verify.cjs"]);
await git(repo.repo, ["commit", "-m", "test fixture"]);
repo.baseline = await git(repo.repo, ["rev-parse", "HEAD"]);
const p = project(repo.repo);
p.commands[0]!.args = [
  "--test",
  "--test-reporter=junit",
  "--test-reporter-destination=${DEVFLOW_REPORT_PATH}",
  "verify.cjs",
];
p.commands[0]!.parser = "junit";
await engine.registerProject(p);
const w = engine.create(
  {
    project_id: p.id,
    title: "验证审批与交付闭环",
    request: "将文本更新为 after，保留其他行为。此任务仅用于隔离测试夹具。",
    complexity: "simple",
    workspace_mode: "existing_workspace",
  },
  "fixture",
);
const fixturePlan = plan(objectHash(p), repo.baseline);
fixturePlan.task_model = "leaf-v1";
fixturePlan.modules = [{ id: "M1", title: "文本修复" }];
fixturePlan.tasks[0]!.module_id = "M1";
fixturePlan.tasks[0]!.completion_checks = [
  { path: "app.txt", contains: "after" },
];
fixturePlan.tests[0]!.expected_case_ids = ["test updates content"];
engine.submitPlan(w.id, fixturePlan, w.version, "p1");
const runtime = new LocalRuntime(engine);
const nativeRoot = join(s.root, "native");
mkdirSync(nativeRoot, { recursive: true });
const nativeRepo = await repository(nativeRoot),
  nativeProject = {
    ...project(nativeRepo.repo),
    id: "native",
    name: "原生验收项目",
  };
await engine.registerProject(nativeProject);
s.store.put("tool_profile", "profile-codex", "global", {
  id: "profile-codex",
  revision: 1,
  adapterId: "codex",
  executableRef: process.execPath,
  modelSelection: "explicit",
  modelId: "fixture-only",
  options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
});
const stopped = new Set<string>();
const feedbackExecutions = new Map<string, () => void>();
// Only this test entrypoint injects a deterministic adapter. The production server has no switch for it.
engine.runtime = {
  plan: (w, r) => runtime.plan(w, r),
  aside: (w, r, q) => runtime.aside(w, r, q),
  async execute(flow: Workflow, run: Run, token: string) {
    if (s.store.get("feedback_fixture", flow.id)) {
      s.store.event(flow.id, flow.project_id, "FixtureExecutionDispatched", { purpose: run.purpose }, run.id);
      await new Promise<void>((done) => feedbackExecutions.set(run.id, done));
      return;
    }
    if (engine.plan(flow.id).plan.task_model === "native-v2")
      return runtime.execute(flow, run, token);
    const principal = engine.auth.verify(token);
    for (let i = 0; i < 10; i++) {
      if (stopped.has(run.id)) return;
      engine.store.event(
        flow.id,
        flow.project_id,
        "FixtureOutput",
        { text: `受控测试执行器步骤 ${i + 1}/10` },
        run.id,
      );
      await new Promise((r) => setTimeout(r, 100));
    }
    startTask(engine, principal, flow.id, "T01");
    const files = engine.files(principal, flow.id, "main", true);
    files.broker.apply(files.root, engine.plan(flow.id).plan.scope, [
      {
        path: "app.txt",
        expected_hash: files.broker.read(files.root, "app.txt").hash,
        content: "after\n",
      },
    ]);
    engine.claimTask(
      principal,
      flow.id,
      "T01",
      "测试夹具完成文本修改，真实 Node 测试验证结果",
    );
    await engine.freeze(flow.id, principal);
    await runtime.check(engine.get(flow.id), "UT01", principal);
  },
  async resolveMergeConflict(
    flow: Workflow,
    run: Run,
    request: MergeConflictRequest,
  ) {
    return runtime.resolveMergeConflict(flow, run, request);
  },
  async review(flow: Workflow, run: Run) {
    if (s.store.get("feedback_fixture", flow.id))
      throw new Error("功能反馈不应重新派发审查");
    if (engine.plan(flow.id).plan.task_model === "native-v2")
      return runtime.review(flow, run);
    return {
      schema_version: 1,
      review_request_id: flow.review_request_id,
      workflow_id: flow.id,
      plan_revision: flow.plan_revision,
      snapshot_id: flow.snapshot_id,
      verdict: "pass",
      coverage: {
        all_changed_files_reviewed: true,
        all_requirements_checked: true,
        upstream_downstream_checked: true,
        security_checked: true,
        tests_validity_checked: true,
        files: ["main:app.txt"],
      },
      findings: [],
      unresolved_questions: [],
      repair_plan: null,
      commit_message: "test: 验证确定性交付闭环",
    };
  },
  async stop(run: string) {
    stopped.add(run);
    feedbackExecutions.get(run)?.();
    feedbackExecutions.delete(run);
    await runtime.stop(run);
  },
  check: (flow, test, principal) => runtime.check(flow, test, principal),
  close: () => runtime.close(),
} satisfies Runtime;
const shutdownToken = crypto.randomUUID();
atomicWrite(
  resolve(".cache/e2e-state.json"),
  JSON.stringify({
    shutdownToken,
    workflow_id: w.id,
    root: s.root,
    repo: repo.repo,
    nativeRepo: nativeRepo.repo,
  }),
);
const app = await buildServer(engine, {
  webRoot: process.env.DEVFLOW_E2E_WEB_ROOT,
});
const dispatchTimer = setInterval(() => void engine.dispatch(), 1000);
dispatchTimer.unref();
app.post("/__fixture/source-change", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  return seedSourceChange(engine, s.root);
});
app.post("/__fixture/attachments", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  const suffix = crypto.randomUUID();
  const isolated = await repository(s.root, "attachments-" + suffix);
  const attachmentProject = { ...project(isolated.repo), id: "attachments-" + suffix, name: "附件异步归档回归" };
  await engine.registerProject(attachmentProject);
  const flow = engine.create({ project_id: attachmentProject.id, title: "附件异步状态刷新", request: "展示附件状态", complexity: "simple", workspace_mode: "existing_workspace" }, "attachments-" + suffix);
  const attachmentPlan = plan(objectHash(attachmentProject), isolated.baseline);
  attachmentPlan.task_model = "native-v2";
  engine.submitPlan(flow.id, attachmentPlan, flow.version, "attachment-plan");
  engine.transition(flow.id, [engine.get(flow.id).state], "HUMAN_PENDING", "manual_acceptance");
  s.store.put("workspace", "ws-" + flow.id, flow.id, {
    id: "ws-" + flow.id, workflow_id: flow.id, repo_id: "main", root: isolated.repo,
    common_dir: join(isolated.repo, ".git"), branch: "task/fixture", baseline: isolated.baseline, owned: false,
  });
  mkdirSync(join(isolated.repo, ".reports"), { recursive: true });
  writeFileSync(join(isolated.repo, ".reports", "async.json"), '{"owner":"' + flow.id + '"}');
  const deliveryId = "attachment-del-" + suffix;
  const manifest = { artifacts: [".reports/async.json", ".reports/missing.json", { path: { bad: true } }] };
  s.store.put("delivery", deliveryId, flow.id, {
    id: deliveryId, workflow_id: flow.id, run_id: "attachment-run-" + suffix,
    plan_revision: 1, plan_hash: engine.get(flow.id).plan_hash, status: "passed", submitted_at: new Date().toISOString(), manifest,
    attachment_status: [{ delivery_id: deliveryId, repo_id: "main", path: { bad: true }, state: "pending" }],
  });
  for (const path of [".reports/async.json", ".reports/missing.json"])
    s.store.put("attachment_archive", attachmentArchiveKey(deliveryId, "main", path), flow.id,
      { delivery_id: deliveryId, repo_id: "main", path, state: "pending" });
  return { workflow_id: flow.id, delivery_id: deliveryId };
});
app.post("/__fixture/attachments/drain", async (request, reply) => {
  const input = request.body as { token?: string; workflow_id: string; delivery_id: string };
  if (input.token !== shutdownToken) return reply.code(403).send({ ok: false });
  const delivery = s.store.get<any>("delivery", input.delivery_id);
  if (!delivery || delivery.workflow_id !== input.workflow_id) return reply.code(404).send({ ok: false });
  createArchiveJobFromManifest(s.store, { deliveryId: delivery.id, workflowId: delivery.workflow_id, runId: delivery.run_id, manifest: delivery.manifest });
  void drainArchiveOutbox(s.store, { storageRoot: s.config.storage_root });
  return { ok: true };
});
app.post("/__fixture/feedback", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  const suffix = crypto.randomUUID();
  const isolated = await repository(s.root, "feedback-" + suffix);
  const feedbackProject = { ...project(isolated.repo), id: "feedback-" + suffix, name: "人工反馈回归" };
  await engine.registerProject(feedbackProject);
  const flow = engine.create({ project_id: feedbackProject.id, title: "完成审查后反馈功能问题", request: "根据人工反馈修复功能", complexity: "simple", workspace_mode: "existing_workspace" }, "feedback-" + suffix);
  const approvedPlan = plan(objectHash(feedbackProject), isolated.baseline);
  approvedPlan.task_model = "native-v2";
  engine.submitPlan(flow.id, approvedPlan, flow.version, "feedback-plan");
  const current = engine.get(flow.id);
  s.store.put("approval", flow.id + "-1", flow.id, { plan_hash: current.plan_hash, revision: 1, approved_at: new Date().toISOString() });
  const reviewId = "completed-review-" + suffix;
  s.store.put("run", reviewId, flow.id, {
    id: reviewId, workflow_id: flow.id, plan_revision: 1, adapter: "codex", protocol: "lightweight",
    purpose: "quality_review", stage: "quality_before_human", status: "completed", exit_code: 0,
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(), package_hash: "fixture",
  });
  s.store.put("plan_check_review_intent", flow.id, flow.id, { phase: "before_human", review_run_id: reviewId });
  s.store.put("feedback_fixture", flow.id, flow.id, { seeded_review_run_id: reviewId });
  engine.transition(flow.id, [current.state], "HUMAN_PENDING", "manual_acceptance", { run_id: reviewId });
  return { workflow_id: flow.id, review_run_id: reviewId };
});
app.post("/__fixture/feedback/stop", async (request, reply) => {
  const input = request.body as { token?: string; workflow_id: string };
  if (input.token !== shutdownToken) return reply.code(403).send({ ok: false });
  if (!s.store.get("feedback_fixture", input.workflow_id)) return reply.code(404).send({ ok: false });
  await engine.stop(input.workflow_id, "local_console");
  return { ok: true };
});
app.post("/__fixture/shutdown", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  setTimeout(
    () =>
      void (async () => {
        for (const socket of app.websocketServer.clients) socket.terminate();
        await engine.runtime!.close();
        await app.close();
        s.store.close();
        process.exit(0);
      })(),
    100,
  );
  return { ok: true };
});
await app.listen({ host: "127.0.0.1", port: 14811 });
console.log("Fixture listening on 14811");
process.once(
  "SIGTERM",
  () =>
    void (async () => {
      await engine.runtime!.close();
      await app.close();
      s.store.close();
    })(),
);
