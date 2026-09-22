import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { Store } from "../../packages/store/src/store.js";
import {
  runCli,
  applyCliSessionBindingMigration,
} from "../../scripts/migrate-cli-session-bindings.js";

describe("CW2-T16: 会话绑定迁移 CLI 脚本入口与 HTTP 同源安全集成测试", () => {
  let tempDir: string;
  let dbPath: string;
  let store: Store;
  let server: http.Server;
  let serverPort: number;
  let serverReceivedHeaders: http.IncomingHttpHeaders | undefined;
  let serverReceivedBody: any | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-bind-cli-test-"));
    dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);

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

          // 模拟 human 安全合同：拒绝 Authorization 请求头，验证 Origin 必须匹配
          if (req.headers.authorization) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "FORBIDDEN", message: "禁止携带 Authorization" }));
            return;
          }

          if (req.url?.includes("/api/workflows/wf-1/session-bindings/repair")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, patch_applied: true }));
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

  it("CW2-T16: 缺必填参数退出码非零，不存在 DB 不自动创建", async () => {
    // 缺少必填参数
    const code1 = await runCli(["preview"]);
    expect(code1).toBe(1);

    const code2 = await runCli(["preview", "--workflow", "wf-1"]);
    expect(code2).toBe(1);

    const nonExistentDb = join(tempDir, "missing.db");
    const code3 = await runCli([
      "preview",
      "--workflow",
      "wf-1",
      "--db",
      nonExistentDb,
      "--expected-workflow-version",
      "1",
    ]);
    expect(code3).toBe(1);
    expect(existsSync(nonExistentDb)).toBe(false);
  });

  it("CW2-T16: 调用旧 applyCliSessionBindingMigration 抛错，禁止直接改库", () => {
    expect(() => {
      applyCliSessionBindingMigration(store);
    }).toThrow(/禁止直接改库/);
  });

  it("CW2-T16: apply 发送合法请求含 Origin 标头且不带 Authorization，成功进入 service", async () => {
    const requestFile = join(tempDir, "repair-req.json");
    const payload = {
      source_digest: "digest-abc",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      selected_candidates: [{ candidate_id: "c1", expected_binding_revision: 0 }],
    };
    writeFileSync(requestFile, JSON.stringify(payload), "utf8");

    const apiBase = `http://127.0.0.1:${serverPort}`;
    const exitCode = await runCli([
      "apply",
      "--workflow",
      "wf-1",
      "--api-base",
      apiBase,
      "--request-file",
      requestFile,
    ]);

    expect(exitCode).toBe(0);
    expect(serverReceivedHeaders?.origin).toBe(apiBase);
    expect(serverReceivedHeaders?.authorization).toBeUndefined();
    expect(serverReceivedBody?.source_digest).toBe("digest-abc");
  });
});
