import { it, expect } from "vitest";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

async function runHookWithServer(
  handler: (req: any, reply: any) => Promise<any> | any,
  toolArgs = { ServerName: "devflow_worker", ToolName: "devflow_execute_context" },
) {
  const server = Fastify();
  server.post("/api/worker/policy", handler);
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = `http://127.0.0.1:${(server.server.address() as any).port}`;

  const hookScript = resolve("packages/bridge/src/hook.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", hookScript],
    {
      env: {
        ...process.env,
        DEVFLOW_BASE_URL: address,
        DEVFLOW_RUN_TOKEN: "mock-token",
      },
    },
  );

  let output = "";
  child.stdout.on("data", (b) => (output += b.toString()));
  child.stderr.resume();

  child.stdin.end(
    JSON.stringify({
      toolCall: {
        name: "call_mcp_tool",
        args: toolArgs,
      },
    }),
  );

  await new Promise<void>((res, rej) => {
    child.on("error", rej);
    child.on("close", () => res());
  });

  await server.close();
  return JSON.parse(output);
}

it("DF-STAGE-I04 hook preserves policy failure categories", async () => {
  // 1. 401 UNAUTHORIZED
  const res401 = await runHookWithServer(async (req, reply) => {
    reply.status(401).send({ error: { code: "UNAUTHORIZED", message: "凭证已过期" } });
  });
  expect(res401.decision).toBe("deny");
  expect(res401.reason).toBe("POLICY_UNAUTHORIZED");

  // 2. 403 TIMEOUT
  const resTimeout = await runHookWithServer(async (req, reply) => {
    reply.status(403).send({ error: { code: "TIMEOUT", message: "执行轮次已达到配置时限" } });
  });
  expect(resTimeout.decision).toBe("deny");
  expect(resTimeout.reason).toBe("POLICY_RUN_TIMEOUT");

  // 3. 403 RUN_REVOKED
  const resRevoked = await runHookWithServer(async (req, reply) => {
    reply.status(403).send({ error: { code: "RUN_REVOKED", message: "轮次已结束" } });
  });
  expect(resRevoked.decision).toBe("deny");
  expect(resRevoked.reason).toBe("POLICY_RUN_REVOKED");

  // 4. 500 HTTP ERROR
  const res500 = await runHookWithServer(async (req, reply) => {
    reply.status(500).send({ error: { code: "INTERNAL", message: "内部错误" } });
  });
  expect(res500.decision).toBe("deny");
  expect(res500.reason).toBe("POLICY_HTTP_ERROR");
});

it("DF-STAGE-I05 hook rejects malformed or mismatched allow response", async () => {
  // 1. 返回非匹配 tool 的 200
  const resMismatch = await runHookWithServer(async () => {
    return { allowed: true, tool: "devflow_other_tool" };
  });
  expect(resMismatch.decision).toBe("deny");
  expect(resMismatch.reason).toBe("POLICY_CHECK_FAILED");

  // 2. 返回 allowed: false
  const resNotAllowed = await runHookWithServer(async () => {
    return { allowed: false, tool: "devflow_execute_context" };
  });
  expect(resNotAllowed.decision).toBe("deny");
  expect(resNotAllowed.reason).toBe("POLICY_CHECK_FAILED");

  // 3. 返回正常 allowed: true 且匹配
  const resOk = await runHookWithServer(async () => {
    return { allowed: true, tool: "devflow_execute_context" };
  });
  expect(resOk.decision).toBe("allow");
  expect(resOk.reason).toBe("APPROVED_SCOPED_TOOL");
});
