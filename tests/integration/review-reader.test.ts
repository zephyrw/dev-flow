import { it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { prepared } from "../helpers.js";
import { reviewSkillResources } from "../../packages/runtime/src/review-materials.js";
import { hash } from "../../packages/core/src/util.js";
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
      skill_resources: reviewSkillResources(),
      review_contract: { run_id: "review-current", next_plan_revision: 2 },
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
    expect(names).toHaveLength(5);
    expect(names.some((n) => /apply|commit|approve/.test(n))).toBe(false);
    const hashed: any = await client.callTool({
      name: "devflow_review_hash_document",
      arguments: { text: "# 整改\r\n完整正文" },
    });
    expect(JSON.parse(hashed.content[0].text).document_hash).toBe(
      hash("# 整改\n完整正文"),
    );
    let resourceText = "",
      offset: number | null = 0;
    while (offset !== null) {
      const response: any = await client.callTool({
        name: "devflow_review_context",
        arguments: { section: "skill_resources", offset },
      });
      expect(response.isError).not.toBe(true);
      const page = JSON.parse(response.content[0].text);
      resourceText += page.text;
      offset = page.next_offset;
    }
    const resources = JSON.parse(resourceText);
    expect(
      resources["devflow-review/references/repair-document-contract.md"],
    ).toBe(
      readFileSync(
        resolve(
          "packages/skills/devflow-review/references/repair-document-contract.md",
        ),
        "utf8",
      ),
    );
    expect(resources["devflow-test/SKILL.md"]).toContain("E2E");
    const contract: any = await client.callTool({
      name: "devflow_review_context",
      arguments: { section: "review_contract" },
    });
    expect(JSON.parse(JSON.parse(contract.content[0].text).text).run_id).toBe(
      "review-current",
    );
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
