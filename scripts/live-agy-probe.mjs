import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
const root = resolve(".cache/live-agy/probe");
mkdirSync(root, { recursive: true });
const model = "gemini-3.7-flash-high",
  marker = "DEVFLOW-LIVE-ROUNDTRIP-731946";
const start = Date.now();
const args = [
  "--model",
  model,
  "--effort",
  "high",
  "--output-format",
  "stream-json",
  "--print-timeout",
  "3m",
  "--log-file",
  join(root, "agy-internal.log"),
  "-p",
  `This is an authorized DevFlow integration test. Do not call any tools or read any files. Reply exactly: ${marker}`,
];
const child = spawn("C:/Users/yckj4798/AppData/Local/agy/bin/agy.exe", args, {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let buffer = "",
  events = [],
  stderr = "";
child.stdout.on("data", (b) => {
  appendFileSync(join(root, "stdout.jsonl"), b);
  buffer += b.toString("utf8");
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      events.push({ ...e, observed_ms: Date.now() - start });
      console.log(
        JSON.stringify({
          event: e.event,
          model: e.init?.model,
          step_type: e.step_update?.step_type,
          text: e.step_update?.text_delta,
          status: e.result?.status,
          elapsed_ms: Date.now() - start,
        }),
      );
    } catch {
      console.log("Non-JSON stdout detected");
    }
  }
});
child.stderr.on("data", (b) => {
  appendFileSync(join(root, "stderr.log"), b);
  stderr += b.toString("utf8");
});
const timer = setTimeout(() => child.kill(), 210000);
child.on("close", (code) => {
  clearTimeout(timer);
  const init = events.find((e) => e.event === "init"),
    result = events.find((e) => e.event === "result");
  const summary = {
    requested_model: model,
    reported_model: init?.init?.model,
    conversation_id: init?.conversation_id,
    exit_code: code,
    result_status: result?.result?.status,
    response: result?.result?.response,
    roundtrip_ok: result?.result?.response?.trim() === marker,
    first_event_ms: events[0]?.observed_ms,
    events: events.length,
    duration_ms: Date.now() - start,
    stderr_bytes: Buffer.byteLength(stderr),
  };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
  process.exitCode =
    code === 0 && summary.roundtrip_ok && summary.reported_model === model
      ? 0
      : 1;
});
