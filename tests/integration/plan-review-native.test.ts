import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { setup, repository, project } from "../helpers.js";
import { objectHash, hash, now } from "../../packages/core/src/util.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { DocumentService } from "../../packages/core/src/document-service.js";
import { ExecutionSpecSchema } from "../../packages/contracts/src/execution-spec.js";
import { PlanReviewService } from "../../packages/core/src/plan-review.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";

it("外部提交且无执行工作区的计划可问答和修正，排队问答仍读取提问时的版本", async () => {
  const s = setup(),
    repo = await repository(s.root),
    p = project(repo.repo);
  s.store.put("project", p.id, "global", p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "外部计划",
      request: "修改文本",
      complexity: "simple",
      workspace_mode: "new_worktree",
    },
    "external",
  );
  const markdown = "# 正式计划\n\n## 仅正文包含的约束\n必须保留其他文件。\n";
  new DocumentService(s.store, s.root).publishDocument(
    w.id,
    "plan",
    markdown,
    1,
  );
  s.engine.submitPlan(
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
    "external-plan",
  );
  const planner = {
    id: "planner",
    adapterId: "codex",
    executableRef: process.execPath,
    modelSelection: "explicit",
    modelId: "fixture-planner",
    options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
  };
  const spec = ExecutionSpecSchema.parse({
    id: "spec",
    workflow_id: w.id,
    revision: 1,
    plannerProfile: planner,
    executorProfile: {
      ...planner,
      id: "executor",
      modelId: "fixture-executor",
    },
    mode: "single_tool",
    template_id: "native-development",
    template_revision: 1,
    created_at: now(),
  });
  s.store.put("execution_spec", spec.id, w.id, spec);
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  const review = new PlanReviewService(s.engine);
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 45000;
    while (!predicate() && Date.now() < deadline) {
      await s.engine.dispatch();
      if (s.engine.get(w.id).state === "BLOCKED")
        throw Error(JSON.stringify(s.engine.get(w.id).blocker));
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(predicate()).toBe(true);
  };
  try {
    // Occupy the aside slot so the question is answered after a new plan exists.
    const asides = new AsideSessionService(s.store);
    const occupied = asides.submitQuestion("other-workflow", "占位");
    for (const job of s.store.jobs()) s.store.jobStatus(job.id, "delivered");
    const before = s.engine.get(w.id);
    const question = review.question(w.id, {
      request_id: "ask",
      plan_revision: 1,
      plan_hash: before.plan_hash,
      text: "正文有哪些约束？",
    });
    expect(question.status).toBe("queued");
    expect(s.engine.get(w.id)).toEqual(before);
    review.reject(w.id, {
      request_id: "reject",
      expected_version: before.version,
      plan_revision: 1,
      plan_hash: before.plan_hash,
      text: "补充第二版回滚方案",
    });
    await wait(() => s.engine.get(w.id).state === "REPAIR_PLAN_PENDING");
    await s.engine.waitForIdle(w.id);
    const revised = s.engine.get(w.id);
    expect(revised.plan_revision).toBe(2);
    asides.completeSession("other-workflow", occupied.id, "释放槽位");
    await wait(
      () =>
        s.store.must<any>("aside_session", question.id).status === "completed",
    );
    const answered = s.store.must<any>("aside_session", question.id);
    expect(answered.answer).toContain("计划版本：1");
    expect(answered.answer).toContain("仅正文包含的约束");
    expect(answered.answer).not.toContain("补充第二版回滚方案");
    expect(s.engine.get(w.id)).toEqual(revised);
    expect(s.store.list("workspace", w.id)).toHaveLength(0);
    expect(s.store.list("approval", w.id)).toHaveLength(0);
    const runs = s.store.list<any>("run", w.id);
    expect(runs.map((r) => r.stage)).toEqual(["planning", "aside"]);
    expect(runs.every((r) => r.profile.modelId === "fixture-planner")).toBe(
      true,
    );
    expect(runs[1].plan_revision).toBe(1);
    expect(readFileSync(join(repo.repo, "app.txt"), "utf8")).toBe("before\n");
    const handoff = JSON.parse(
      readFileSync(
        join(s.config.storage_root, "native-runs", runs[0].id, "HANDOFF.json"),
        "utf8",
      ),
    );
    expect(handoff.current_plan.markdown).toBe(markdown);
    expect(handoff.feedback[0].text).toBe("补充第二版回滚方案");
  } finally {
    await s.engine.waitForIdle(w.id);
    await runtime.close();
    s.store.close();
  }
});
