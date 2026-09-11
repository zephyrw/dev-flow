import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { ensureService, plannerToken } from "../../service/src/launcher.js";

// Codex owns only this bridge. Closing the conversation leaves the controller alive.
async function connect() {
  const { endpoint } = await ensureService();
  const client = new Client({ name: "devflow-planner-bridge", version: "0.2.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${plannerToken()}` } },
    }));
    return client;
  } catch (error) { await client.close(); throw error; }
}
const discovery = await connect();
const server = new McpServer({ name: "devflow", version: "0.2.0" });
const allowed = new Set(["devflow_start", "devflow_register_project", "devflow_list_projects",
  "devflow_create_workflow", "devflow_get_workflow", "devflow_submit_plan"]);
for (const tool of (await discovery.listTools()).tools) {
  if (!allowed.has(tool.name)) continue;
  const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodObject;
  server.registerTool(tool.name, { description: tool.description, inputSchema: schema, annotations: tool.annotations },
    async args => {
      const client = await connect();
      try { return await client.callTool({ name: tool.name, arguments: args }, { timeout: 120000 }) as any; }
      finally { await client.close(); }
    });
}
await discovery.close();
await server.connect(new StdioServerTransport());
