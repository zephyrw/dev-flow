import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { workerNames } from "../../mcp/src/tools.js";
const base = process.env.DEVFLOW_BASE_URL,
  token = process.env.DEVFLOW_RUN_TOKEN;
if (!base || !token) throw new Error("Missing scoped runtime credentials");
console.error("[DevFlow bridge] starting scoped stdio transport");
const client = new Client({ name: "devflow-worker-bridge", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", base), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const server = new McpServer({ name: "devflow_worker", version: "0.1.0" });
const listed = await client.listTools();
console.error(
  `[DevFlow bridge] discovered ${listed.tools.length} scoped tools`,
);
for (const tool of listed.tools) {
  if (!workerNames.includes(tool.name as (typeof workerNames)[number]))
    continue;
  const schema = z.fromJSONSchema(
    tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
  ) as z.ZodObject;
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: schema },
    async (args) =>
      (await client.callTool(
        { name: tool.name, arguments: args },
        { timeout: 7_300_000 },
      )) as any,
  );
}
await server.connect(new StdioServerTransport());
