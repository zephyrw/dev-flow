import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { writeAgyProject } from "../../packages/adapters/agy/src/project.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { setup, repository, project, plan } from "../helpers.js";
import { Engine, type Runtime } from "../../packages/core/src/engine.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { buildServer } from "../../apps/api/src/server.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import {
  writeAgyConfiguration,
  agyArguments,
  observeAgy,
} from "../../packages/adapters/agy/src/session.js";
import { git } from "../../packages/git/src/git.js";
import {
  objectHash,
  atomicWrite,
  redact,
} from "../../packages/core/src/util.js";
import {
  requireCondition,
  type Workflow,
  type Run,
} from "../../packages/contracts/src/index.js";

const output = resolve(".cache/live-agy/workflow-" + Date.now());
const marker = "LIVE-PLAN-" + crypto.randomUUID();
mkdirSync(output, { recursive: true });
const s = setup();
s.config.server.port = 14812;
s.config.server.human_origin = "http://localhost:14812";
s.config.host.executable = resolve(
  "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
);
s.config.host.required = true;
s.config.models.agy_executable = "C:/Users/yckj4798/AppData/Local/agy/bin/agy.exe";
s.config.timeouts.agent_minutes = 8;
const engine = new Engine(s.store, s.config),
  r = await repository(s.root);
writeFileSync(
  join(r.repo, "verify.cjs"),
  `const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('updates content',()=>assert.equal(fs.readFileSync('app.txt','utf8'),'after\\n'));`,
);
await git(r.repo, ["add", "verify.cjs"]);
await git(r.repo, ["commit", "-m", "live integration fixture"]);
r.baseline = await git(r.repo, ["rev-parse", "HEAD"]);
const p = project(r.repo);
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
    title: "真实 agy 信息传递验收",
    request:
      "在专用测试仓库中把 app.txt 改为 after 加换行，通过真实 Node 测试，报告批准计划中的联调标记。禁止访问其他项目或使用原生 shell、浏览器和文件工具。",
    complexity: "simple",
    workspace_mode: "existing_workspace",
  },
  "live-" + Date.now(),
);
const contract = plan(objectHash(p), r.baseline);
contract.tests[0]!.expected_case_ids = ["test updates content"];
contract.markdown += `\n\n本次联调标记：${marker}。必须通过 devflow_worker MCP 完成修改、任务声明、冻结、检查和完成报告，并在中文完成摘要中原样报告此标记。`;
engine.submitPlan(w.id, contract, w.version, "live-plan");
const processes = new ProcessManager(s.config.host.executable, true);
const checker = new LocalRuntime(engine);
let liveResult: unknown;
const started = Date.now();
const events: unknown[] = [];
engine.store.on("event", (event) => {
  events.push(event);
  if (
    [
      "StateChanged",
      "AgentEvent",
      "AgentDiagnostic",
      "CheckCompleted",
    ].includes(event.type)
  ) {
    const payload = event.payload as any;
    console.log(
      JSON.stringify({
        type: event.type,
        state: payload.to,
        event: payload.event,
        tool: payload.step_update?.tool_name,
        text: payload.step_update?.text_delta ?? payload.text,
        status: payload.status,
        elapsed_ms: Date.now() - started,
      }),
    );
  }
});
// Live adapter test uses the current Windows user and existing official login.
engine.runtime = {
  async execute(flow: Workflow, run: Run, token: string) {
    const directory = join(output, "container");
    writeAgyConfiguration(
      directory,
      process.execPath,
      resolve("dist/packages/bridge/src/worker.js"),
      resolve("dist/packages/bridge/src/hook.js"),
    );
    const agyProject = writeAgyProject(
      homedir(),
      crypto.randomUUID(),
      directory,
    );
    const prompt = `This is a real authorized integration test. Use only devflow_worker MCP tools. First call devflow_execute_context with section=overview, then read section=plan, skill, tasks, tests, scope and feedback. Continue any non-null next_offset with the same section/id. The tool returns text chunks; NEVER read a local temp file. Query section=tool,id=the full tool name for exact parameter schemas. Implement the approved task, claim it with a detailed Chinese summary containing the exact random marker found ONLY in the plan, freeze, run approved checks, then finish. Report the marker and actual test results. Do not use native tools or create another plan. Approval was already recorded via DevFlow. If blocked, report the exact error and stop.`;
    const proc = processes.start({
      id: run.id,
      executable: "C:/Users/yckj4798/AppData/Local/agy/bin/agy.exe",
      args: [
        ...agyArguments(
          "gemini-3.7-flash-high",
          prompt,
          8,
          undefined,
          agyProject.project_id,
        ),
        "--add-dir",
        directory,
        "--log-file",
        join(output, "agy-internal.log"),
      ],
      cwd: directory,
      env: {
        DEVFLOW_RUN_TOKEN: token,
        DEVFLOW_WORKFLOW_ID: flow.id,
        DEVFLOW_RUN_ID: run.id,
        DEVFLOW_BASE_URL: "http://127.0.0.1:14812",
      },
      timeout_ms: 540000,
    });
    liveResult = await observeAgy(proc, {
      model: "gemini-3.7-flash-high",
      cwd: directory,
      log: join(output, "stdout.jsonl"),
      onEvent: (event) =>
        engine.store.event(
          flow.id,
          flow.project_id,
          "AgentEvent",
          event,
          run.id,
        ),
      onDiagnostic: (text) =>
        engine.store.event(
          flow.id,
          flow.project_id,
          "AgentDiagnostic",
          { text },
          run.id,
        ),
    });
  },
  review: async () => {
    throw Error(
      "Live test ends at human acceptance; no automatic real review is requested here",
    );
  },
  stop: async (run) => {
    await processes.stop(run);
    await checker.stop(run);
  },
  check: (flow, test, principal) => checker.check(flow, test, principal),
  close: async () => {
    await processes.close();
    await checker.close();
  },
} satisfies Runtime;
if (process.argv.includes("--production-runtime")) {
  const { LocalRuntime: ProductionRuntime } = await import(pathToFileURL(resolve("dist/packages/runtime/src/runtime.js")).href);
  engine.runtime = new ProductionRuntime(engine);
}
const app = await buildServer(engine);
await app.listen({ host: "127.0.0.1", port: 14812 });
const browser = await chromium.launch({
  executablePath:
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
let result: any;
let cleanupCompletion = () => {};
try {
  await page.goto("http://localhost:14812");
  await page.getByRole("heading", { name: "工作流总览" }).waitFor();
  await page
    .getByRole("button")
    .filter({
      has: page.getByRole("heading", { name: "真实 agy 信息传递验收" }),
    })
    .click();
  await page.getByRole("button", { name: "批准当前计划" }).click();
  await page.getByRole("button", { name: "实时输出", exact: true }).click();
  console.log(
    "Live agy workflow approved through the local UI without login; watching event-driven state.",
  );
  const completion = new Promise<void>((yes, no) => {
    const timeout = setTimeout(() => {
      cleanupCompletion();
      no(Error("Live workflow timeout"));
    }, 540000);
    const listener = (e: any) => {
      if (
        e.type === "StateChanged" &&
        ["HUMAN_PENDING", "BLOCKED", "STOPPED"].includes(e.payload.to)
      ) {
        cleanupCompletion();
        yes();
      }
    };
    cleanupCompletion = () => {
      clearTimeout(timeout);
      engine.store.off("event", listener);
    };
    engine.store.on("event", listener);
  });
  let liveUiBeforeCompletion = false;
  await Promise.all([
    completion,
    (async () => {
      await expect(page.locator(".logs")).toContainText(
        "devflow_execute_context",
        { timeout: 120000 },
      );
      liveUiBeforeCompletion = ["EXECUTING", "VERIFYING"].includes(
        engine.get(w.id).state,
      );
      await page.screenshot({
        path: join(output, "live-before-completion.png"),
        fullPage: true,
      });
    })(),
  ]);
  await page.waitForTimeout(500);
  await page.screenshot({
    path: join(output, "live-logs.png"),
    fullPage: true,
  });
  const ui = await page.locator(".logs").innerText();
  const detail = engine.detail(w.id);
  result = {
    workflow_id: w.id,
    state: detail.workflow.state,
    blocker: detail.workflow.blocker,
    model: (liveResult as any)?.result ?? (events as any[]).find(e => e.payload?.event === "init")?.payload?.init,
    production_runtime: process.argv.includes("--production-runtime"),
    session: liveResult,
    task_status: detail.tasks,
    evidence: detail.evidence,
    content: readFileSync(join(r.repo, "app.txt"), "utf8"),
    ui_logs_contain_tool: ui.includes("devflow_"),
    ui_logs_contain_marker: ui.includes(marker),
    ui_logs_visible_before_completion: liveUiBeforeCompletion,
    plan_only_marker: marker,
    event_count: events.length,
    root: s.root,
    output,
    duration_ms: Date.now() - started,
  };
  atomicWrite(join(output, "summary.json"), JSON.stringify(result, null, 2));
  atomicWrite(
    join(output, "events.json"),
    redact(JSON.stringify(events, null, 2)),
  );
  console.log(
    JSON.stringify({
      state: result.state,
      blocker: result.blocker,
      tool_logs_visible: result.ui_logs_contain_tool,
      marker_visible: result.ui_logs_contain_marker,
      logs_visible_before_completion: result.ui_logs_visible_before_completion,
      task_status: result.task_status,
      evidence: result.evidence.map((e: any) => ({
        test: e.test_id,
        status: e.status,
        passed: e.passed,
      })),
      output,
    }),
  );
  requireCondition(
    result.state === "HUMAN_PENDING" &&
      result.content === "after\n" &&
      result.ui_logs_contain_tool &&
      result.ui_logs_contain_marker &&
      result.ui_logs_visible_before_completion &&
      detail.tasks.every((t) => t.status === "verified"),
    "LIVE_TEST_FAILED",
    "真实 MCP 联调未达到验收条件",
  );
} finally {
  cleanupCompletion();
  await engine.runtime!.close();
  await processes.close();
  await checker.close();
  await browser.close();
  for (const socket of app.websocketServer.clients) socket.terminate();
  await app.close();
  s.store.close();
}
