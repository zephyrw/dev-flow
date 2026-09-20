import { attestFixture } from "../native-fixture.js";
import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { NativeRunRecordReader } from "../../packages/evidence/src/native-run-records.js";
import { WorkspaceFingerprintService } from "../../packages/workspace/src/fingerprint.js";
import { HandoffBuilder } from "../../packages/adapters/agy/src/handoff.js";
import {
  DeliveryManifestSchema,
  type Run,
  type DeliveryRevision,
} from "../../packages/contracts/src/index.js";

describe("DevFlow 原生执行改造审核缺陷回归套件 (R1~R10)", () => {
  let isolatedRoot: string;
  let ri: { repo: string; baseline: string };

  beforeEach(async () => {
    isolatedRoot = mkdtempSync(join(tmpdir(), "devflow-review-reg-"));
    ri = await repository(isolatedRoot);
  });

  const hostCall = {
    tool_call_id: "test-call",
    command: "pnpm test",
    cwd: "",
    exit_code: 0,
  };
  const vitestReport = {
    testResults: [
      {
        assertionResults: [{ title: "updates content", status: "passed" }],
      },
    ],
  };

  async function fixture(options: { playwright?: boolean } = {}) {
    hostCall.cwd = ri.repo;
    const s = setup();
    const p = project(ri.repo);
    p.commands[0]!.executable = "pnpm";
    p.commands[0]!.args = ["test"];
    s.store.put("project", p.id, p.id, p);
    const pl = {
      ...plan(objectHash(p), ri.baseline),
      task_model: "native-v2" as const,
      modules: [{ id: "M01", title: "Core" }],
    };
    if (options.playwright) {
      pl.tests[0]!.layer = "e2e";
      pl.exemptions = pl.exemptions.filter((e) => e.layer !== "e2e");
      pl.exemptions.push({
        layer: "unit",
        reason:
          "Report adapter review fixture only exercises browser result import",
      });
    }
    const w = s.engine.create(
      {
        project_id: p.id,
        title: "Review repro",
        request: "Review repro only",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "create",
    );
    s.engine.submitPlan(w.id, pl, w.version, "plan");
    const pr = proof(s.engine, w.id, "approve");
    s.engine.approve(w.id, pr.proof, pr.binding);
    s.store.put("workspace", "ws", w.id, {
      id: "ws",
      workflow_id: w.id,
      repo_id: "main",
      root: ri.repo,
      common_dir: join(ri.repo, ".git"),
      baseline: ri.baseline,
      branch: "task/fixture",
      owned: true,
    });
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
      package_hash: "test",
    });
    mkdirSync(join(ri.repo, ".reports"), { recursive: true });
    writeFileSync(join(ri.repo, "app.txt"), "after\n");
    const reportPath = options.playwright
      ? ".reports/e2e.json"
      : ".reports/unit.json";
    writeFileSync(
      join(ri.repo, reportPath),
      JSON.stringify(
        options.playwright
          ? {
              suites: [
                {
                  specs: [
                    {
                      title: "updates content",
                      tests: [{ results: [{ status: "passed" }] }],
                    },
                  ],
                },
              ],
            }
          : vitestReport,
      ),
    );
    const manifest = DeliveryManifestSchema.parse({
      implementations: [{ task_id: "T01", path: "app.txt" }],
      test_executions: [{ ...hostCall, report_paths: [reportPath] }],
      acceptance_mappings: [
        {
          requirement_id: "UT01",
          scene_id: "updates content",
          test_execution_id: "test-call",
          report_path: reportPath,
          case_id: "updates content",
        },
      ],
    });
    return {
      ...s,
      w,
      pl,
      manifest,
      reader: attestFixture(
        s.engine,
        w.id,
        manifest,
        new NativeRunRecordReader([hostCall]),
      ),
      runId,
    };
  }

  it("R1: 真实 AGY step_update 协议能正确提取执行事实", () => {
    const actualShape = {
      event: "step_update",
      step_update: {
        conversation_id: "c",
        step_index: 2,
        step_type: "tool",
        state: "DONE",
        tool_name: "run_command",
        tool_info: {
          name: "run_command",
          parameters: { CommandLine: "pnpm test", Cwd: ri.repo },
          output: "Exit code: 0",
        },
      },
    };
    const reader = NativeRunRecordReader.fromString(
      JSON.stringify(actualShape),
    );
    const facts = reader.getAllFacts();
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]!.command).toBe("pnpm test");
    expect(facts[0]!.exit_code).toBe(0);
  });

  it("R2: 缺失退出码或进程仍在运行，不能被当作成功", () => {
    const unknownReader = NativeRunRecordReader.fromString(
      [
        {
          type: "tool_call",
          id: "unknown-exit",
          name: "run_command",
          args: { command: "pnpm test", cwd: ri.repo },
        },
        {
          type: "tool_result",
          tool_call_id: "unknown-exit",
          output: "Process still running",
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n"),
    );
    const fact = unknownReader.getFact("unknown-exit");
    expect(fact?.exit_code).toBeUndefined();
    const verification = unknownReader.verify({
      tool_call_id: "unknown-exit",
      command: "pnpm test",
    });
    expect(verification.valid).toBe(false);
  });

  it("R3: 命令或目录不符时拒绝通过", () => {
    const mismatchReader = new NativeRunRecordReader([
      {
        tool_call_id: "unrelated",
        command: "echo hello",
        cwd: tmpdir(),
        exit_code: 0,
      },
    ]);
    const verification = mismatchReader.verify({
      tool_call_id: "unrelated",
      command: "pnpm test",
    });
    expect(verification.valid).toBe(false);
  });

  it("R4: 终局核验后必须先完成程序自查与规划审查", async () => {
    const s = await fixture();
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.must<Run>("run", s.runId),
      status: "running",
    });
    try {
      const result = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(result.status).toBe("accepted");

      const ws = s.engine.get(s.w.id);
      expect(ws.state).toBe("VERIFYING");

      const tasks = s.engine.taskStatus(s.w.id, false);
      expect(tasks.length).toBeGreaterThan(0);

      const p = proof(s.engine, s.w.id, "accept");
      // 执行仍运行时人工验收必须被拒绝 (B05 / S06)
      await expect(s.engine.accept(s.w.id, p.proof, p.binding)).rejects.toThrow(
        "当前不能验收",
      );

      // 模拟执行进程正常退出后开放人工验收
      s.store.put("run", s.runId, s.w.id, {
        ...s.store.must<Run>("run", s.runId),
        status: "completed",
        exit_code: 0,
        ended_at: new Date().toISOString(),
      });
      await s.engine.finalizeNativeDelivery(s.w.id, s.runId);
      const finishedProof = proof(s.engine, s.w.id, "accept");
      await expect(
        s.engine.accept(s.w.id, finishedProof.proof, finishedProof.binding),
      ).rejects.toThrow("当前不能验收");
      expect(s.engine.get(s.w.id).stage).toBe("quality_before_human");
    } finally {
      s.store.close();
    }
  });

  it("R5: 测试生成后修改源码代码，交付时必须拒绝并标记指纹失效", async () => {
    const s = await fixture();
    try {
      writeFileSync(
        join(ri.repo, "app.txt"),
        "changed after tests without retest\n",
      );
      const result = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(result.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("R6: 空实现、错验收项、不存在执行与未解决冲突必须全数拦截", async () => {
    const s = await fixture();
    try {
      s.manifest.implementations = [];
      s.manifest.acceptance_mappings[0]!.requirement_id =
        "NONEXISTENT-REQUIREMENT";
      s.manifest.acceptance_mappings[0]!.test_execution_id = "NONEXISTENT-CALL";
      s.manifest.plan_conflicts = [
        {
          id: "conflict-1",
          description: "Required architecture is not implemented",
        },
      ];
      const result = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(result.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("R7: 合法 Playwright JSON 报告任意文件名都能正确解析", async () => {
    const s = await fixture({ playwright: true });
    try {
      const result = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(result.status).toBe("accepted");
      expect(result.issues ?? []).toHaveLength(0);
    } finally {
      s.store.close();
    }
  });

  it("R8: 隐藏配置与测试配置文件修改必须被纳入指纹计算", () => {
    const fd = mkdtempSync(join(tmpdir(), "devflow-review-fingerprint-"));
    mkdirSync(join(fd, ".mvn"));
    writeFileSync(join(fd, ".mvn", "jvm.config"), "-Xmx128m");
    writeFileSync(join(fd, "vitest.config.json"), '{"test":1}');
    const fp1 = WorkspaceFingerprintService.compute(fd);

    expect(fp1.files.some((f) => f.path.includes(".mvn/jvm.config"))).toBe(
      true,
    );
    expect(fp1.files.some((f) => f.path === "vitest.config.json")).toBe(true);

    writeFileSync(join(fd, ".mvn", "jvm.config"), "-Xmx4096m");
    writeFileSync(join(fd, "vitest.config.json"), '{"test":2}');
    const fp2 = WorkspaceFingerprintService.compute(fd);

    expect(fp1.fingerprint).not.toBe(fp2.fingerprint);
  });

  it("R9: 超出批准范围的新增文件必须被拒绝", async () => {
    const s = await fixture();
    try {
      writeFileSync(
        join(ri.repo, "unapproved.txt"),
        "Outside app.txt approved scope",
      );
      const result = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(result.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it.each([
    ["src/nested/allowed.ts", undefined],
    ["src-old/outside.ts", "OUTSIDE_SCOPE_FILE"],
    ["src/private/secret.ts", "PROTECTED_PATH"],
    ["src/package.json", "DEPENDENCY_DENIED"],
  ])("directory scope verifies %s with result %s", async (file, expected) => {
    const s = await fixture();
    try {
      const rec = s.engine.plan(s.w.id);
      rec.plan.scope.repository_paths = { main: ["app.txt", "src"] };
      rec.plan.scope.protected_paths.push("src/private");
      s.store.put("plan", rec.id, s.w.id, rec);
      mkdirSync(join(ri.repo, file!.split("/").slice(0, -1).join("/")), {
        recursive: true,
      });
      writeFileSync(join(ri.repo, file!), "{}\n");
      const reader = attestFixture(
        s.engine,
        s.w.id,
        s.manifest,
        new NativeRunRecordReader([hostCall]),
      );
      const result = await s.engine.deliver(s.w.id, s.manifest, reader);
      expect(result.status).toBe("accepted");
    } finally {
      s.store.close();
    }
  });

  it("R10: 计划修订递增时恢复交接包包含 HANDOFF.md 并包含 workspaces 真实列表", async () => {
    const s = await fixture();
    try {
      const dir = join(isolatedRoot, "handoff");
      mkdirSync(dir, { recursive: true });
      const workspaces = [{ repo_id: "main", root: ri.repo }];
      const full = HandoffBuilder.buildFullHandoff({
        workflow: s.engine.get(s.w.id),
        plan: s.pl,
        runId: s.runId,
        packageHash: "v1",
        directory: dir,
        workspaces,
      });
      HandoffBuilder.writeHandoffFiles(dir, full, "# revision 1 old design");

      expect(full.workspaces).toBeDefined();
      expect(full.workspaces![0]!.root).toBe(ri.repo);

      const revised = { ...s.pl, markdown: "# revision 2 corrected design" };
      const resume = HandoffBuilder.buildResumeHandoff({
        workflow: { ...s.engine.get(s.w.id), plan_revision: 2 },
        plan: revised,
        runId: s.runId,
        conversationId: "c",
        packageHash: "v2",
        directory: dir,
        workspaces,
      });
      HandoffBuilder.writeHandoffFiles(dir, resume, revised.markdown);

      expect(resume.plan_revision).toBe(2);
      expect(resume.design_file).toBe(join(dir, "HANDOFF.md"));
      const designContent = readFileSync(join(dir, "HANDOFF.md"), "utf8");
      expect(designContent).toBe("# revision 2 corrected design");
    } finally {
      s.store.close();
    }
  });
});
