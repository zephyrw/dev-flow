import { it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepared } from "../helpers.js";
it("IT-12 reviewer MCP exposes only read tools and rejects foreign or changed snapshot files", async () => {
  const s = await prepared();
  s.engine.claimTask(
    s.principal,
    s.workflow.id,
    "T01",
    "只读复核入口验证，不声明产品验收通过",
  );
  const snapshot = await s.engine.freeze(s.workflow.id, s.principal);
  const manifest = join(s.root, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      snapshot,
      workspaces: s.store.list("workspace", s.workflow.id),
      evidence: [],
    }),
  );
  const client = new Client({ name: "review-reader-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/packages/bridge/src/review.js")],
        env: { DEVFLOW_REVIEW_MANIFEST: manifest },
        stderr: "pipe",
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toHaveLength(4);
    expect(names.some((n) => /apply|commit|approve/.test(n))).toBe(false);
    const read = async (path: string) =>
      await client.callTool({
        name: "devflow_review_read_file",
        arguments: { repo_id: "main", path },
      });
    const result: any = await read("app.txt");
    expect(JSON.parse(result.content[0].text).text).toBe("before\n");
    expect((await read("../outside.txt")).isError).toBe(true);
    expect((await read(".git/config")).isError).toBe(true);
    writeFileSync(join(s.repo, "app.txt"), "unexpected change");
    expect((await read("app.txt")).isError).toBe(true);
  } finally {
    await client.close();
    s.store.close();
  }
}, 60000);
