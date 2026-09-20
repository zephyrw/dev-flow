import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const logDir = process.env.MODEL_PROBE_LOG_DIR;
if (!logDir) throw new Error("Fixture log directory missing");
const log = (value) => appendFileSync(join(logDir, "rpc.jsonl"), JSON.stringify(value) + "\n");
log({ args });
if (args.includes("--version")) {
  console.log("codex fixture 1.0");
} else if (args.includes("--help")) {
  console.log("codex app-server --profile <name>");
} else if (args.includes("app-server")) {
  let initialized = false;
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line);
    log({ method: request.method, params: request.params });
    if (request.method === "initialize") {
      console.log(JSON.stringify({ id: request.id, result: {} }));
    } else if (request.method === "initialized") {
      initialized = true;
    } else if (request.method === "model/list") {
      if (!initialized) {
        console.log(JSON.stringify({ id: request.id, error: { message: "Not initialized" } }));
        process.exitCode = 1;
        lines.close();
        break;
      }
      const second = request.params.cursor === "page-2";
      console.log(JSON.stringify({
        id: request.id,
        result: {
          data: [{
            id: second ? "fixture-second" : "fixture-first",
            model: second ? "fixture-second" : "fixture-first",
            displayName: second ? "Second model" : "First model",
            hidden: false,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          }],
          nextCursor: second ? null : "page-2",
        },
      }));
    }
  }
} else {
  throw new Error("Fixture only supports version/help/catalog");
}
