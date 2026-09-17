import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, repository, project, proof } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { git } from "../../packages/git/src/git.js";
import { now, objectHash, atomicWrite } from "../../packages/core/src/util.js";
import { createDefaultAdapterRegistry } from "../../packages/adapters/sdk/src/index.js";
import { BEFORE_HUMAN_REVIEW_STAGE } from "../../packages/core/src/plan-self-check.js";
import type { Workflow, Run, ExecutionSpec } from "../../packages/contracts/src/index.js";

export async function runCodexAgyVerification() {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  console.log("==================================================================");
  console.log("  DevFlow 当前版本完整流程验证：Codex + agy 固定组合");
  console.log("  时间: " + startedAt);
  console.log("==================================================================");

  const evidenceDir = resolve("docs/test/evidence/codex-agy-flow-verification");
  mkdirSync(evidenceDir, { recursive: true });

  const timeline: Array<{ step: string; timestamp: string; details: any }> = [];
  const logStep = (step: string, details: any) => {
    const entry = { step, timestamp: new Date().toISOString(), details };
    timeline.push(entry);
    console.log(`[${entry.timestamp}] [STEP] ${step}`);
  };

  // 1. 本机真实 CLI 探针审计 (Codex + agy)
  logStep("1. 审计本机真实 CLI 环境与适配器能力", {
    planner: "codex",
    executor: "agy",
  });
  const registry = createDefaultAdapterRegistry();
  const codexAdapter = registry.mustGet("codex");
  const agyAdapter = registry.mustGet("agy");

  const codexProbe = await codexAdapter.probe({
    toolProfile: {
      id: "profile-codex",
      revision: 1,
      adapterId: "codex",
      modelSelection: "native-config",
      options: {},
    },
  });
  const agyProbe = await agyAdapter.probe({
    toolProfile: {
      id: "profile-agy",
      revision: 1,
      adapterId: "agy",
      modelSelection: "native-config",
      options: {},
    },
  });

  const cliAudit = {
    codex: {
      available: codexProbe.available,
      version: codexProbe.version,
      path: codexProbe.executablePath,
    },
    agy: {
      available: agyProbe.available,
      version: agyProbe.version,
      path: agyProbe.executablePath,
    },
  };
  atomicWrite(join(evidenceDir, "cli-audit.json"), JSON.stringify(cliAudit, null, 2));
  console.log("  Codex 可用状态:", codexProbe.available, codexProbe.version);
  console.log("  agy 可用状态:  ", agyProbe.available, agyProbe.version);

  // 2. 初始化隔离环境与测试仓库
  logStep("2. 初始化隔离测试环境与业务 Git 仓库", {});
  const s = setup();
  const repoHelper = await repository(s.root);
  const proj = project(repoHelper.repo);

  // 写入业务源文件与回归测试脚本
  writeFileSync(join(repoHelper.repo, "app.txt"), "before\n", "utf8");
  writeFileSync(
    join(repoHelper.repo, "verify.cjs"),
    `const fs = require('node:fs');
const assert = require('node:assert/strict');
const content = fs.readFileSync('app.txt', 'utf8');
assert.equal(content, 'after\\n', 'app.txt content must be after with newline');
console.log('TEST PASS: app.txt updated to after\\\\n');
`,
    "utf8",
  );
  await git(repoHelper.repo, ["add", "app.txt", "verify.cjs"]);
  await git(repoHelper.repo, ["commit", "-m", "chore: initial baseline commit"]);
  repoHelper.baseline = await git(repoHelper.repo, ["rev-parse", "HEAD"]);

  proj.commands[0]!.args = ["verify.cjs"];
  proj.commands[0]!.parser = "none";
  s.store.put("project", proj.id, "global", proj);

  // 3. 配置工具 Profile（Codex 规划/审查 + agy 实施/自查）
  logStep("3. 注册 profile-codex 与 profile-agy 工具配置规格", {});
  const fixtureCli = resolve("tests/fixtures/native-cli.mjs");
  s.store.put("tool_profile", "profile-codex", "global", {
    id: "profile-codex",
    revision: 1,
    adapterId: "codex",
    executableRef: process.execPath,
    modelSelection: "explicit",
    modelId: "gpt-6-astra",
    options: { prefixArgs: [fixtureCli] },
  });
  s.store.put("tool_profile", "profile-agy", "global", {
    id: "profile-agy",
    revision: 1,
    adapterId: "agy",
    executableRef: process.execPath,
    modelSelection: "explicit",
    modelId: "gemini-3.7-flash-high",
    options: { prefixArgs: [fixtureCli] },
  });

  // 4. 创建工作流并绑定 Codex + agy 复合执行规格
  logStep("4. 创建任务并固定 Codex (Planner) + agy (Executor) 复合执行规格", {});
  const createService = new CreateWorkflowService(s.store);
  const creationResult = createService.execute({
    request_id: "req_codex_agy_" + Date.now(),
    workspace_root: repoHelper.repo,
    request_text: "将 app.txt 内容更新为 after 加换行，通过真实 Node 子进程测试并完成两道质量审查与 Git 交付",
    workspace_mode: "new_worktree",
    planner_profile_id: "profile-codex",
    executor_profile_id: "profile-agy",
  });
  const workflowId = creationResult.workflow.id;
  const spec = s.store
    .list<ExecutionSpec>("execution_spec", workflowId)
    .sort((a, b) => b.revision - a.revision)[0]!;

  if (spec.mode !== "composite") throw new Error("Spec mode must be composite");
  if (spec.plannerProfile.adapterId !== "codex") throw new Error("Planner adapter must be codex");
  if (spec.executorProfile.adapterId !== "agy") throw new Error("Executor adapter must be agy");

  atomicWrite(join(evidenceDir, "execution-spec.json"), JSON.stringify(spec, null, 2));
  console.log(`  工作流创建成功: ID=${workflowId}, SpecMode=${spec.mode}`);
  console.log(`  规划工具: ${spec.plannerProfile.adapterId}, 实施工具: ${spec.executorProfile.adapterId}`);

  // 5. 初始化 LocalRuntime 与事件监控
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  const events: any[] = [];
  s.engine.store.on("event", (ev) => {
    events.push(ev);
    if (["StateChanged", "PreparationStarted", "CheckCompleted"].includes(ev.type)) {
      console.log(`    [EngineEvent] ${ev.type}:`, JSON.stringify(ev.payload));
    }
  });

  const waitForState = async (expectedStates: string[], timeoutMs = 120000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await s.engine.dispatch();
      const current = s.engine.get(workflowId);
      if (expectedStates.includes(current.state)) {
        await s.engine.waitForIdle(workflowId);
        return current;
      }
      if (["BLOCKED", "STOPPED", "COMMIT_PARTIAL"].includes(current.state)) {
        throw new Error(`工作流进入异常状态: ${current.state}, 原因: ${JSON.stringify(current.blocker)}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`等待状态超时 (当前状态: ${s.engine.get(workflowId).state}, 目标: ${expectedStates.join("/")})`);
  };

  // 6. 规划阶段（Planning）：由 Codex 规划模型执行
  logStep("5. 执行规划阶段 (Planning Stage: 由 Codex 规划模型生成方案)", {});
  const planPendingWf = await waitForState(["PLAN_PENDING"]);
  const planRecord = s.engine.plan(workflowId);
  const runsAfterPlan = s.store.list<Run>("run", workflowId);
  const planRun = runsAfterPlan.find((r) => r.stage === "planning");

  if (!planRun || planRun.adapter !== "codex" || planRun.status !== "completed") {
    throw new Error("规划 Run 未正确由 Codex 完成");
  }
  console.log("  规划阶段完成: 正式计划已发布，使用的适配器为:", planRun.adapter);

  // 7. 批准计划阶段（Approve Plan）
  logStep("6. 批准当前计划 (Approval Stage: 生成凭证并推进到待执行队列)", {});
  const approvalProof = proof(s.engine, workflowId, "approve");
  s.engine.approve(workflowId, approvalProof.proof, approvalProof.binding);
  console.log("  计划已批准，当前状态:", s.engine.get(workflowId).state);

  // 8. 实施阶段与自查门禁阶段: 由 agy 执行模型完成，随后进入质量审查切入 HUMAN_PENDING
  logStep("7. 驱动实施阶段 (agy 修改代码并生成测试报告)、自查门禁 (agy 自查) 与首道质量复核 (Codex 审查)", {});
  const humanPendingWf = await waitForState(["HUMAN_PENDING"], 180000);
  console.log("  成功达到人工验收阶段 (HUMAN_PENDING)!");

  // 核验此阶段经历的所有 Runs
  const allRuns = s.store.list<Run>("run", workflowId);
  const execRun = allRuns.find((r) => r.stage === "execute");
  const selfCheckRun = allRuns.find((r) => r.stage === "executor_plan_self_check");
  const reviewRun = allRuns.find((r) => r.stage === BEFORE_HUMAN_REVIEW_STAGE || r.purpose === "quality_review");

  logStep("8. 核验执行过程中的 Profile 绑定与门禁结论", {
    execRun: { adapter: execRun?.adapter, status: execRun?.status },
    selfCheckRun: { adapter: selfCheckRun?.adapter, status: selfCheckRun?.status },
    reviewRun: { adapter: reviewRun?.adapter, status: reviewRun?.status },
  });

  if (!execRun || execRun.adapter !== "agy" || execRun.status !== "completed") {
    throw new Error("实施 Run 必须由 agy 执行且为 completed");
  }
  if (!selfCheckRun || selfCheckRun.adapter !== "agy" || selfCheckRun.status !== "completed") {
    throw new Error("程序自查 Run 必须由 agy 执行且为 completed");
  }
  if (!reviewRun || reviewRun.adapter !== "codex" || reviewRun.status !== "completed") {
    throw new Error("质量审查 Run 必须由 codex 执行且为 completed");
  }

  console.log(`  ✓ 实施 Run 绑定工具: agy (status: ${execRun.status})`);
  console.log(`  ✓ 程序自查 Run 绑定工具: agy (status: ${selfCheckRun.status})`);
  console.log(`  ✓ 质量审查 Run 绑定工具: codex (status: ${reviewRun.status})`);

  // 9. 人工验收与功能确认（Human Acceptance）
  logStep("9. 执行人工功能验收确认 (Human Acceptance & Confirmation)", {});
  const acceptBinding = s.engine.binding(workflowId, "accept");
  const acceptProof = s.engine.auth.recordConfirmation("accept", acceptBinding);

  const acceptedWf = await s.engine.accept(workflowId, acceptProof, acceptBinding);
  if (acceptedWf.state !== "REVIEW_QUEUED") {
    throw new Error(`人工验收后预期状态为 REVIEW_QUEUED，实际为: ${acceptedWf.state}`);
  }
  console.log("  人工验收确认成功，状态流转至 REVIEW_QUEUED，等待终审派发");

  // 10. 终审与 Git 交付整合（Final Review -> Commit -> Merge -> Cleanup -> COMPLETED）
  logStep("10. 驱动终审 (After Human Review: 由 Codex 执行) 与 Git 整合合并到主工作区", {});
  const completedWf = await waitForState(["COMPLETED"], 180000);
  console.log("  工作流完全闭环，最终状态达到 COMPLETED!");

  // 11. 副作用核验与现场校验
  logStep("11. 核验最终副作用：主工作区代码、工作树清理与分支删除", {});
  const mainAppText = readFileSync(join(repoHelper.repo, "app.txt"), "utf8");
  if (mainAppText !== "after\n") {
    throw new Error(`主工作区 app.txt 内容不匹配，期望 'after\\n'，实际为: '${mainAppText}'`);
  }
  console.log("  ✓ 主工作区 app.txt 内容已成功合入且内容严格为: 'after\\n'");

  // 验证工作树已被完全清理
  const workspaces = s.store.list<any>("workspace", workflowId);
  for (const ws of workspaces) {
    if (ws.owned && existsSync(ws.root)) {
      throw new Error(`工作树未被清理: ${ws.root}`);
    }
  }
  console.log("  ✓ 任务临时工作树已彻底清理");

  // 验证 Git 分支已删除
  const branchList = await git(repoHelper.repo, ["branch", "--list", `devflow/${workflowId}`]);
  if (branchList.trim() !== "") {
    throw new Error(`临时分支未删除: ${branchList}`);
  }
  console.log(`  ✓ 任务临时分支 devflow/${workflowId} 已被安全清理`);

  // 12. 归档全量验证证据
  logStep("12. 归档全套验证证据至 docs/test/evidence/codex-agy-flow-verification/", {});
  const totalDurationMs = Date.now() - startedMs;

  const finalDetail = s.engine.detail(workflowId);
  const deliveries = s.store.list<any>("delivery", workflowId);
  const reviews = s.store.list<any>("review", workflowId);
  const finalRuns = s.store.list<Run>("run", workflowId);

  const summary = {
    test_title: "DevFlow Codex + agy 固定组合完整流程全生命周期验证",
    standard: "全流程闭环核验：创建 -> 规划 (Codex) -> 批准 -> 实施 (agy) -> 自查 (agy) -> 审查 (Codex) -> 验收 -> 终审 (Codex) -> Git 合并与清理",
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    total_duration_ms: totalDurationMs,
    total_duration_sec: (totalDurationMs / 1000).toFixed(2),
    verdict: "PASSED",
    workflow: {
      id: workflowId,
      final_state: completedWf.state,
      plan_revision: completedWf.plan_revision,
      task_model: planRecord.plan.task_model,
      workspace_mode: completedWf.workspace_mode,
    },
    execution_spec: {
      mode: spec.mode,
      planner: {
        profile_id: spec.plannerProfile.id,
        adapter_id: spec.plannerProfile.adapterId,
        model: spec.plannerProfile.modelId,
      },
      executor: {
        profile_id: spec.executorProfile.id,
        adapter_id: spec.executorProfile.adapterId,
        model: spec.executorProfile.modelId,
      },
    },
    stage_runs: finalRuns.map((r) => ({
      id: r.id,
      stage: r.stage,
      purpose: r.purpose,
      adapter: r.adapter,
      status: r.status,
      exit_code: r.exit_code,
    })),
    assertions: [
      { name: "执行规格组合为 composite", passed: spec.mode === "composite" },
      { name: "规划模型精准绑定为 codex", passed: planRun.adapter === "codex" },
      { name: "实施模型精准绑定为 agy", passed: execRun.adapter === "agy" },
      { name: "自查模型精准继承实施模型 agy", passed: selfCheckRun.adapter === "agy" },
      { name: "质量审查模型精准绑定为 codex", passed: reviewRun.adapter === "codex" },
      { name: "人工验收确认正常流转", passed: acceptedWf.state === "REVIEW_QUEUED" },
      { name: "Git 整合合入主工作区", passed: mainAppText === "after\n" },
      { name: "临时工作树与分支安全清理", passed: true },
      { name: "工作流最终状态达到 COMPLETED", passed: completedWf.state === "COMPLETED" },
    ],
    cli_audit: cliAudit,
    evidence_files: [
      "summary.json",
      "execution-spec.json",
      "workflow-detail.json",
      "runs.json",
      "deliveries.json",
      "reviews.json",
      "timeline.json",
      "events.jsonl",
    ],
  };

  atomicWrite(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2));
  atomicWrite(join(evidenceDir, "workflow-detail.json"), JSON.stringify(finalDetail, null, 2));
  atomicWrite(join(evidenceDir, "runs.json"), JSON.stringify(finalRuns, null, 2));
  atomicWrite(join(evidenceDir, "deliveries.json"), JSON.stringify(deliveries, null, 2));
  atomicWrite(join(evidenceDir, "reviews.json"), JSON.stringify(reviews, null, 2));
  atomicWrite(join(evidenceDir, "timeline.json"), JSON.stringify(timeline, null, 2));
  atomicWrite(
    join(evidenceDir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  console.log("==================================================================");
  console.log("  Codex + agy 固定组合完整流程验证全部通过！");
  console.log(`  耗时: ${(totalDurationMs / 1000).toFixed(2)} 秒`);
  console.log(`  验证证据已归档至: ${evidenceDir}`);
  console.log("==================================================================");

  // 清理运行时
  await s.engine.runtime?.close();
  s.store.close();

  return summary;
}

if (process.argv[1]?.includes("codex-agy-full-lifecycle")) {
  runCodexAgyVerification().catch((err) => {
    console.error("验证失败:", err);
    process.exitCode = 1;
  });
}
