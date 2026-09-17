import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Engine } from "../../packages/core/src/engine.js";
import { DocumentService } from "../../packages/core/src/document-service.js";
import { ExecutionSpecSchema } from "../../packages/contracts/src/execution-spec.js";
import { hash, id, now, objectHash } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";
import { repository, project, proof } from "../helpers.js";

export async function seedSourceChange(engine: Engine, root: string) {
  const folder = join(root, id("source-case"));
  mkdirSync(folder, { recursive: true });
  const repo = await repository(folder),
    p = {
      ...project(repo.repo),
      id: id("source-project"),
      name: "代码更新处理测试",
    };
  engine.store.put("project", p.id, "global", p);
  const w = engine.create(
    {
      project_id: p.id,
      title: "处理项目代码更新",
      request: "修改 app.txt",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    id("source-create"),
  );
  const markdown = "# 正式计划\n\n将 app.txt 改为 after，保留其他文件。\n";
  new DocumentService(engine.store, engine.config.storage_root).publishDocument(
    w.id,
    "plan",
    markdown,
    1,
  );
  engine.submitPlan(
    w.id,
    {
      task_model: "native-v2",
      revision: 1,
      design_ref: { content_hash: hash(markdown), summary: "修改文本" },
      modules: [{ id: "M01", title: "文本" }],
      work_items: [
        {
          id: "T01",
          module_id: "M01",
          repo_id: "main",
          title: "修改文本",
          paths: ["app.txt"],
          depends_on: [],
          acceptance_ids: ["UT01"],
        },
      ],
      acceptance_items: [
        {
          id: "UT01",
          work_item_ids: ["T01"],
          layer: "unit",
          scenario: "updates content",
          expected_outcome: "after 加换行",
        },
      ],
      scope: { allowed_paths: ["app.txt"] },
      baselines: { main: repo.baseline },
      project_config_hash: objectHash(p),
    },
    w.version,
    id("source-plan"),
  );
  const profile = {
    id: "fixture-source-planner",
    adapterId: "codex",
    executableRef: process.execPath,
    modelSelection: "explicit",
    modelId: "fixture-only",
    options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
  };
  const spec = ExecutionSpecSchema.parse({
    id: id("spec"),
    workflow_id: w.id,
    revision: 1,
    plannerProfile: profile,
    executorProfile: { ...profile, id: "fixture-source-executor" },
    mode: "single_tool",
    template_id: "native-development",
    template_revision: 1,
    created_at: now(),
  });
  engine.store.put("execution_spec", spec.id, w.id, spec);
  writeFileSync(join(repo.repo, "context.txt"), "new committed context\n");
  await git(repo.repo, ["add", "context.txt"]);
  await git(repo.repo, ["commit", "-m", "补充项目说明"]);
  const current = await git(repo.repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo.repo, "personal.txt"), "用户未提交的内容\n");
  let preparationError: unknown;
  try {
    await engine.git.prepare(p, w.id, w.workspace_mode, {
      main: repo.baseline,
    });
  } catch (error) {
    preparationError = error;
  }
  if (!preparationError) throw Error("Fixture expected a changed-code failure");
  const approval = proof(engine, w.id, "approve");
  engine.approve(w.id, approval.proof, approval.binding);
  engine.block(w.id, preparationError);
  return { id: w.id, repo: repo.repo, old: repo.baseline, current, project: p };
}
