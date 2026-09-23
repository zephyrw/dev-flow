import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { ProcessManager } from "../../packages/process/src/manager.js";
import {
  agyArguments,
  observeAgy,
} from "../../packages/adapters/agy/src/session.js";
import { writeAgyNativeConfiguration } from "../../packages/adapters/agy/src/native-adapter.js";
import { NativeExecutionObserver } from "../../packages/evidence/src/native-execution-observer.js";
import type { HostToolExecutionFact } from "../../packages/evidence/src/native-run-records.js";
import type { Workspace } from "../../packages/contracts/src/index.js";
import { AgyNativeRecordSource } from "../../packages/adapters/agy/src/native-record-source.js";
import { redact } from "../../packages/core/src/util.js";

const asynchronous = process.argv.includes("--async");
const expectedExit = process.argv.includes("--fail") ? 1 : 0;
const resumeRoot=process.argv.find(a=>a.startsWith("--resume-root="))?.slice("--resume-root=".length);
const root = resumeRoot ?? mkdtempSync(join(tmpdir(), "devflow-native-live-"));
const resumeConversation=resumeRoot ? readFileSync(join(root,".devflow","host.jsonl"),"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)).find(e=>e.event==="init")?.conversation_id : undefined;
mkdirSync(join(root, ".reports"),{recursive:true});
mkdirSync(join(root, ".devflow"),{recursive:true});
writeFileSync(join(root, "input.txt"), "correct");
writeFileSync(
  join(root, "test.cjs"),
  "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('input is correct',()=>assert.equal(fs.readFileSync('input.txt','utf8'),'correct'));",
);
if (asynchronous)
  writeFileSync(
    join(root, "test.cjs"),
    "const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');test('input is correct',async()=>{await new Promise(r=>setTimeout(r,6000));assert.equal(fs.readFileSync('input.txt','utf8'),'correct')});",
  );
if (expectedExit) writeFileSync(join(root, "input.txt"), "incorrect");
writeAgyNativeConfiguration(root, process.execPath);
const facts: HostToolExecutionFact[] = [];
const records = new AgyNativeRecordSource(homedir());
const observer = new NativeExecutionObserver({
  readHostStep: (c, i) => records.read(c, i),
  workflow_id: "live-fixture",
  run_id: "live-run",
  plan_hash: "live-plan",
  workspaces: [{ repo_id: "main", root } as Workspace],
  save: (f) => facts.push(f),
});
const events: Record<string, number> = {};
const tools: Record<string, number> = {};
const manager = new ProcessManager();
const prompt =
  (asynchronous
    ? "Set WaitMsBeforeAsync to 500 so the terminal command is asynchronous; poll command_status until it exits. "
    : "") +
  "This is an isolated native-tool integration fixture, already prepared. Work only inside " +
  root +
  ". Use your native run_command terminal tool to run exactly: node --test --test-reporter=junit --test-reporter-destination=.reports/unit.xml test.cjs . Set Cwd to the fixture directory. If asynchronous, use command_status until completed. Do not edit any files or access another project. Do not use DevFlow MCP, do not plan a project. After the one test command, report its actual exit code and stop.";
const proc = manager.start({
  id: "native-live-" + Date.now(),
  executable: "C:/Users/yckj4798/AppData/Local/agy/bin/agy.exe",
  args: agyArguments("gemini-3.7-flash-high", prompt, 3,resumeConversation),
  cwd: root,
  env: {},
  timeout_ms: 190000,
});
let error: string | undefined;
try {
  await observeAgy(proc, {
    model: "gemini-3.7-flash-high",
    conversation:resumeConversation,
    cwd: root,
    log: join(root, ".devflow", "host.jsonl"),
    onEvent: (e) => {
      observer.accept(e);
      const step = e.step_update as any;
      if (step) {
        events[step.step_type + ":" + step.state] =
          (events[step.step_type + ":" + step.state] ?? 0) + 1;
        if (step.step_type === "tool") {
          const name = step.tool_name ?? step.tool_info?.name;
          tools[name] = (tools[name] ?? 0) + 1;
        }
      }
    },
    onDiagnostic: () => {},
  });
} catch (e) {
  error = redact(String(e));
} finally {
  await manager.close();
}
const summary = {
  root,
  resumed:!!resumeConversation,
  error,
  events,
  tools,
  facts: facts.map((f) => ({
    tool_call_id: f.tool_call_id,
    exit_code: f.exit_code,
    has_inputs: !!f.input_fingerprints,
    reports: Object.keys(f.report_hashes ?? {}),
    evidence_error: f.evidence_error,
  })),
};
writeFileSync(join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (
  error ||
  !facts.some(
    (f) =>
      f.exit_code === expectedExit &&
      Object.keys(f.report_hashes ?? {}).length > 0 &&
      !f.evidence_error,
  )
)
  process.exitCode = 1;
