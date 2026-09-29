import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { prepared } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { writeAgyConfiguration } from "../../packages/adapters/agy/src/session.js";

it("IT-09 Windows Hook preserves Chinese JSON and enforces live run revocation", async () => {
  const s = await prepared();
  const port = 14820 + Math.floor(Math.random() * 20000);
  s.config.server.port = port;
  s.config.server.human_origin = `http://127.0.0.1:${port}`;
  const app = await buildServer(s.engine);
  await app.listen({ host: "127.0.0.1", port });
  const token = s.engine.auth.issue({
    role: "worker",
    workflow_id: s.workflow.id,
    run_id: s.principal.run_id,
  });
  const directory = join(s.root, "中文目录");
  const hookScript = resolve("dist/packages/bridge/src/hook.js");
  writeAgyConfiguration(
    directory,
    process.execPath,
    resolve("dist/packages/bridge/src/worker.js"),
    hookScript,
  );
  const invoke = async (name: string, server = "devflow_worker") => {
    const child = spawn(process.execPath, [hookScript], {
      windowsHide: true,
      env: {
        ...process.env,
        DEVFLOW_BASE_URL: `http://127.0.0.1:${port}`,
        DEVFLOW_RUN_TOKEN: token,
      },
    });
    let output = "";
    let errOutput = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (errOutput += b));
    child.stdin.end(
      JSON.stringify({
        toolCall: {
          name,
          args: {
            ServerName: server,
            ToolName: "devflow_execute_context",
            toolAction: '读取中文计划，保留引号 " 与换行\n',
            toolSummary: "验证双向传递",
            Arguments: {},
          },
        },
        workspacePaths: [directory],
      }),
    );
    await new Promise<void>((r, j) => {
      child.on("error", j);
      child.on("close", () => r());
    });
    if (!output.trim()) {
      throw new Error(`hook process produced no stdout. stderr: ${errOutput}`);
    }
    return JSON.parse(output);
  };
  try {
    expect((await invoke("call_mcp_tool")).decision).toBe("allow");
    expect((await invoke("run_command")).decision).toBe("deny");
    expect((await invoke("call_mcp_tool", "other_workflow")).decision).toBe(
      "deny",
    );
    s.engine.auth.revokeRun(s.principal.run_id);
    expect((await invoke("call_mcp_tool")).decision).toBe("deny");
  } finally {
    await app.close();
    s.store.close();
  }
}, 40000);
