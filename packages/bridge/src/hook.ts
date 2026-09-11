import { workerNames } from "../../mcp/src/tools.js";
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 1048576) break;
}
let decision = "deny",
  reason = "POLICY_DEFAULT_DENY";
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
    const response = await fetch(
      new URL("/api/worker/policy", process.env.DEVFLOW_BASE_URL),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.DEVFLOW_RUN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ tool: name }),
        signal: AbortSignal.timeout(3000),
      },
    );
    if (response.ok) {
      decision = "allow";
      reason = "APPROVED_SCOPED_TOOL";
      permissionOverrides = [`mcp(devflow_worker/${name})`];
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
