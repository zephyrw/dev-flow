import {
  readFileSync,
  mkdirSync,
  appendFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { ProcessManager } from "../../packages/process/src/manager.js";
import {
  agyArguments,
  observeAgy,
} from "../../packages/adapters/agy/src/session.js";
import { JsonLines } from "../../packages/adapters/agy/src/protocol.js";
import { requireCondition } from "../../packages/contracts/src/index.js";
const directory = resolve(".cache/live-agy/probe"),
  output = resolve(".cache/live-agy/resume-stop");
mkdirSync(output, { recursive: true });
const first = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
const host = resolve(
    "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
  ),
  manager = new ProcessManager(host, true),
  model = "gemini-3.7-flash-high";
const executable = "C:/Users/yckj4798/AppData/Local/agy/bin/agy.exe";
try {
  const proc = manager.start({
    id: "resume-" + crypto.randomUUID(),
    executable,
    args: agyArguments(
      model,
      "What exact marker did you return in the previous turn? Return only that marker. Do not use any tools.",
      3,
      first.conversation_id,
    ),
    cwd: directory,
    env: {},
    timeout_ms: 200000,
  });
  const resumed = await observeAgy(proc, {
    model,
    conversation: first.conversation_id,
    cwd: directory,
    log: join(output, "resume.jsonl"),
    onEvent: (e) => console.log("resume", e.event),
    onDiagnostic: (t) => appendFileSync(join(output, "stderr.log"), t),
  });
  requireCondition(
    String(resumed.result.response).trim() === first.response.trim(),
    "RESUME_FAILED",
    "明确 conversation_id 未恢复上一轮信息",
  );
  console.log("EXPLICIT CONVERSATION RESUME PASSED");
  const stopId = "stop-" + crypto.randomUUID();
  let stopAt = 0,
    seenInit = false;
  const stopping = manager.start({
    id: stopId,
    executable,
    args: agyArguments(
      model,
      "This is a process cancellation test. Do not call any tools. Write a long numbered list of 2000 distinct Chinese example sentences.",
      3,
      first.conversation_id,
    ),
    cwd: directory,
    env: {},
    timeout_ms: 200000,
  });
  const lines = new JsonLines((e) => {
    if (e.event === "init") {
      seenInit = (e.init as any).model === model;
      console.log("stop init verified");
    }
    if ((e.step_update as any)?.text_delta && !stopAt) {
      stopAt = Date.now();
      void stopping.stop();
    }
  });
  stopping.on("stdout", (b: Buffer) => {
    appendFileSync(join(output, "stop.jsonl"), b);
    lines.push(b);
  });
  stopping.on("stderr", (b: Buffer) =>
    appendFileSync(join(output, "stderr.log"), b),
  );
  const exit = await stopping.completion;
  lines.finish();
  const latency = Date.now() - stopAt;
  const job = JSON.parse(
    execFileSync(host, ["job-status", stopId], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, DOTNET_ROOT: resolve(".cache/dotnet") },
    }),
  );
  const summary = {
    resume_conversation: resumed.conversation,
    resume_marker: resumed.result.response,
    resume_passed: true,
    stop_after_visible_text: stopAt > 0,
    model_verified: seenInit,
    stop_latency_ms: latency,
    exit_code: exit.code,
    job,
  };
  writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  requireCondition(
    seenInit && stopAt > 0 && latency < 5000 && !job.alive && exit.code !== 0,
    "STOP_FAILED",
    "真实 agy 进程树停止未通过",
  );
} finally {
  await manager.close();
}
