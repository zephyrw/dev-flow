import { expect, it } from "vitest";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setup, repository, project } from "../helpers.js";
import { objectHash, hash, now } from "../../packages/core/src/util.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { DocumentService } from "../../packages/core/src/document-service.js";
import { ExecutionSpecSchema } from "../../packages/contracts/src/execution-spec.js";
import { PlanReviewService } from "../../packages/core/src/plan-review.js";

function fixtureHandoff(root: string, name: string) {
  const directory = join(root, name);
  mkdirSync(directory);
  const file = join(directory, "HANDOFF.json");
  writeFileSync(file, JSON.stringify({
    baselines: { main: name },
    project_config_hash: name,
    current_plan: { markdown: "# 正式计划" },
    feedback: [{ text: `旧反馈-${name}` }],
    question: {},
  }));
  return realpathSync(file);
}

function invokeFixture(root: string, prompt: string, resumeId?: string, stage = "planning") {
  const invocation = spawnSync(process.execPath, [
    resolve("tests/fixtures/native-cli.mjs"), "exec",
    ...(resumeId ? ["resume", resumeId] : []), "-p", prompt,
  ], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DEVFLOW_"))),
      DEVFLOW_STAGE: stage,
    },
  });
  if (invocation.error) throw invocation.error;
  const events = invocation.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const sessionId = events.find(event => event.type === "thread.started")?.thread_id as string | undefined;
  const message = events.find(event => event.item?.type === "agent_message")?.item.text;
  return { ...invocation, sessionId, result: message ? JSON.parse(message) : undefined };
}

it("首轮即登记会话，其他规划及问答覆盖 last-prompt 后首次续接仍恢复原件", () => {
  const root = mkdtempSync(join(tmpdir(), "devflow-fixture-session-"));
  try {
    const original = fixtureHandoff(root, "original");
    const other = fixtureHandoff(root, "other");
    const first = invokeFixture(root, `任务工作包及唯一正式计划材料：${original}。先读取当前工作包。`);
    expect(first.status).toBe(0);
    expect(first.sessionId).toBeTruthy();
    const sessionId = first.sessionId!;
    const sidecar = join(root, `.devflow-fixture-${sessionId}.json`);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toMatchObject({ sessionId, handoffFile: original });
    expect(invokeFixture(root, `任务工作包：${other}。先读取当前工作包。`).status).toBe(0);
    const aside = invokeFixture(root, `请读取工作包 ${other}。必须只读。`, undefined, "aside");
    expect(aside.status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, ".devflow-fixture-last-prompt.json"), "utf8")).sessionId).toBe(aside.sessionId);

    const feedback = "任务工作包：保留文件要求没落实，请补齐本轮说明";
    const resumed = invokeFixture(root, feedback, sessionId);
    expect(resumed.status).toBe(0);
    expect(resumed.sessionId).toBe(sessionId);
    expect(resumed.result.plan.baselines).toEqual({ main: "original" });
    expect(resumed.result.plan.project_config_hash).toBe("original");
    expect(resumed.result.markdown).toContain(feedback);
    expect(resumed.result.markdown).not.toContain("旧反馈-");

    // A bound session may receive a new formal HANDOFF at a stage boundary.
    const stageStart = invokeFixture(root, `任务工作包及唯一正式计划材料：${other}。先读取当前工作包。`, sessionId);
    expect(stageStart.status).toBe(0);
    expect(stageStart.sessionId).toBe(sessionId);
    expect(stageStart.result.plan.baselines).toEqual({ main: "other" });
    const next = invokeFixture(root, "任务工作包里的要求仍需补齐", sessionId);
    expect(next.status).toBe(0);
    expect(next.result.plan.baselines).toEqual({ main: "other" });
    expect(next.result.markdown).toContain("任务工作包里的要求仍需补齐");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["unknown_id", "FIXTURE_SESSION_UNAVAILABLE"],
  ["missing", "FIXTURE_SESSION_UNAVAILABLE"],
  ["mismatch", "FIXTURE_SESSION_MISMATCH"],
  ["malformed", "FIXTURE_SESSION_UNAVAILABLE"],
  ["original_missing", "FIXTURE_HANDOFF_UNAVAILABLE"],
  ["location_mismatch", "FIXTURE_HANDOFF_LOCATION_MISMATCH"],
  ["invalid_id", "FIXTURE_SESSION_INVALID"],
] as const)("续接 %s 时明确失败，不能从 last-prompt 或新正式路径绕过会话绑定", (failure, errorCode) => {
  const root = mkdtempSync(join(tmpdir(), "devflow-fixture-session-failure-"));
  try {
    const original = fixtureHandoff(root, "original");
    const other = fixtureHandoff(root, "other");
    const first = invokeFixture(root, `任务工作包：${original}。先读取当前工作包。`);
    expect(first.status).toBe(0);
    expect(first.sessionId).toBeTruthy();
    const sessionId = first.sessionId!;
    const sidecar = join(root, `.devflow-fixture-${sessionId}.json`);
    if (failure === "missing") rmSync(sidecar);
    if (failure === "mismatch") {
      const record = JSON.parse(readFileSync(sidecar, "utf8"));
      writeFileSync(sidecar, JSON.stringify({ ...record, sessionId: randomUUID() }));
    }
    if (failure === "malformed") writeFileSync(sidecar, "{");
    if (failure === "original_missing") rmSync(original);
    if (failure === "location_mismatch") {
      const record = JSON.parse(readFileSync(sidecar, "utf8"));
      writeFileSync(sidecar, JSON.stringify({ ...record, handoffFile: `${root}/original/../original/HANDOFF.json` }));
    }
    // There is a usable, unrelated diagnostic capture in the same root.
    expect(invokeFixture(root, `任务工作包：${other}。先读取当前工作包。`).status).toBe(0);
    const requestedSession = failure === "invalid_id"
      ? "not-a-session-id"
      : failure === "unknown_id" ? randomUUID() : sessionId;
    for (const prompt of ["任务工作包：请修正本轮计划", `任务工作包：${other}。先读取当前工作包。`]) {
      const resumed = invokeFixture(root, prompt, requestedSession);
      expect(resumed.status).not.toBe(0);
      expect(resumed.stderr).toContain(errorCode);
      expect(resumed.sessionId).toBeUndefined();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  for (const es of s.store.list<any>("execution_spec", w.id)) {
    s.store.remove("execution_spec", es.id);
  }
  s.store.put("execution_spec", spec.id, w.id, spec);
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  const review = new PlanReviewService(s.engine);
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 30000;
    while (!predicate() && Date.now() < deadline) {
      await s.engine.dispatch();
      if (s.engine.get(w.id).state === "BLOCKED")
        throw Error(JSON.stringify(s.engine.get(w.id).blocker));
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(predicate()).toBe(true);
  };
  try {
    // Hold the pending dispatch job to reproduce a question waiting while the
    // original plan changes; there is no global one-question capacity limit.
    for (const job of s.store.jobs()) s.store.jobStatus(job.id, "delivered");
    const before = s.engine.get(w.id);
    const question = review.question(w.id, {
      request_id: "ask",
      plan_revision: 1,
      plan_hash: before.plan_hash,
      text: "正文有哪些约束？",
    });
    expect(question.status).toBe("active");
    for (const job of s.store.jobs()) {
      if (JSON.parse(job.data).aside_id === question.id) s.store.jobStatus(job.id, "delivered");
    }
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
    const initialRun = s.store.list<{ id: string; purpose: string }>("run", w.id).find(run => run.purpose === "planning")!;
    const initialInput = JSON.parse(readFileSync(join(s.config.storage_root, "native-runs", initialRun.id, "input.json"), "utf8"));
    expect(initialInput).toMatchObject({ kind: "stage_start", user_input: false });
    expect(initialInput.text).toContain(join(s.config.storage_root, "native-runs", initialRun.id, "HANDOFF.json"));
    expect(initialInput.text).toContain("补充第二版回滚方案");
    const followupTexts = [
      "任务工作包里的保留文件要求没落实，请补齐第三版说明",
      "任务工作包：保留文件要求没落实，请补齐第四版说明",
    ];
    for (const [index, text] of followupTexts.entries()) {
      const current = s.engine.get(w.id);
      review.reject(w.id, {
        request_id: `reject-again-${index}`,
        expected_version: current.version,
        plan_revision: current.plan_revision,
        plan_hash: current.plan_hash,
        text,
      });
      await wait(() => {
        const updated = s.engine.get(w.id);
        return updated.state === "REPAIR_PLAN_PENDING" && updated.plan_revision === index + 3;
      });
      await s.engine.waitForIdle(w.id);
      const document = new DocumentService(s.store, s.root).getDocument(w.id, "plan");
      expect(document.content).toContain(text);
      expect(document.content).not.toContain("补充第二版回滚方案");
    }
    const latest = s.engine.get(w.id);
    s.store.enqueue(w.id, "dispatch_run", { workflow_id: w.id, aside_id: question.id, purpose: "aside" });
    await wait(
      () =>
        s.store.must<any>("aside_session", question.id).status === "completed",
    );
    const answered = s.store.must<any>("aside_session", question.id);
    expect(answered.answer).toContain("计划版本：1");
    expect(answered.answer).toContain("仅正文包含的约束");
    expect(answered.answer).not.toContain("补充第二版回滚方案");
    expect(s.engine.get(w.id)).toEqual(latest);
    expect(s.store.list("workspace", w.id)).toHaveLength(0);
    expect(s.store.list("approval", w.id)).toHaveLength(0);
    const runs = s.store.list<any>("run", w.id);
    expect(runs.map((r) => r.stage)).toEqual(["planning", "planning", "planning", "aside"]);
    expect(runs.every((r) => r.profile.modelId === "fixture-planner")).toBe(
      true,
    );
    expect(runs[1].conversation_id).toBe(runs[0].conversation_id);
    expect(runs[2].conversation_id).toBe(runs[0].conversation_id);
    for (const [index, text] of followupTexts.entries()) {
      const input = JSON.parse(readFileSync(join(s.config.storage_root, "native-runs", runs[index + 1].id, "input.json"), "utf8"));
      expect(input).toMatchObject({ kind: "followup", user_input: true, text });
    }
    expect(runs[3].plan_revision).toBe(1);
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
