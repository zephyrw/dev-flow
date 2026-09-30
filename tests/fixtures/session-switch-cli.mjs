import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const [adapter, ...args] = process.argv.slice(2);
if (args.includes("--version")) { console.log(adapter === "codex" ? "codex-cli 0.154.0" : "agy 1.0.0"); process.exit(0); }
if (args.includes("--help")) { console.log(`${adapter} exec resume --conversation --output-format --model --sandbox --output-schema`); process.exit(0); }
if (args.includes("app-server")) process.exit(0);
const index = args.indexOf(adapter === "codex" ? "resume" : "--conversation");
const resumed = index >= 0 ? args[index + 1] : undefined;
const native = resumed ?? randomUUID();
const file = path.join(process.cwd(), `.fixture-session-${native}.json`);
if (resumed && !fs.existsSync(file)) { console.error(`No saved session found with ID ${native}`); process.exit(1); }
const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
const prompt = adapter === "codex" ? fs.readFileSync(0, "utf8") : args[args.indexOf("-p") + 1];
const model = args[args.indexOf("--model") + 1];
fs.writeFileSync(file, JSON.stringify([...previous, { model, prompt }]));
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
const result = { status: "need_user", summary: "fixture received input", captured_text: prompt, captured_model: model, previous_turns: previous.length };
if (adapter === "codex") {
  emit({ type: "thread.started", thread_id: native }); emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } });
  const output = args.indexOf("--output-last-message"); if (output >= 0) fs.writeFileSync(args[output + 1], JSON.stringify(result));
  emit({ type: "turn.completed" });
} else {
  emit({ event: "init", conversation_id: native });
  emit({ event: "step_update", step_update: { step_type: "user_input", state: "DONE" } });
  emit({ event: "result", result: { response: JSON.stringify(result), error: false } });
}
