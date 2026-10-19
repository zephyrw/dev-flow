import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Engine } from "../../../../packages/core/src/engine.js";
import { type Run, requireCondition } from "../../../../packages/contracts/src/index.js";
import { consumeNativePermission, grantNativeMcpPermission, findNativeMcpPermission, mcpTarget } from "../../../../packages/core/src/native-permission.js";
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
    const name = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
    const input = z.object({ adapter: z.literal("agy"), server: name, method: name,
      scope: z.enum(["service", "method"]), decision: z.literal("allow") }).strict().parse(req.body);
    return { permission: grantNativeMcpPermission(engine.store, "human-console", input, input.scope) };
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
    const target = mcpTarget({ name: input.toolCall.name, parameters: input.toolCall.args });
    const exactMcp = allowed && target ? `mcp(${target.server}/${target.method})` : undefined;
    return { decision: allowed ? "allow" : "ask", reason: allowed
      ? target ? findNativeMcpPermission(engine.store, target) ? "USER_APPROVED_MCP_SCOPE_PERMANENTLY" : "USER_APPROVED_MCP_SCOPE_ONCE" : "USER_APPROVED_EXACT_CALL_ONCE"
      : "NO_MATCHING_USER_GRANT", ...(exactMcp ? { permissionOverrides: [exactMcp] } : {}) };
  });
};
