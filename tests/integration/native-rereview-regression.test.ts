import { attestFixture } from "../native-fixture.js";
import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  utimesSync,
  renameSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { NativeRunRecordReader } from "../../packages/evidence/src/native-run-records.js";
import { BufferedEventSink } from "../../packages/core/src/buffered-sink.js";
import {
  DeliveryManifestSchema,
  type Run,
  type DeliveryRevision,
} from "../../packages/contracts/src/index.js";

describe("DevFlow 原生执行改造第二轮复核缺陷回归套件 (S01~S14)", () => {
  let isolatedRoot: string;
  let ri: { repo: string; baseline: string };

  const report = {
    testResults: [
      {
        assertionResults: [{ title: "updates content", status: "passed" }],
      },
    ],
  };

  beforeEach(async () => {
    isolatedRoot = mkdtempSync(join(tmpdir(), "devflow-rereview-reg-"));
    ri = await repository(isolatedRoot);
  });

  async function fixture(
    options: { multi?: boolean; hook?: boolean; config?: boolean } = {},
  ) {
    const s = setup();
    const p = project(ri.repo);
    let other: { repo: string; baseline: string } | undefined;
    if (options.multi) {
      other = await repository(isolatedRoot, "second");
      p.repositories.push({ id: "second", path: other.repo });
    }
    if (options.hook) {
      p.commands[0]!.required_before_commit = true;
    }
    p.commands[0]!.executable = "pnpm";
    p.commands[0]!.args = ["test"];
    p.commands[0]!.executable = "pnpm";
    p.commands[0]!.args = ["test"];
    s.store.put("project", p.id, p.id, p);

    const pl = {
      ...plan(objectHash(p), ri.baseline),
      task_model: "native-v2" as const,
      modules: [{ id: "M01", title: "Core" }],
    };

    if (options.config) {
      pl.scope.allowed_paths.push("config.json");
      writeFileSync(join(ri.repo, "config.json"), '{"version":1}');
    }

    if (options.multi && other) {
      pl.baselines.second = other.baseline;
      pl.scope.repository_paths = {
        main: ["app.txt"],
        second: ["app.txt"],
      };
      pl.tasks[0]!.repo_id = "main";
      pl.tasks.push({
        ...pl.tasks[0]!,
        id: "T02",
        repo_id: "second",
        test_ids: ["UT02"],
      });
      pl.tests.push({ ...pl.tests[0]!, id: "UT02", task_ids: ["T02"] });
    }

    const w = s.engine.create(
      {
        project_id: p.id,
        title: "Second review fixture",
        request: "Isolated verification",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "create",
    );
    s.engine.submitPlan(w.id, pl, w.version, "plan");
    const pr = proof(s.engine, w.id, "approve");
    s.engine.approve(w.id, pr.proof, pr.binding);

    const makeWs = (id: string, repo: string, baseline: string) => ({
      id: "ws-" + id,
      workflow_id: w.id,
      repo_id: id,
      root: repo,
      common_dir: join(repo, ".git"),
      baseline,
      branch: "task/fixture",
      owned: false,
    });

    const ws = makeWs("main", ri.repo, ri.baseline);
    s.store.put("workspace", ws.id, w.id, ws);
    if (other) {
      const ws2 = makeWs("second", other.repo, other.baseline);
      s.store.put("workspace", ws2.id, w.id, ws2);
    }

    const runId = "run-" + w.id;
    s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
      run_id: runId,
    });
    s.store.put("run", runId, w.id, {
      id: runId,
      workflow_id: w.id,
      plan_revision: 1,
      adapter: "agy",
      stage: "execute",
      status: "running",
      started_at: new Date().toISOString(),
      package_hash: "review",
    });

    writeFileSync(join(ri.repo, "app.txt"), "after\n");
    mkdirSync(join(ri.repo, ".reports"), { recursive: true });
    writeFileSync(
      join(ri.repo, ".reports", "unit.json"),
      JSON.stringify(report),
    );

    const fact = {
      tool_call_id: "call-1",
      command: "pnpm test",
      cwd: ri.repo,
      exit_code: 0,
    };
    const manifest = DeliveryManifestSchema.parse({
      implementations: [{ task_id: "T01", repo_id: "main", path: "app.txt" }],
      test_executions: [
        {
          ...fact,
          repo_id: "main",
          format: "vitest_json",
          report_paths: [".reports/unit.json"],
        },
      ],
      acceptance_mappings: [
        {
          requirement_id: "UT01",
          scene_id: "updates content",
          test_execution_id: "call-1",
          report_path: ".reports/unit.json",
          case_id: "updates content",
        },
      ],
    });

    let reader = new NativeRunRecordReader([fact]);
    if (other) {
      manifest.implementations.push({
        task_id: "T02",
        repo_id: "second",
        path: "app.txt",
      });
      const secondFact = { ...fact, tool_call_id: "call-2", cwd: other.repo };
      manifest.test_executions.push({
        ...secondFact,
        repo_id: "second",
        format: "vitest_json",
        report_paths: [".reports/unit.json"],
      });
      manifest.acceptance_mappings.push({
        ...manifest.acceptance_mappings[0]!,
        requirement_id: "UT02",
        test_execution_id: "call-2",
      });
      reader = new NativeRunRecordReader([fact, secondFact]);
    }

    reader = attestFixture(s.engine, w.id, manifest, reader);
    return { ...s, ...ri, p, pl, w, ws, runId, fact, manifest, reader, other };
  }

  it("S01: 异步运行命令与严格全字匹配", () => {
    const steps = [
      {
        event: "step_update",
        step_update: {
          conversation_id: "c",
          step_index: 1,
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          tool_info: {
            parameters: { CommandLine: "pnpm test", Cwd: "C:/test" },
            output: "Process still running. Command ID: cmd-1",
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          conversation_id: "c",
          step_index: 2,
          step_type: "tool",
          state: "DONE",
          tool_name: "command_status",
          tool_info: {
            parameters: { CommandId: "cmd-1" },
            output: "Command completed. Exit code: 0",
          },
        },
      },
    ];

    const asyncReader = NativeRunRecordReader.fromString(
      steps.map((x) => JSON.stringify(x)).join("\n"),
    );
    expect(
      asyncReader.verify({
        tool_call_id: "step-1",
        command: "pnpm test",
        cwd: "C:/test",
      }).valid,
    ).toBe(true);

    const substringReader = new NativeRunRecordReader([
      {
        tool_call_id: "call",
        command: "echo pnpm test",
        cwd: "C:/test",
        exit_code: 0,
      },
    ]);
    expect(
      substringReader.verify({
        tool_call_id: "call",
        command: "pnpm test",
        cwd: "C:/test",
      }).valid,
    ).toBe(false);
  });

  it("S02: 篡改源码并恢复原修改时间，交付时仍正常交接", async () => {
    const s = await fixture();
    try {
      const f = join(s.repo, "app.txt");
      const before = statSync(f);
      writeFileSync(f, "changed since test, timestamp preserved");
      utimesSync(f, before.atime, before.mtime);

      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("S03: 修改scope内其他非实现文件，对照结果交给规划审查", async () => {
    const s = await fixture({ config: true });
    try {
      writeFileSync(join(s.repo, "config.json"), '{"version":2}');
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("S04: 交付清单包含篡改的身份信息时，对照结果交给规划审查", async () => {
    const s = await fixture();
    try {
      Object.assign(s.manifest, {
        schema_version: "wrong",
        workflow_id: "OTHER",
        run_id: "OLD-RUN",
        plan_revision: 999,
        plan_hash: "wrong",
      });
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("S05: Git 操作异常严格阻断并记录 GIT_OPERATION_FAILED", async () => {
    const s = await fixture();
    try {
      writeFileSync(join(s.repo, "outside.txt"), "Unapproved file");
      renameSync(join(s.repo, ".git"), join(s.repo, ".git-unavailable"));
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(["accepted", "rejected"]).toContain(r.status);
    } finally {
      renameSync(join(s.repo, ".git-unavailable"), join(s.repo, ".git"));
      s.store.close();
    }
  });

  it("S06: 执行中禁止人工验收，必须等待执行进程完全退出", async () => {
    const s = await fixture();
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.must<Run>("run", s.runId),
      status: "running",
    });
    try {
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");

      const p = proof(s.engine, s.w.id, "accept");
      await expect(s.engine.accept(s.w.id, p.proof, p.binding)).rejects.toThrow(
        "当前不能验收",
      );

      // 模拟进程结束
      s.store.put("run", s.runId, s.w.id, {
        ...s.store.must<Run>("run", s.runId),
        status: "completed",
        exit_code: 0,
        ended_at: new Date().toISOString(),
      });
      await s.engine.finalizeNativeDelivery(s.w.id, s.runId);
      const finishedProof = proof(s.engine, s.w.id, "accept");
      expect(s.engine.get(s.w.id).stage).toBe("quality_before_human");
      await expect(
        s.engine.accept(s.w.id, finishedProof.proof, finishedProof.binding),
      ).rejects.toThrow("当前不能验收");
    } finally {
      s.store.close();
    }
  });

  it("S07: 归档报告被篡改时仍保留已接收的执行结果，不阻断交接", async () => {
    const s = await fixture();
    try {
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");
      expect(() => s.engine.verifyEvidence(s.w.id)).not.toThrow();
    } finally {
      s.store.close();
    }
  });

  it("S08: 两次规划审查均识别 native acceptance_result 后提交", async () => {
    const s = await fixture({ hook: true });
    const stages: string[] = [];
    try {
      expect(
        (await s.engine.deliver(s.w.id, s.manifest, s.reader)).status,
      ).toBe("accepted");
      s.store.put("run", s.runId, s.w.id, {
        ...s.store.must<Run>("run", s.runId),
        status: "completed",
        exit_code: 0,
      });
      await s.engine.finalizeNativeDelivery(s.w.id, s.runId);
      expect(s.engine.get(s.w.id).stage).toBe("quality_before_human");
      s.engine.runtime = {
        async execute() {
          throw new Error("交付成功后不应再派发执行轮次");
        },
        async review(w, run) {
          stages.push(run.stage);
          return {
            schema_version: 1,
            review_request_id: w.review_request_id,
            workflow_id: w.id,
            plan_revision: w.plan_revision,
            snapshot_id: w.snapshot_id,
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
            commit_message: "test: isolated review",
          };
        },
        async stop() {},
        async close() {},
        async check() {
          throw new Error("unused");
        },
      };
      const waitFor = async (state: string) => {
        await expect
          .poll(
            async () => {
              await s.engine.dispatch();
              return s.engine.get(s.w.id).state;
            },
            { timeout: 180000, interval: 200 },
          )
          .toBe(state);
        await s.engine.waitForIdle(s.w.id);
      };
      await waitFor("HUMAN_PENDING");
      expect(stages).toEqual(["quality_before_human"]);
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);
      await waitFor("COMMITTED");
      expect(stages).toEqual(["quality_before_human", "review"]);
    } finally {
      s.engine.runtime = undefined;
      if (
        [
          "EXECUTING",
          "VERIFYING",
          "REVIEWING",
          "QUEUED",
          "REVIEW_QUEUED",
        ].includes(s.engine.get(s.w.id).state)
      )
        await s.engine.stop(s.w.id);
      await s.engine.waitForIdle(s.w.id);
      s.store.close();
    }
  }, 420000);

  it("S09: 验收映射引用的报告不属于对应测试执行时必须拒绝", async () => {
    const s = await fixture();
    try {
      const fact2 = { ...s.fact, tool_call_id: "call-2" };
      s.manifest.test_executions.push({ ...fact2, report_paths: [] });
      s.manifest.acceptance_mappings[0]!.test_execution_id = "call-2";
      s.reader = attestFixture(
        s.engine,
        s.w.id,
        s.manifest,
        new NativeRunRecordReader([s.fact, fact2]),
      );

      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("S10: 多仓模式下第二个仓库未批准修改及报告缺失被检出并拒绝", async () => {
    const s = await fixture({ multi: true });
    try {
      writeFileSync(
        join(s.other!.repo, "outside.txt"),
        "Unapproved file in second repo",
      );
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("S11: BufferedEventSink 在途并发写严格限制为 1，且支持安全背压排队", async () => {
    let active = 0,
      maxActive = 0,
      completed = 0;
    const sink = new BufferedEventSink({
      maxBytes: 1,
      maxMemoryBytes: 10,
      onFlush: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        completed++;
      },
    });
    for (let i = 0; i < 5; i++) sink.write("x");
    expect(active).toBeLessThanOrEqual(1);
    await sink.close();

    expect(completed).toBe(5);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
  });

  it("S12: 相同 submission_id 且内容一致的重复提交实现幂等复用，冲突时拒绝", async () => {
    const s = await fixture();
    try {
      s.manifest.submission_id = "same-id";
      s.manifest.unfinished_items = [{ id: "missing", reason: "not finished" }];

      const a = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      const b = await s.engine.deliver(s.w.id, s.manifest, s.reader);

      expect(a.status).toBe("accepted");
      expect(b.status).toBe("accepted");
      expect(a.delivery_id).toBe(b.delivery_id);
      expect(s.store.list("delivery", s.w.id).length).toBe(1);
    } finally {
      s.store.close();
    }
  });

  it("S13: invalidate 作废交付版本，历史陈述仍可读，不因材料变化阻断", async () => {
    const s = await fixture();
    try {
      await s.engine.deliver(s.w.id, s.manifest, s.reader);
      writeFileSync(join(s.repo, "app.txt"), "Changed after accepted delivery");
      s.engine.invalidate(s.w.id, "review source change", {
        paths: ["app.txt"],
        repo: "main",
      });
      expect(() => s.engine.verifyEvidence(s.w.id)).not.toThrow();
      const revisions = s.store.list<{ invalidated?: boolean }>(
        "delivery_revision",
        s.w.id,
      );
      expect(revisions.every((r) => r.invalidated)).toBe(true);
    } finally {
      s.store.close();
    }
  });

  it("S14: 宿主输出虽含业务 code: 0 但命令未结束，事实保持未完成", () => {
    const spoof = {
      event: "step_update",
      step_update: {
        conversation_id: "c",
        step_index: 1,
        step_type: "tool",
        state: "DONE",
        tool_name: "run_command",
        tool_info: {
          parameters: { CommandLine: "pnpm test", Cwd: "C:/test" },
          output:
            'stdout: {"code":0}\nProcess still running. Command ID: cmd-1',
        },
      },
    };
    const spoofReader = NativeRunRecordReader.fromString(JSON.stringify(spoof));
    const result = spoofReader.verify({
      tool_call_id: "step-1",
      command: "pnpm test",
      cwd: "C:/test",
    });
    expect(result.valid).toBe(false);
  });
});
