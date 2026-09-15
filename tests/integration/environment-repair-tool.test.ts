import { it, expect, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { prepared } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { FlowError } from "../../packages/contracts/src/index.js";

it("development environment MCP calls escalate repeated failures to diagnosis and preserve bounded recovery", async () => {
  const s = await prepared();
  const diagnose = vi
    .fn()
    .mockRejectedValue(new Error("synthetic diagnosis transport failure"));
  const stop = vi.fn().mockResolvedValue(undefined);
  s.engine.runtime = {
    prepareVerification: vi
      .fn()
      .mockRejectedValue(
        new FlowError("SERVICE_EXITED", "frontend launcher failed"),
      ),
    diagnose,
    stop,
  } as any;
  const app = await buildServer(s.engine);
  const client = new Client({ name: "environment-repair-test", version: "1" });
  try {
    await app.listen({ host: "127.0.0.1", port: 14810 });
    const token = s.engine.auth.issue({
      role: "worker",
      workflow_id: s.workflow.id,
      run_id: s.principal.run_id,
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:14810/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result: any = await client.callTool({
        name: "devflow_environment",
        arguments: { action: "restart" },
      });
      expect(result.isError).toBe(true);
      expect(s.engine.get(s.workflow.id).state).toBe("EXECUTING");
      expect(s.store.get<any>("repair_state", s.workflow.id).consecutive).toBe(
        attempt,
      );
      if (attempt === 3)
        expect(result.content[0].text).toContain(
          "继续在当前批准范围内排查原故障",
        );
    }
    expect(diagnose).toHaveBeenCalledTimes(1);
    const exhausted: any = await client.callTool({
      name: "devflow_environment",
      arguments: { action: "restart" },
    });
    expect(exhausted.isError).toBe(true);
    expect(s.engine.get(s.workflow.id)).toMatchObject({
      state: "BLOCKED",
      blocker: { code: "REPAIR_EXHAUSTED" },
    });
    await vi.waitFor(() =>
      expect(stop).toHaveBeenCalledWith(s.principal.run_id),
    );
  } finally {
    await client.close();
    await app.close();
    s.store.close();
  }
}, 30000);
