import { workerNames } from "../../mcp/src/tools.js";
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1048576) break;
}
let decision = "deny",
  reason =
    "POLICY_DEFAULT_DENY: 使用已批准的 devflow_worker 工具。需要额外命令时调用 devflow_request_operation，由工作台展示具体操作并取得用户授权；不要请求用户去其他客户端处理。";
let permissionOverrides: string[] = [];
try {
  const event = JSON.parse(raw);
  const tool = String(event.toolCall?.name ?? "");
  const args = event.toolCall?.args;
  const wrapped =
    tool === "call_mcp_tool" && args?.ServerName === "devflow_worker"
      ? args.ToolName
      : undefined;
  const name = workerNames.find(
    (n) =>
      wrapped === n ||
      tool === `mcp_devflow_worker_${n}` ||
      tool === `mcp__devflow_worker__${n}` ||
      tool === `devflow_worker/${n}`,
  );
  if (name) {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(
          new URL("/api/worker/policy", process.env.DEVFLOW_BASE_URL),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.DEVFLOW_RUN_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ tool: name }),
            signal: AbortSignal.timeout(15000),
          },
        );
        if (response) break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (response?.ok) {
      try {
        const text = await response.text();
        const data = JSON.parse(text);
        if (
          data &&
          data.allowed === true &&
          (!data.tool || data.tool === name)
        ) {
          decision = "allow";
          reason = "APPROVED_SCOPED_TOOL";
          permissionOverrides = [`mcp(devflow_worker/${name})`];
        } else {
          decision = "deny";
          reason = "POLICY_CHECK_FAILED";
        }
      } catch {
        decision = "deny";
        reason = "POLICY_CHECK_FAILED";
      }
    } else if (response) {
      decision = "deny";
      try {
        const text = await response.text();
        if (text.length <= 65536) {
          const body = JSON.parse(text);
          const code = body?.error?.code || body?.code;
          if (code === "TIMEOUT") {
            reason = "POLICY_RUN_TIMEOUT";
          } else if (code === "UNAUTHORIZED") {
            reason = "POLICY_UNAUTHORIZED";
          } else if (code === "RUN_REVOKED") {
            reason = "POLICY_RUN_REVOKED";
          } else {
            reason = "POLICY_HTTP_ERROR";
          }
        } else {
          reason = "POLICY_HTTP_ERROR";
        }
      } catch {
        reason = "POLICY_HTTP_ERROR";
      }
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      component: "devflow-hook",
      error: error instanceof Error ? error.message : String(error),
      hasBase: !!process.env.DEVFLOW_BASE_URL,
      hasRunToken: !!process.env.DEVFLOW_RUN_TOKEN,
      inputLength: raw.length,
      ...(process.env.DEVFLOW_HOOK_DEBUG === "1" ? { input: raw } : {}),
    }),
  );
  reason = "POLICY_CHECK_FAILED";
}
process.stdout.write(JSON.stringify({ decision, reason, permissionOverrides }));
