import fs from "node:fs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("codex-cli 0.154.0"); process.exit(0); }
if (args.includes("--help")) { console.log("codex exec resume --sandbox --output-schema"); process.exit(0); }
if (args.includes("app-server")) process.exit(0);
fs.readFileSync(0, "utf8");
const emit = value => process.stdout.write(JSON.stringify(value) + "\n");
emit({ type: "thread.started", thread_id: randomUUID() });
emit({ type: "turn.started" });
const response = '本地开发和测试已完成。\n```json\n{"status":"need_user","summary":"等待测试环境恢复","notes":"剩余 IT、E2E 和 OpenTabs","test_results":[{"test_id":"UT-01","case_id":"UT-01-CASE-01","status":"passed"}]}\n```\n依赖测试环境的工作保持暂停。';
emit({ type: "item.completed", item: { type: "agent_message", text: response } });
// Simulate a provider writing an unusable output file while returning valid text.
const outputFlag = args.indexOf("--output-last-message");
if (outputFlag >= 0) fs.writeFileSync(args[outputFlag + 1], "broken output file");
emit({ type: "turn.completed" });
