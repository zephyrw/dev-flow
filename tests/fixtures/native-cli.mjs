// Test-only CLI process. Production code has no fixture flag or bypass.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex fixture 1.0 agy 1.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("codex exec resume --sandbox agy --print");
  process.exit(0);
}
if (args.includes("app-server")) process.exit(0);
let prompt = "";
const pIndex = args.indexOf("-p");
if (pIndex !== -1 && args[pIndex + 1]) {
  prompt = args[pIndex + 1];
} else if (args[args.length - 1] && !args[args.length - 1].startsWith("-") && args.length > 2) {
  prompt = args[args.length - 1];
} else {
  try {
    prompt = fs.readFileSync(0, "utf8");
  } catch {}
}
const file = prompt.match(/(?:完整任务及唯一正式计划材料：|请读取工作包\s*)(.+?)(?:。必须|。严格|$)/)?.[1]?.trim();
if (!file) throw new Error("Missing original handoff: prompt was " + JSON.stringify(prompt));
const m = JSON.parse(fs.readFileSync(file, "utf8")),
  stage = process.env.DEVFLOW_STAGE;
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const resumeFlag = ["resume", "--resume", "--conversation"].find(flag => args.includes(flag));
emit({
  type: "thread.started",
  thread_id: resumeFlag ? args[args.indexOf(resumeFlag) + 1] : "fixture-" + process.env.DEVFLOW_RUN_ID,
});
let result;
if (stage === "planning") {
  const markdown =
    "# 正式计划\n\n将 app.txt 修改为 after，保留换行及其余文件。使用真实 Node 子进程验证输出，并回归未修改文件。\n" +
    (m.current_plan ? "\n## 修改说明\n" + m.feedback.map(f => f.text).join("\n") + "\n" : "");
  result = {
    markdown,
    plan: {
      task_model: "native-v2",
      revision: 1,
      design_ref: {
        content_hash: createHash("sha256").update(markdown).digest("hex"),
        summary: "修改文本",
      },
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
      baselines: m.baselines,
      project_config_hash: m.project_config_hash,
    },
  };
} else if (stage === "aside") {
  result = {
    answer:
      "当前任务正在按正式计划修改 app.txt；这次只读提问没有更改工作流或代码。",
  };
  if (m.question.plan_revision) {
    if (!m.plan.markdown?.includes("# 正式计划")) throw new Error("Missing full plan document");
    result.answer += `\n问题：${m.question.question}\n计划版本：${m.plan.revision}\n完整正文：\n${m.plan.markdown}\n已有问答：${m.previous_questions.length}`;
  }
} else if (stage === "review" || stage === "quality_before_human") {
  const w = m.workflow;
  result = {
    schema_version: 1,
    workflow_id: w.id,
    review_request_id: w.review_request_id,
    plan_revision: w.plan_revision,
    snapshot_id: w.snapshot_id,
    verdict: "pass",
    coverage: {
      all_changed_files_reviewed: true,
      all_requirements_checked: true,
      upstream_downstream_checked: true,
      security_checked: true,
      tests_validity_checked: true,
      files: (m.snapshot?.repositories ?? []).flatMap((r) =>
        (r.changed_paths ?? []).map((p) => r.repo_id + ":" + p),
      ),
    },
    findings: [],
    unresolved_questions: [],
    repair_plan: null,
    commit_message: "test: native fixture",
  };
} else if (stage === "merge_conflict_resolution") {
  const root = process.cwd();
  if (process.env.FIXTURE_CONFLICT_EXIT_FAIL) {
    process.exit(1);
  }
  for (const p of m.conflict_paths || []) {
    const fullPath = path.join(root, p);
    if (!fs.existsSync(fullPath)) continue;
    let content = fs.readFileSync(fullPath, "utf8");
    if (content.includes("<<<<<<<")) {
      content = content.replace(
        /<{7}[^\n]*\r?\n([\s\S]*?)={7}\r?\n([\s\S]*?)>{7}[^\n]*(?:\r?\n|$)/g,
        (_match, ours, theirs) => ours.trim() + "\n" + theirs.trim() + "\n",
      );
    }
    if (content.includes("<<<<<<<") || /(^|[\\/])app\.txt$/.test(p)) {
      content = "after\nupstream line\n";
    }
    fs.writeFileSync(fullPath, content);
  }
  result = {
    receipt: {
      request_id: m.request_id || m.request?.id || "req-fixture",
      workflow_id: process.env.DEVFLOW_WORKFLOW_ID,
      run_id: process.env.DEVFLOW_RUN_ID,
      candidate_commit: m.candidate_commit || m.request?.candidate_commit,
      source_commit: m.source_commit || m.request?.source_commit,
      status: process.env.FIXTURE_CONFLICT_STATUS || "resolved",
      resolved_paths: m.conflict_paths || [],
      function_impact: "none",
      function_impact_explanation: "冲突双方文本均保留，无外部行为变更",
      blockers: process.env.FIXTURE_CONFLICT_BLOCKERS
        ? JSON.parse(process.env.FIXTURE_CONFLICT_BLOCKERS)
        : undefined,
    },
  };
} else {
  const root = process.cwd();
  if (
    !fs.existsSync("app.txt") ||
    !fs.readFileSync("app.txt", "utf8").includes("after")
  ) {
    fs.writeFileSync("app.txt", "after\n");
  }
  fs.mkdirSync(".reports", { recursive: true });
  const checker = path.join(root, ".reports", "check.cjs");
  fs.writeFileSync(
    checker,
    "const fs=require('node:fs');require('node:assert/strict').ok(fs.readFileSync('app.txt','utf8').includes('after'));setTimeout(()=>fs.writeFileSync('.reports/unit.json',JSON.stringify({testResults:[{assertionResults:[{title:'updates content',status:'passed'}]}]})),200);",
  );
  const call = "call-" + process.env.DEVFLOW_RUN_ID,
    command = '"' + process.execPath + '" .reports/check.cjs';
  emit({
    type: "item.started",
    item: { type: "command_execution", id: call, command, cwd: root },
  });
  await new Promise((r) => setTimeout(r, 200));
  const code = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [checker], {
      cwd: root,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", no);
    child.once("exit", yes);
  });
  emit({
    type: "item.completed",
    item: { type: "command_execution", id: call, exit_code: code },
  });
  await new Promise((r) => setTimeout(r, 100));
  if (code !== 0) process.exit(1);
  result = {
    status: "completed",
    summary: "已修改 app.txt 并完成本轮自测",
    delivery: {
      submission_id: "sub-" + process.env.DEVFLOW_RUN_ID,
      implementations: [{ task_id: "T01", repo_id: "main", path: "app.txt" }],
      test_executions: [
        {
          tool_call_id: call,
          command,
          cwd: root,
          repo_id: "main",
          exit_code: code,
          report_paths: [".reports/unit.json"],
          format: "vitest_json",
        },
      ],
      acceptance_mappings: [
        {
          requirement_id: "UT01",
          scene_id: "UT01",
          test_execution_id: call,
          report_path: ".reports/unit.json",
          case_id: "updates content",
        },
      ],
    },
  };
  if (m.check)
    result.delivery.plan_self_check = {
      request_id: m.check.id,
      source_delivery_revision_id: m.check.source_delivery_revision_id,
      plan_revision: m.check.plan_revision,
      plan_hash: m.check.plan_hash,
      authority_hash: m.check.authority_hash,
      run_id: m.run.id,
      verdict: "passed",
      checks: m.check.check_ids.map((check_id) => ({
        check_id,
        status: "passed",
        evidence: ["app.txt 和本轮真实 .reports/unit.json"],
      })),
      findings: [],
    };
}
emit({
  type: "item.completed",
  item: { type: "agent_message", text: JSON.stringify(result) },
});
