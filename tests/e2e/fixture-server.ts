import { startTask } from "../../packages/core/src/progress.js";
import { writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setup, repository, project, plan } from "../helpers.js";
import {
  assertTestPortAvailable,
  ensureTestInstanceDirs,
  loadTestInstanceConfig,
} from "../helpers/test-isolation.js";
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
const instance = loadTestInstanceConfig();
ensureTestInstanceDirs(instance);
for (const file of [
  instance.sqliteFile,
  `${instance.sqliteFile}-wal`,
  `${instance.sqliteFile}-shm`,
]) {
  if (existsSync(file)) unlinkSync(file);
}
const s = setup();
s.config.server.port = instance.port;
s.config.server.human_origin = instance.humanOrigin;
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
const verifyDirty = await git(repo.repo, [
  "status",
  "--porcelain",
  "--",
  "verify.cjs",
]);
if (verifyDirty.trim())
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
// Only this test entrypoint injects a deterministic adapter. The production server has no switch for it.
engine.runtime = {
  plan: (w, r) => runtime.plan(w, r),
  aside: (w, r, q) => runtime.aside(w, r, q),
  async execute(flow: Workflow, run: Run, token: string) {
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
    await runtime.stop(run);
  },
  stopConversation: (target: any) => (runtime as any).stopConversation(target),
  check: (flow, test, principal) => runtime.check(flow, test, principal),
  close: () => runtime.close(),
} satisfies Runtime;
const shutdownToken = crypto.randomUUID();
atomicWrite(
  instance.stateFile,
  JSON.stringify({
    shutdownToken,
    workflow_id: w.id,
    root: s.root,
    repo: repo.repo,
    nativeRepo: nativeRepo.repo,
    port: instance.port,
    humanOrigin: instance.humanOrigin,
    stateFile: instance.stateFile,
    sqliteFile: join(s.config.storage_root, "devflow.sqlite"),
    runDir: instance.usesCustomRunDir ? instance.runDirResolved : undefined,
  }),
);
const app = await buildServer(engine, {
  webRoot:
    process.env.DEVFLOW_E2E_WEB_ROOT ||
    resolve(fileURLToPath(new URL("../../dist/web", import.meta.url))),
});
const dispatchTimer = setInterval(() => void engine.dispatch(), 1000);
dispatchTimer.unref();
app.post("/__fixture/source-change", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  return seedSourceChange(engine, s.root);
});
function writeNativeFixtureFile(dir: string, payload: string) {
  try {
    writeFileSync(join(dir, ".devflow-test-fixture.json"), payload);
  } catch {}
}

function syncNativeFixtureOptions(options: unknown) {
  const payload = JSON.stringify(options);
  writeNativeFixtureFile(nativeRepo.repo, payload);
  const worktrees = instance.workspaceRoot;
  if (!existsSync(worktrees)) return;
  for (const name of readdirSync(worktrees)) {
    writeNativeFixtureFile(join(worktrees, name), payload);
  }
}

app.post("/__fixture/native-options", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  const options = (request.body as { options?: unknown }).options ?? {};
  syncNativeFixtureOptions(options);
  const target = join(nativeRepo.repo, ".devflow-test-fixture.json");
  await git(nativeRepo.repo, ["add", "-f", ".devflow-test-fixture.json"]);
  const dirty = await git(nativeRepo.repo, [
    "status",
    "--porcelain",
    "--",
    ".devflow-test-fixture.json",
  ]);
  if (dirty.trim())
    await git(nativeRepo.repo, ["commit", "-m", "test fixture options"]);
  return { ok: true, path: target };
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
await assertTestPortAvailable(instance.port);
await app.listen({ host: "127.0.0.1", port: instance.port });
console.log("Fixture listening on " + instance.port);
process.once(
  "SIGTERM",
  () =>
    void (async () => {
      await engine.runtime!.close();
      await app.close();
      s.store.close();
    })(),
);
