import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { safePath } from "../../workspace/src/files.js";
import { hash } from "../../core/src/util.js";
import {
  requireCondition,
  Id,
  RelativePath,
  type Snapshot,
  type Workspace,
  type Evidence,
} from "../../contracts/src/index.js";
const path = process.env.DEVFLOW_REVIEW_MANIFEST;
requireCondition(path, "MANIFEST_REQUIRED", "缺少只读复核材料清单");
const manifest = JSON.parse(readFileSync(path, "utf8"));
const server = new McpServer({ name: "devflow_review", version: "0.1.0" });
const register = (
  name: string,
  description: string,
  schema: z.ZodObject,
  fn: (a: any) => unknown,
) =>
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (a) => {
      try {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(fn(a)) }],
        };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: e instanceof Error ? e.message : String(e),
              }),
            },
          ],
        };
      }
    },
  );
const page = (text: string, offset: number) => {
  requireCondition(offset <= text.length, "OFFSET_INVALID", "偏移越界");
  const end = Math.min(text.length, offset + 2000);
  return {
    text: text.slice(offset, end),
    offset,
    next_offset: end < text.length ? end : null,
    total_characters: text.length,
  };
};
register(
  "devflow_review_context",
  "分页读取 plan、skill_resources、review_contract 等审查材料。skill_resources 含代码质量审查与职责说明。读取直到 next_offset 为 null。",
  z.object({
    section: z.enum([
      "plan",
      "plan_record",
      "plan_authorities",
      "executor_plan_check",
      "executor_plan_check_report",
      "approval",
      "acceptance",
      "project",
      "claims",
      "evidence",
      "delivery_materials",
      "skill",
      "skill_resources",
      "review_contract",
      "diff",
      "snapshot",
      "workspaces",
    ]),
    offset: z.number().int().nonnegative().default(0),
  }),
  (a) => page(JSON.stringify(manifest[a.section] ?? null), a.offset),
);
register(
  "devflow_review_hash_document",
  "计算完整整改正文的 SHA-256（统一 LF 换行），用于逐项整改合同 document_hash；纯计算，不写入文件。",
  z.object({ text: z.string().min(1).max(2000000) }),
  (a) => ({ document_hash: hash(a.text.replace(/\r\n/g, "\n")) }),
);
const read = (repo: string, path: string) => {
  const workspace = (manifest.workspaces as Workspace[]).find(
      (w) => w.repo_id === repo,
    ),
    snapshot = (manifest.snapshot as Snapshot).repositories.find(
      (r) => r.repo_id === repo,
    );
  requireCondition(workspace && snapshot, "REPO_DENIED", "仓库不在复核清单");
  const data = readFileSync(safePath(workspace.root, path));
  const file = snapshot.files.find((f) => f.path === path);
  return {
    file: file ?? { path, hash: hash(data) },
    text: data.toString("utf8"),
  };
};
register(
  "devflow_review_read_file",
  "只读当前仓库工作区内的文件，受客户端路径边界保护。",
  z.object({
    repo_id: Id,
    path: RelativePath,
    offset: z.number().int().nonnegative().default(0),
  }),
  (a) => {
    const data = read(a.repo_id, a.path);
    return { path: a.path, hash: data.file.hash, ...page(data.text, a.offset) };
  },
);
register(
  "devflow_review_search",
  "在冻结仓库文件中查找上下游引用，结果最多 30 条。",
  z.object({ repo_id: Id, query: z.string().min(1).max(200) }),
  (a) => {
    const repo = (manifest.snapshot as Snapshot).repositories.find(
      (r) => r.repo_id === a.repo_id,
    );
    requireCondition(repo, "REPO_DENIED", "仓库不在复核清单");
    const hits = [];
    for (const file of repo.files) {
      if (hits.length >= 30) break;
      const data = read(a.repo_id, file.path);
      if (data.text.length > 1000000) continue;
      const index = data.text.indexOf(a.query);
      if (index >= 0)
        hits.push({
          path: file.path,
          offset: index,
          text: data.text.slice(Math.max(0, index - 100), index + 300),
        });
    }
    return hits;
  },
);
register(
  "devflow_review_evidence",
  "读取由控制器登记的原始测试报告并验证哈希，不接受任意文件路径。",
  z.object({
    evidence_id: Id,
    index: z.number().int().nonnegative().default(0),
    offset: z.number().int().nonnegative().default(0),
  }),
  (a) => {
    const evidence = (manifest.evidence as Evidence[]).find(
        (e) => e.id === a.evidence_id,
      ),
      file = evidence?.files[a.index];
    requireCondition(file, "EVIDENCE_DENIED", "证据不在本次复核范围");
    const raw = readFileSync(file.path);
    return { hash: hash(raw), ...page(raw.toString("utf8"), a.offset) };
  },
);
await server.connect(new StdioServerTransport());
