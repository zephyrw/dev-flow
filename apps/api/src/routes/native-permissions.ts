import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Engine } from "../../../../packages/core/src/engine.js";
import { type Run, requireCondition } from "../../../../packages/contracts/src/index.js";
import { consumeNativePermission, grantNativeMcpTool, hasNativeMcpToolPermission } from "../../../../packages/core/src/native-permission.js";
import { recoverNativePermission } from "../../../../packages/runtime/src/native-permission-recovery.js";
import type { FastifyRequest } from "fastify";
import { Id } from "../../../../packages/contracts/src/index.js";

const PermissionHookInput = z.object({
  conversationId: z.string().min(1).max(128),
  toolCall: z.object({ name: z.string().min(1).max(128), args: z.record(z.string(), z.unknown()) }).strict(),
}).strict();

export const nativePermissionPlugin: FastifyPluginAsync<{ engine: Engine; human: (req: FastifyRequest) => void }> = async (app, { engine, human }) => {
  app.post("/api/native-tool-permissions", async req => {
    human(req);
    z.object({ adapter: z.literal("agy"), tool: z.literal("call_mcp_tool"), decision: z.literal("allow") }).strict().parse(req.body);
    return { permission: grantNativeMcpTool(engine.store, "human-console") };
  });
  app.post("/api/workflows/:id/native-permissions/request", async req => {
    human(req);
    const { id } = z.object({ id: Id }).parse(req.params);
    const { expected_version } = z.object({ expected_version: z.number().int().nonnegative() }).strict().parse(req.body);
    return { interaction: recoverNativePermission(engine, id, expected_version) };
  });
  app.post("/api/worker/native-permission", async req => {
    const principal = engine.auth.verify(req.headers.authorization?.replace(/^Bearer /, ""));
    requireCondition(principal.role !== "human" && principal.run_id && principal.workflow_id,
      "FORBIDDEN", "权限决定仅供对应的执行进程读取", 403);
    const run = engine.store.must<Run>("run", principal.run_id);
    requireCondition(run.workflow_id === principal.workflow_id && run.adapter === "agy", "FORBIDDEN", "权限请求不属于当前 AGY 运行", 403);
    const input = PermissionHookInput.parse(req.body);
    const allowed = consumeNativePermission(engine, run, input.conversationId,
      { name: input.toolCall.name, parameters: input.toolCall.args });
    // The wrapper gates a second native mcp(server/tool) resource internally.
    // Forward only this authenticated call's exact resource, never a wildcard
    // native grant or a change to the user's global native permission settings.
    const { ServerName: server, ToolName: tool } = input.toolCall.args;
    const exactMcp = allowed && input.toolCall.name === "call_mcp_tool" &&
      typeof server === "string" && typeof tool === "string" &&
      /^[A-Za-z0-9_.:-]+$/.test(server) && /^[A-Za-z0-9_.:-]+$/.test(tool)
      ? `mcp(${server}/${tool})` : undefined;
    return { decision: allowed ? "allow" : "ask", reason: allowed
      ? input.toolCall.name === "call_mcp_tool" && hasNativeMcpToolPermission(engine.store) ? "USER_APPROVED_TOOL_PERMANENTLY" : "USER_APPROVED_EXACT_CALL_ONCE"
      : "NO_MATCHING_USER_GRANT", ...(exactMcp ? { permissionOverrides: [exactMcp] } : {}) };
  });
};
