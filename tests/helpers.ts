import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../packages/store/src/store.js";
import { Engine } from "../packages/core/src/engine.js";
import { ConfigSchema } from "../packages/contracts/src/config.js";
import {
  ProjectSchema,
  PlanSchema,
  type Plan,
} from "../packages/contracts/src/index.js";
import { hash, objectHash, now } from "../packages/core/src/util.js";
import { git } from "../packages/git/src/git.js";
import {
  ensureTestInstanceDirs,
  loadTestInstanceConfig,
  usesIsolatedTestRoot,
} from "./helpers/test-isolation.js";
export function setup() {
  process.env.DEVFLOW_ACCOUNT_SCOPE = process.env.DEVFLOW_ACCOUNT_SCOPE || "test-account-fixture";
  const isolated = usesIsolatedTestRoot();
  const instance = loadTestInstanceConfig();
  if (isolated) ensureTestInstanceDirs(instance);
  const root = isolated
    ? instance.runDirResolved
    : mkdtempSync(join(tmpdir(), "devflow-test-"));
  const config = ConfigSchema.parse({
    storage_root: isolated ? instance.storageRoot : join(root, "state"),
    workspace_root: isolated ? instance.workspaceRoot : join(root, "worktrees"),
    server: isolated
      ? { port: instance.port, human_origin: instance.humanOrigin }
      : { port: 14810, human_origin: "http://localhost:14810" },
    host: { required: false },
  });
  const store = new Store(
    isolated ? instance.sqliteFile : join(root, "state", "devflow.sqlite"),
  );
  const engine = new Engine(store, config);
  return { root, store, engine, config };
}
export async function repository(root: string, name = "repo") {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "task/fixture"]);
  await git(repo, ["config", "user.name", "DevFlow Tests"]);
  await git(repo, ["config", "user.email", "tests@example.invalid"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(repo, "app.txt"), "before\n");
  writeFileSync(join(repo, ".gitignore"), ".reports/\n");
  await git(repo, ["add", "."]);
  const dirty = await git(repo, ["status", "--porcelain"]);
  if (dirty.trim()) await git(repo, ["commit", "-m", "fixture baseline"]);
  return { repo, baseline: await git(repo, ["rev-parse", "HEAD"]) };
}
export function project(root: string) {
  return ProjectSchema.parse({
    id: "p1",
    name: "测试项目",
    repositories: [{ id: "main", path: root }],
    commands: [
      {
        id: "unit",
        executable: process.execPath,
        args: [],
        parser: "vitest_json",
        report_path: ".reports/unit.json",
      },
    ],
    git: {
      author_name: "DevFlow Tests",
      author_email: "tests@example.invalid",
    },
  });
}
export function plan(projectHash: string, baseline: string): Plan {
  return PlanSchema.parse({
    markdown:
      "# 变更计划\n\n仅将 app.txt 改成 after，保持其余文件不变。这是确定的局部变更，单元测试验证结果。\n\n```mermaid\nflowchart LR\n A[读取现状] --> B[局部修改] --> C[验证行为]\n```\n",
    complexity: "simple",
    reason: "单文件局部任务",
    decisions: [
      { question: "修改范围", answer: "仅 app.txt", source: "用户需求" },
    ],
    unresolved_decisions: [],
    scope: { allowed_paths: ["app.txt"] },
    tasks: [
      {
        id: "T01",
        title: "修改文本",
        requirements: ["R01"],
        depends_on: [],
        paths: ["app.txt"],
        inputs: "当前文本",
        implementation: "将 before 改成 after 并保留换行",
        preserve: "其余文件不改",
        completion: "检查结果必须是 after",
        test_ids: ["UT01"],
        stop_conditions: "文件变化则停止",
      },
    ],
    tests: [
      {
        id: "UT01",
        task_ids: ["T01"],
        layer: "unit",
        command_id: "unit",
        steps: ["读取文本"],
        assertions: ["内容为 after"],
        expected_case_ids: ["updates content"],
      },
    ],
    exemptions: [
      { layer: "integration", reason: "本测试夹具没有外部接口或集成边界" },
      { layer: "e2e", reason: "本测试夹具没有端到端应用运行入口" },
      { layer: "opentabs", reason: "本测试夹具为纯文本没有浏览器界面" },
    ],
    baselines: { main: baseline },
    project_config_hash: projectHash,
  });
}
export function proof(engine: Engine, key: string, action: string) {
  const binding = engine.binding(key, action),
    proofId = "proof-" + crypto.randomUUID();
  engine.store.put("human_proof", proofId, "human", {
    action,
    binding: objectHash(binding),
    created_at: now(),
  });
  return { proof: proofId, binding };
}
export async function prepared() {
  const s = setup(),
    r = await repository(s.root);
  const p = project(r.repo);
  await s.engine.registerProject(p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "测试修改",
      request: "修复文本",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "fixture",
  );
  s.engine.submitPlan(
    w.id,
    plan(objectHash(p), r.baseline),
    w.version,
    "plan1",
  );
  const approval = proof(s.engine, w.id, "approve");
  s.engine.approve(w.id, approval.proof, approval.binding);
  await s.engine.git.prepare(p, w.id, w.workspace_mode, { main: r.baseline });
  const current = s.engine.transition(
    w.id,
    ["QUEUED"],
    "EXECUTING",
    "execute",
    { run_id: "run-test" },
  );
  const principal = {
    role: "worker" as const,
    workflow_id: w.id,
    run_id: "run-test",
    expires: Date.now() + 100000,
  };
  return { ...s, ...r, project: p, workflow: current, principal };
}
