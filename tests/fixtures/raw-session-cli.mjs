import fs from "node:fs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.154.0"); process.exit(0); }
if (args.includes("--help")) { console.log("codex exec resume --sandbox --output-schema"); process.exit(0); }
if (args.includes("app-server")) process.exit(0);
const prompt = fs.readFileSync(0, "utf8");
const resume = args.indexOf("resume");
const session = resume >= 0 ? args[resume + 1] : randomUUID();
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
emit({ type: "thread.started", thread_id: session });
emit({ type: "turn.started" });
const result = { status: "need_user", summary: "fixture received input", captured_text: prompt, captured_args: args };
emit({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } });
const outputFlag = args.indexOf("--output-last-message");
if (outputFlag >= 0) fs.writeFileSync(args[outputFlag + 1], JSON.stringify(result));
emit({ type: "turn.completed" });
