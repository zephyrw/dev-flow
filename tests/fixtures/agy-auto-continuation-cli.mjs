// Account-free AGY wire fixture. No AGY executable, network or user files are used.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("agy --print --conversation --mode --model --output-format");
  process.exit(0);
}
if (args.includes("--version")) {
  console.log("agy isolated-fixture");
  process.exit(0);
}
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const config = JSON.parse(readFileSync(join(process.cwd(), "fixture.json"), "utf8"));
assert.equal(option("--output-format"), "stream-json");
assert.equal(option("--model"), config.model);
assert.equal(option("--mode"), "accept-edits");
assert.ok(option("-p"));
const nativeFile = join(process.cwd(), "fixture-session.json");
const prior = existsSync(nativeFile) ? JSON.parse(readFileSync(nativeFile, "utf8")) : undefined;
if (prior) assert.equal(option("--conversation"), prior.id, "continuation must use the original native session");
else assert.equal(option("--conversation"), undefined, "initial invocation must create its own session");
const session = { id: prior?.id ?? randomUUID(), round: (prior?.round ?? 0) + 1 };
writeFileSync(nativeFile, JSON.stringify(session));
const step = config.rounds[session.round - 1];
assert.ok(step, "unexpected automatic invocation");
appendFileSync(join(process.cwd(), "fixture-invocations.jsonl"), JSON.stringify({
  args, session: session.id, round: session.round, run_id: process.env.DEVFLOW_RUN_ID,
}) + "\n");
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
emit({ event: "init", conversation_id: session.id, init: { model: config.model, cwd: process.cwd() } });
emit({ event: "step_update", step_update: { conversation_id: session.id, step_index: session.round * 10,
  step_type: "user_input", state: "DONE" } });
if (step.denied) emit({ event: "step_update", step_update: {
  conversation_id: session.id, step_index: session.round * 10 + 1, step_type: "tool", state: "ERROR",
  tool_info: { name: "run_command", parameters: { CommandLine: "echo fixture-needs-permission" }, error: {
    type: "TOOL_ERROR", message: "permission check failed for run_command: user denied permission for run_command",
  } },
} });
emit({ event: "step_update", step_update: { conversation_id: session.id, step_index: session.round * 10 + 2,
  step_type: "agent_response", state: "DONE" } });
emit({ event: "result", result: { conversation_id: session.id, status: step.denied ? "ERROR" : "SUCCESS",
  response: JSON.stringify(step.result), structured_output: step.result,
  ...(step.denied ? { denied_actions: [{ display_name: "run_command" }] } : {}),
} });
await new Promise(resolve => process.stdout.write("", resolve));
writeFileSync(join(process.cwd(), `fixture-emitted-${session.round}`), "emitted");
if (step.hold) {
  const deadline = Date.now() + 15000;
  while (!existsSync(join(process.cwd(), `fixture-release-${session.round}`))) {
    assert.ok(Date.now() < deadline, "fixture release was not received");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
