// Test-only CLI process. Production code has no fixture flag or bypass.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const selfPath = fileURLToPath(import.meta.url);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function flushStdout() {
  await new Promise((resolve) => {
    if (process.stdout.write("")) process.nextTick(resolve);
    else process.stdout.once("drain", resolve);
  });
}
const heldChildren = [];
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.154.0");
  process.exit(0);
}
if (args.includes("--help")) {
  console.log("codex exec resume --sandbox agy --print");
  process.exit(0);
}
if (args.includes("app-server")) process.exit(0);
if (process.env.DEVFLOW_FIXTURE_NESTED_ROLE === "child") {
  await runNestedChild();
  process.exit(0);
}
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
const fixture = readFixtureOptions(m);
writePromptCapture(prompt, file, fixture);
if (fixture.slowStartMs) await sleep(fixture.slowStartMs);
const resumeFlag = ["resume", "--resume", "--conversation"].find(flag => args.includes(flag));
const resumeId = resumeFlag ? args[args.indexOf(resumeFlag) + 1] : "";
const rootThread = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeId)
  ? resumeId
  : randomUUID();
emit({
  type: "thread.started",
  thread_id: rootThread,
});
emit({
  type: "turn.started",
  thread_id: rootThread,
});
const tree = await emitConversationTree(rootThread, fixture);
if (fixture.serviceExit) {
  emit({
    type: "error",
    error: { message: "fixture service exit" },
  });
  killHeldChildren();
  await flushStdout();
  process.exit(1);
}
if (fixture.quota && !resumeFlag) {
  emitQuotaInterrupt();
  killHeldChildren();
  await flushStdout();
  process.exit(1);
}
if (fixture.readAttachments) emitAttachmentReads(fixture.attachmentPaths);
if (fixture.holdMs) await sleep(fixture.holdMs);
completeHeldChildren(tree);
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

function flag(value) {
  return value === true || value === "1" || value === "true";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function readFixtureFile(handoff) {
  const dirs = [process.cwd()];
  const repo = handoff?.project?.repositories?.[0]?.path;
  if (typeof repo === "string" && repo) dirs.push(repo);
  let empty = {};
  for (const dir of dirs) {
    const filePath = path.join(dir, ".devflow-test-fixture.json");
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = asObject(JSON.parse(fs.readFileSync(filePath, "utf8")));
      if (Object.keys(parsed).length) return parsed;
      empty = parsed;
    } catch {}
  }
  return empty;
}

function numberOption(...values) {
  for (const raw of values) {
    const parsed = Number(raw || 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function readFixtureOptions(handoff) {
  const fromFile = readFixtureFile(handoff);
  const fromHandoff = asObject(handoff?.fixture ?? handoff?.devflow_test);
  const attachmentPaths = collectAttachmentPaths(handoff);
  const nested = flag(
    fromFile.nested ?? fromHandoff.nested ?? process.env.DEVFLOW_FIXTURE_NESTED,
  );
  const mixed = flag(
    fromFile.mixed ?? fromHandoff.mixed ?? process.env.DEVFLOW_FIXTURE_MIXED,
  );
  const grandchild = flag(
    fromFile.grandchild ??
      fromHandoff.grandchild ??
      process.env.DEVFLOW_FIXTURE_GRANDCHILD,
  );
  return {
    nested,
    mixed,
    grandchild,
    childCount: Math.max(
      0,
      Math.floor(
        numberOption(
          fromFile.child_count,
          fromHandoff.child_count,
          process.env.DEVFLOW_FIXTURE_CHILD_COUNT,
        ),
      ),
    ),
    slowStartMs: numberOption(
      fromFile.slow_start_ms,
      fromHandoff.slow_start_ms,
      process.env.DEVFLOW_FIXTURE_SLOW_START_MS,
    ),
    holdMs: numberOption(
      fromFile.hold_ms,
      fromHandoff.hold_ms,
      process.env.DEVFLOW_FIXTURE_HOLD_MS,
    ),
    quota: flag(
      fromFile.quota ?? fromHandoff.quota ?? process.env.DEVFLOW_FIXTURE_QUOTA,
    ),
    serviceExit: flag(
      fromFile.service_exit ??
        fromHandoff.service_exit ??
        process.env.DEVFLOW_FIXTURE_SERVICE_EXIT,
    ),
    detachChildren: flag(
      fromFile.detach_children ??
        fromHandoff.detach_children ??
        process.env.DEVFLOW_FIXTURE_DETACH_CHILDREN,
    ),
    readAttachments:
      flag(
        fromFile.read_attachments ??
          fromHandoff.read_attachments ??
          process.env.DEVFLOW_FIXTURE_READ_ATTACHMENTS,
      ) || attachmentPaths.length > 0,
    attachmentPaths,
  };
}

function writePromptCapture(prompt, handoffFile, fixture) {
  const names = (fixture.attachmentPaths ?? []).map((filePath) =>
    path.basename(filePath),
  );
  try {
    const handoff = JSON.parse(fs.readFileSync(handoffFile, "utf8"));
    for (const item of handoff.attachments ?? []) {
      if (item?.display_name) names.push(item.display_name);
    }
  } catch {}
  const unique = [...new Set(names)];
  const text = unique.length
    ? `${prompt}\nattachments:${unique.join(",")}`
    : prompt;
  const payload = {
    prompt: text,
    handoffFile,
    stage: process.env.DEVFLOW_STAGE || "",
    runId: process.env.DEVFLOW_RUN_ID || "",
    nested: fixture.nested,
    mixed: fixture.mixed,
    quota: fixture.quota,
  };
  writeFixtureSidecar(".devflow-fixture-last-prompt.txt", text);
  writeFixtureSidecar(
    ".devflow-fixture-last-prompt.json",
    JSON.stringify(payload),
  );
}

function fixtureSidecarDirs() {
  const dirs = new Set([process.cwd()]);
  const repo = m?.project?.repositories?.[0]?.path;
  if (typeof repo === "string" && repo) dirs.add(repo);
  return dirs;
}

function writeFixtureSidecar(name, content) {
  for (const dir of fixtureSidecarDirs()) {
    try {
      fs.writeFileSync(path.join(dir, name), content);
    } catch {}
  }
}

function writeHeldPids() {
  const payload = JSON.stringify({
    parent: process.pid,
    children: heldChildren.map((child) => child.pid).filter(Boolean),
  });
  writeFixtureSidecar(".devflow-fixture-pids.json", payload);
}

function spawnHeldProcess(detached = false) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "ignore",
    detached,
  });
  if (detached) child.unref();
  heldChildren.push(child);
  writeHeldPids();
  return child;
}

function emitCommand(threadId, command, status, extra = {}) {
  const id = extra.id || "cmd-" + command.replace(/\s+/g, "-");
  emit({
    type: status === "completed" || status === "failed" ? "item.completed" : extra.event || "item.started",
    thread_id: threadId,
    item: {
      id,
      type: "command_execution",
      command,
      cwd: process.cwd(),
      status: status === "failed" ? "failed" : status,
      ...(typeof extra.exit_code === "number" ? { exit_code: extra.exit_code } : {}),
      ...(extra.output ? { aggregated_output: extra.output } : {}),
    },
  });
}

function emitSpawn(parentThread, childThread, info, eventType = "item.started") {
  emit({
    type: eventType,
    thread_id: parentThread,
    item: {
      id: "spawn-" + childThread,
      type: "agent",
      status: info.status || (eventType === "item.completed" ? "completed" : "in_progress"),
      thread_id: childThread,
      agent_id: info.agentId,
      agent_nickname: info.nickname,
      parent_thread_id: parentThread,
      task_summary: info.summary,
    },
  });
}

function startChild(parentThread, info) {
  const childThread = randomUUID();
  emitSpawn(parentThread, childThread, info, "item.started");
  emit({ type: "thread.started", thread_id: childThread });
  if (info.keepRunning) {
    emitSpawn(parentThread, childThread, { ...info, status: "running" }, "item.updated");
    emitCommand(childThread, info.command, "in_progress");
    spawnHeldProcess(info.detached);
  } else if (info.waiting) {
    emitCommand(childThread, info.command, "in_progress");
    emit({ type: "turn.completed", thread_id: childThread });
  } else if (info.failed) {
    emitCommand(childThread, info.command, "failed", { exit_code: 1 });
    emitSpawn(parentThread, childThread, { ...info, status: "failed" }, "item.completed");
    emit({
      type: "turn.failed",
      thread_id: childThread,
      error: { message: info.summary || "child failed" },
    });
  } else {
    emitCommand(childThread, info.command, "in_progress");
    emitCommand(childThread, info.command, "completed", { exit_code: 0 });
    emitSpawn(parentThread, childThread, { ...info, status: "completed" }, "item.completed");
  }
  if (info.message) {
    emit({
      type: "item.completed",
      thread_id: childThread,
      item: {
        id: "msg-" + childThread.slice(0, 8),
        type: "agent_message",
        text: info.message,
      },
    });
  }
  return childThread;
}

function emitRootCommand(rootThread, command) {
  emitCommand(rootThread, command, "in_progress");
  emitCommand(rootThread, command, "completed", { exit_code: 0 });
}

async function emitConversationTree(rootThread, fixture) {
  const tree = { running: [], waiting: [], failed: [], extra: [], grandchild: "" };
  const wantTree =
    fixture.nested || fixture.mixed || fixture.grandchild || fixture.childCount > 0;
  if (!wantTree) return tree;
  emitRootCommand(rootThread, "root-fixture-cmd");
  if (fixture.mixed) {
    tree.running.push(
      startChild(rootThread, {
        agentId: "running-1",
        nickname: "running-agent",
        summary: "持续核对接口",
        command: "child-running-cmd",
        keepRunning: true,
        detached: fixture.detachChildren,
        message: "子会话正在运行",
      }),
    );
    tree.waiting.push(
      startChild(rootThread, {
        agentId: "waiting-1",
        nickname: "waiting-agent",
        summary: "等待测试结果",
        command: "child-waiting-cmd",
        waiting: true,
        message: "子会话正在等待",
      }),
    );
    tree.failed.push(
      startChild(rootThread, {
        agentId: "failed-1",
        nickname: "failed-agent",
        summary: "复现失败用例",
        command: "child-failed-cmd",
        failed: true,
        message: "子会话已失败",
      }),
    );
  } else {
    tree.running.push(
      startChild(rootThread, {
        agentId: "explore-1",
        nickname: fixture.holdMs ? "running-agent" : "explore",
        summary: "nested fixture agent",
        command: "child-fixture-cmd",
        keepRunning: fixture.holdMs > 0,
        detached: fixture.detachChildren,
        message: "子会话公开摘要",
      }),
    );
  }
  const extraCount = Math.max(0, fixture.childCount - tree.running.length - tree.waiting.length - tree.failed.length);
  for (let i = 0; i < extraCount; i++) {
    tree.extra.push(
      startChild(rootThread, {
        agentId: "extra-" + (i + 1),
        nickname: "extra-agent-" + (i + 1),
        summary: "批量子 Agent " + (i + 1),
        command: "child-extra-cmd-" + (i + 1),
        keepRunning: fixture.holdMs > 0,
        detached: fixture.detachChildren,
        message: "额外子会话 " + (i + 1),
      }),
    );
  }
  const parentForGrand = tree.running[0] || tree.waiting[0];
  if (fixture.grandchild && parentForGrand) {
    tree.grandchild = startChild(parentForGrand, {
      agentId: "review-2",
      nickname: "review",
      summary: "更深一层审查",
      command: "grand-fixture-cmd",
      keepRunning: fixture.holdMs > 0,
      detached: fixture.detachChildren,
      message: "孙会话公开摘要",
    });
  }
  writeHeldPids();
  return tree;
}

function killHeldChildren() {
  for (const child of heldChildren) {
    try {
      child.kill();
    } catch {}
  }
  heldChildren.length = 0;
  writeHeldPids();
}

function completeHeldChildren(tree) {
  killHeldChildren();
  for (const threadId of [...(tree?.running || []), ...(tree?.extra || [])]) {
    emitCommand(threadId, "child-running-cmd", "completed", { exit_code: 0 });
  }
  if (tree?.grandchild) {
    emitCommand(tree.grandchild, "grand-fixture-cmd", "completed", {
      exit_code: 0,
    });
  }
}

function collectAttachmentPaths(handoff) {
  const items = [];
  for (const list of [
    handoff?.attachments,
    handoff?.input_attachments,
    handoff?.inputAttachments,
    handoff?.files,
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string") items.push(item);
      else if (item && typeof item.absolute_path === "string")
        items.push(item.absolute_path);
      else if (item && typeof item.path === "string") items.push(item.path);
    }
  }
  const extra = process.env.DEVFLOW_FIXTURE_ATTACHMENT_PATHS;
  if (extra) items.push(...extra.split(path.delimiter));
  return [...new Set(items)].filter(
    (filePath) =>
      filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
  );
}

function emitAttachmentReads(paths) {
  for (const filePath of paths) {
    const buf = fs.readFileSync(filePath);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const call = "attach-" + sha256.slice(0, 12);
    emit({
      type: "item.started",
      item: {
        type: "command_execution",
        id: call,
        command: "read-attachment " + path.basename(filePath),
        cwd: process.cwd(),
      },
    });
    emit({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: call,
        exit_code: 0,
        aggregated_output: JSON.stringify({
          path: filePath,
          bytes: buf.length,
          sha256,
        }),
      },
    });
  }
}

function emitQuotaInterrupt() {
  emit({
    type: "rate_limits",
    rate_limits: {
      primary: {
        used_percent: 100,
        window_minutes: 60,
        resets_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  });
  emit({
    type: "error",
    error: { message: "quota exceeded 429 额度不足 resets in 1h" },
  });
}

async function runNestedChild() {
  const childId =
    "fixture-child-" + (process.env.DEVFLOW_RUN_ID || process.pid);
  emit({
    type: "item.started",
    item: {
      type: "command_execution",
      id: "nested-work-" + childId,
      command: "nested-fixture-child",
      cwd: process.cwd(),
    },
  });
  await sleep(50);
  emit({
    type: "item.completed",
    item: {
      type: "command_execution",
      id: "nested-work-" + childId,
      exit_code: 0,
    },
  });
}

async function spawnNestedAgent(parentThread) {
  const childId = "fixture-child-" + (process.env.DEVFLOW_RUN_ID || process.pid);
  const spawnId = "spawn-" + childId;
  emit({
    type: "item.started",
    item: {
      id: spawnId,
      type: "collab_agent_tool_call",
      agent_id: childId,
      parent_thread_id: parentThread,
      title: "nested fixture agent",
    },
  });
  const code = await new Promise((yes, no) => {
    const child = spawn(process.execPath, [selfPath], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DEVFLOW_FIXTURE_NESTED_ROLE: "child",
        DEVFLOW_FIXTURE_NESTED: "",
        DEVFLOW_FIXTURE_QUOTA: "",
        DEVFLOW_FIXTURE_SERVICE_EXIT: "",
      },
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill();
      no(new Error("nested fixture agent timed out"));
    }, 10000);
    child.once("error", (error) => {
      clearTimeout(timer);
      no(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      yes(exitCode ?? 1);
    });
  });
  emit({
    type: "item.completed",
    item: {
      id: spawnId,
      type: "collab_agent_tool_call",
      agent_id: childId,
      parent_thread_id: parentThread,
      exit_code: code,
    },
  });
}
