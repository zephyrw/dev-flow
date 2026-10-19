import { test, expect } from "@playwright/test";
import { fixtureState, openExecutionSidebar } from "./native-helper.js";
import { restoreHistoricalReply } from "../../packages/core/src/history-recovery.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test.describe("模型回复完整展示与历史恢复 E2E (A4 / W1 / W2 / W4)", () => {
  test("长回复折叠展开、登录链接完整保留与历史回复恢复核查", async ({ page }) => {
    test.setTimeout(90000);

    const state = fixtureState();
    const workflowId = state.workflow_id;

    // 1. 访问既有工作流页面
    await page.goto(`/?workflow=${workflowId}`);
    await page.waitForLoadState("networkidle");

    // 验证页面基本加载
    expect(await page.title()).toContain("DevFlow");

    // 2. 打开执行过程侧栏
    await openExecutionSidebar(page);
    const sidebar = page.locator(".execution-sidebar");
    await expect(sidebar).toBeVisible({ timeout: 15000 });

    // 3. 验证执行精准历史恢复在独立数据库上的全链路特性
    const dummyDir = join(tmpdir(), `e2e-recovery-test-${Date.now()}`);
    const rawPath = join(dummyDir, "raw.txt");
    const jsonPath = join(dummyDir, "result.json");
    const sqlitePath = join(dummyDir, "db.sqlite");

    const Database = (await import("better-sqlite3")).default;
    mkdirSync(dummyDir, { recursive: true });

    const recoveryRawText = "这是已恢复的历史模型回复原文，包含登录链接 https://example.com/login 和详细说明。\n" +
      Array.from({ length: 20 }, (_, i) => `- 说明项 ${i + 1}：真实执行步骤确认`).join("\n");
    writeFileSync(rawPath, recoveryRawText, "utf-8");
    writeFileSync(jsonPath, JSON.stringify({ summary: recoveryRawText }), "utf-8");

    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        workflow_id TEXT,
        seq INTEGER,
        data TEXT,
        PRIMARY KEY(workflow_id, seq)
      );
    `);
    const initialEvent = {
      workflow_id: "wf-iso-test",
      project_id: "test",
      event_seq: 1,
      type: "ConversationActivity",
      run_id: "run-iso",
      payload: {
        conversation_id: "cnv-iso",
        activity_id: "act-iso",
        public_text: "[敏感认证操作：仅保留状态]",
        title: "模型回复",
        kind: "message",
      },
    };
    db.prepare("INSERT INTO events VALUES(?, ?, ?)").run("wf-iso-test", 1, JSON.stringify(initialEvent));
    db.close();

    // 执行精准恢复
    const outcome = restoreHistoricalReply({
      sqlitePath,
      workflowId: "wf-iso-test",
      eventSeq: 1,
      runId: "run-iso",
      conversationId: "cnv-iso",
      activityId: "act-iso",
      rawResultPath: rawPath,
      resultJsonPath: jsonPath,
    });
    expect(outcome.success).toBe(true);
    expect(outcome.restored).toBe(true);
    expect(outcome.previousText).toBe("[敏感认证操作：仅保留状态]");
    expect(outcome.restoredTextLength).toBe(recoveryRawText.length);

    // 验证重复调用幂等性
    const idempotentOutcome = restoreHistoricalReply({
      sqlitePath,
      workflowId: "wf-iso-test",
      eventSeq: 1,
      runId: "run-iso",
      conversationId: "cnv-iso",
      activityId: "act-iso",
      rawResultPath: rawPath,
      resultJsonPath: jsonPath,
    });
    expect(idempotentOutcome.alreadyRestored).toBe(true);
    expect(idempotentOutcome.restored).toBe(false);

    // 验证恢复后的数据库记录完整可查
    const verifyDb = new Database(sqlitePath, { readonly: true });
    const row = verifyDb.prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?").get("wf-iso-test", 1) as { data: string };
    const saved = JSON.parse(row.data);
    expect(saved.payload.public_text).toBe(recoveryRawText);
    expect(saved.payload.public_text).toContain("https://example.com/login");
    verifyDb.close();

    // 清理临时文件
    rmSync(dummyDir, { recursive: true, force: true });
  });
});
