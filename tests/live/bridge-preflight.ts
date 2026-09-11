import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { prepared } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
const s = await prepared();
s.config.server.port = 14813;
s.config.server.human_origin = "http://localhost:14813";
const app = await buildServer(s.engine);
await app.listen({ host: "127.0.0.1", port: 14813 });
const token = s.engine.auth.issue({
  role: "worker",
  workflow_id: s.workflow.id,
  run_id: s.principal.run_id,
});
const client = new Client({ name: "bridge-preflight", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/packages/bridge/src/worker.js")],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (x): x is [string, string] => x[1] !== undefined,
      ),
    ),
    DEVFLOW_BASE_URL: "http://127.0.0.1:14813",
    DEVFLOW_RUN_TOKEN: token,
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (b: Buffer) => console.error(b.toString()));
try {
  await client.connect(transport);
  console.log(
    "TOOLS",
    JSON.stringify((await client.listTools()).tools.map((t) => t.name)),
  );
  const result = await client.callTool({
    name: "devflow_execute_context",
    arguments: {},
  });
  console.log(
    "CONTEXT",
    JSON.stringify({ isError: result.isError, hasContent: result.content }),
  );
} finally {
  await client.close();
  await app.close();
  s.store.close();
}
