import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultAdapterRegistry } from "../../packages/adapters/sdk/src/index.js";
export async function runMatrixInspection() {
  const reports = await createDefaultAdapterRegistry().probeAll();
  const result = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    verification_scope:
      "local executable identity and help only; no paid model invocation",
    tools: Object.entries(reports).map(([tool, report]) => ({
      tool,
      status: report.available ? "discovered" : "blocked",
      live_workflow_verified: false,
      ...report,
    })),
  };
  mkdirSync(".cache", { recursive: true });
  writeFileSync(
    resolve(".cache/devflow-v2-matrix.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1]?.includes("devflow-v2-matrix"))
  runMatrixInspection().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
