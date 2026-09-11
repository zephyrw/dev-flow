import { prepared } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { writeAgyConfiguration } from "../../packages/adapters/agy/src/session.js";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
const s = await prepared();
s.config.server.port = 14814;
s.config.server.human_origin = "http://localhost:14814";
const app = await buildServer(s.engine);
await app.listen({ host: "127.0.0.1", port: 14814 });
const token = s.engine.auth.issue({
  role: "worker",
  workflow_id: s.workflow.id,
  run_id: s.principal.run_id,
});
const directory = join(s.root, "container");
writeAgyConfiguration(
  directory,
  process.execPath,
  resolve("dist/packages/bridge/src/worker.js"),
  resolve("dist/packages/bridge/src/hook.js"),
);
const command = JSON.parse(
  readFileSync(join(directory, ".agents/hooks.json"), "utf8"),
)["devflow-policy"].PreToolUse[0].hooks[0].command;
try {
  for (const name of ["call_mcp_tool", "run_command"]) {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", command], {
      windowsHide: true,
      env: {
        ...process.env,
        DEVFLOW_BASE_URL: "http://127.0.0.1:14814",
        DEVFLOW_RUN_TOKEN: token,
      },
    });
    child.stdout.on("data", (b) => console.log("OUT", b.toString()));
    child.stderr.on("data", (b) => console.error("ERR", b.toString()));
    child.stdin.end(
      JSON.stringify({
        toolCall: {
          name,
          args: {
            ServerName: "devflow_worker",
            ToolName: "devflow_execute_context",
            Arguments: {},
          },
        },
      }),
    );
    await new Promise<void>((r) => child.on("close", () => r()));
  }
} finally {
  await app.close();
  s.store.close();
}
