import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Store } from "../../packages/store/src/store.js";
import {
  runCli,
  applyProjectAssetMigration,
} from "../../scripts/migrate-project-assets.js";

describe("CW2-T03: 资产迁移 CLI 脚本入口与防旁路集成测试", () => {
  let tempDir: string;
  let dbPath: string;
  let store: Store;
  let server: http.Server;
  let serverPort: number;
  let serverReceivedHeaders: http.IncomingHttpHeaders | undefined;
  let serverReceivedBody: any | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-asset-cli-test-"));
    dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);

    // 建立一个轻量的模拟 HTTP 服务端，用于测试 apply/resume/rollback 请求携带 Origin
    await new Promise<void>((resolve) => {
      server = http.createServer((req, res) => {
        serverReceivedHeaders = req.headers;
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            serverReceivedBody = JSON.parse(body);
          } catch {
            serverReceivedBody = body;
          }
          if (req.url?.includes("/api/workflows/wf-1/assets/apply")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ stage: "committed", success: true }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      server.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("CW2-T03: 缺参数退出码非零，不存在 DB 不自动创建父目录或文件", async () => {
    // 缺少必填参数退出码为 1
    const exitCode1 = await runCli(["preview"]);
    expect(exitCode1).toBe(1);

    // 不存在的 DB 路径
    const nonExistentDb = join(tempDir, "not_exist", "missing.db");
    const exitCode2 = await runCli([
      "preview",
      "--db",
      nonExistentDb,
      "--workflow",
      "wf-1",
      "--workspace",
      "ws-1",
    ]);
    expect(exitCode2).toBe(1);
    expect(existsSync(nonExistentDb)).toBe(false);
  });

  it("CW2-T03: 调用旧 applyProjectAssetMigration 导出明确抛错，禁止直接改库", () => {
    expect(() => {
      applyProjectAssetMigration(store);
    }).toThrow(/禁止直接改库/);
  });

  it("CW2-T03: apply/resume/rollback 必须通过 HTTP 服务并携带 Origin 头部，禁止离线写库", async () => {
    const requestFile = join(tempDir, "request.json");
    const payload = {
      workflow_id: "wf-1",
      workspace_id: "ws-1",
      request_id: "req-cli-001",
      expected_workspace_version: 1,
      expected_preview_digest: "digest-123",
    };
    writeFileSync(requestFile, JSON.stringify(payload), "utf8");

    const apiBase = `http://127.0.0.1:${serverPort}`;
    const exitCode = await runCli([
      "apply",
      "--api-base",
      apiBase,
      "--workflow",
      "wf-1",
      "--request-file",
      requestFile,
    ]);

    expect(exitCode).toBe(0);
    // 验证 HTTP 请求必须携带 Origin 标头，满足同源保护合同
    expect(serverReceivedHeaders?.origin).toBe(apiBase);
    expect(serverReceivedBody?.request_id).toBe("req-cli-001");
  });
});
