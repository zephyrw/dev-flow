import { createInterface } from "node:readline";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const logDir = process.env.MODEL_PROBE_LOG_DIR;
const control = logDir ? JSON.parse(readFileSync(join(logDir, "control.json"), "utf8")) : {};
const send = (message) => console.log(JSON.stringify(message));
const projectConfig = join(process.cwd(), ".codebuddy", "models.json");
const projectModels = existsSync(projectConfig)
  ? JSON.parse(readFileSync(projectConfig, "utf8")).models ?? []
  : [];

if (logDir && (args.includes("--help") || args.includes("--version"))) {
  appendFileSync(join(logDir, "codebuddy-metadata-cwd.jsonl"), JSON.stringify(process.cwd()) + "\n");
}

if (args.includes("--version")) {
  console.log("2.182.0");
} else if (args.includes("--help")) {
  console.log("CodeBuddy Code --print --acp --resume --permission-mode --tools --strict-mcp-config");
} else if (args.includes("--acp")) {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (logDir) appendFileSync(join(logDir, "acp-methods"), request.method + "\n");
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } });
    } else if (request.method === "_codebuddy.ai/getUserInfo") {
      const userInfo = process.env.CODEBUDDY_TEST_ACCOUNT === "signed-in"
        ? { userId: "test-uid", accessToken: "test-token" }
        : undefined;
      send({ jsonrpc: "2.0", id: request.id, result: { userInfo } });
    } else if (request.method === "session/new") {
      send({ jsonrpc: "2.0", id: request.id, ...(
        control.authRequired
          ? { error: { code: -32000, message: "Authentication required" } }
          : { result: { models: { availableModels: [
            { modelId: "auto", name: "自动选择" },
            { modelId: "example/custom-model", name: "项目模型" },
            { modelId: "hy4free", name: "Hy4" },
            { modelId: "hy4std", name: "Hy4" },
            ...projectModels.map(model => ({ modelId: model.id, name: model.name ?? model.id })),
          ] } } }
      ) });
    } else {
      process.exitCode = 1;
      break;
    }
  }
} else if (args.includes("--print") && process.env.DEVFLOW_RUN_ID && process.env.DEVFLOW_STAGE) {
  const resume = args.indexOf("--resume");
  process.argv.splice(2, args.length, ...(resume >= 0 ? ["--resume", args[resume + 1]] : []), "-");
  process.env.DEVFLOW_TEST_CODEBUDDY_STREAM = "1";
  await import("./native-cli.mjs");
} else if (args.includes("--print")) {
  for await (const _chunk of process.stdin) { /* Drain the supplied prompt. */ }
  const id = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "fixture-codebuddy-session";
  const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "example/custom-model";
  if (model.startsWith("fixture-project/") && !projectModels.some(candidate => candidate.id === model)) {
    send({ type: "result", subtype: "error", is_error: true, result: "Model not available in this project" });
    process.exit(1);
  }
  send({ type: "system", subtype: "init", session_id: id, model });
  send({ type: "assistant", message: { model, content: [{ type: "text", text: "OK" }] }, session_id: id });
  send({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: id });
}
