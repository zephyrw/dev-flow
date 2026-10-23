import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  restoreHistoricalReply,
  verifySourceMaterial,
  type HistoryRecoveryTarget,
} from "../../packages/core/src/history-recovery.js";
import { canonical } from "../../packages/core/src/util.js";

describe("精准历史回复恢复模块 (W4 / A3)", () => {
  let testDir: string;
  let sqlitePath: string;
  let rawResultPath: string;
  let resultJsonPath: string;

  const targetWorkflow = "wf-test-recovery-123";
  const targetSeq = 16879;
  const targetRunId = "run-test-run-456";
  const targetConversationId = "cnv-test-conv-789";
  const targetActivityId = "d39a5c95-reply-test";
  const sampleRawText = "这是需要恢复的模型回复原文，包含普通 https://example.com/login 链接与指导说明。";

  beforeEach(() => {
    testDir = join(tmpdir(), `test-devflow-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    sqlitePath = join(testDir, "test.sqlite");
    rawResultPath = join(testDir, "raw-result.txt");
    resultJsonPath = join(testDir, "result.json");

    // 写入合成的源文件
    writeFileSync(rawResultPath, sampleRawText, "utf-8");
    writeFileSync(resultJsonPath, JSON.stringify({ summary: sampleRawText }), "utf-8");

    // 创建测试数据库与初始事件
    const db = new Database(sqlitePath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        workflow_id TEXT,
        seq INTEGER,
        data TEXT,
        PRIMARY KEY(workflow_id, seq)
      );
    `);

    // 预置目标事件（处于被敏感替换状态）
    const targetEvent = {
      workflow_id: targetWorkflow,
      project_id: "test-project",
      event_seq: targetSeq,
      type: "ConversationActivity",
      run_id: targetRunId,
      created_at: "2026-10-19T08:42:11.442Z",
      payload: {
        conversation_id: targetConversationId,
        attempt_id: "attempt-1",
        root_id: targetConversationId,
        activity_id: targetActivityId,
        public_text: "[敏感认证操作：仅保留状态]",
        title: "模型回复",
        kind: "message",
        status: "completed",
      },
    };
    db.prepare("INSERT INTO events VALUES(?, ?, ?)").run(
      targetWorkflow,
      targetSeq,
      canonical(targetEvent),
    );

    // 预置一条同工作流的其他事件
    const otherEvent = {
      workflow_id: targetWorkflow,
      project_id: "test-project",
      event_seq: targetSeq + 1,
      type: "ConversationActivity",
      run_id: targetRunId,
      created_at: "2026-10-19T08:43:00.000Z",
      payload: {
        conversation_id: targetConversationId,
        activity_id: "other-activity",
        public_text: "其他不受影响的消息",
      },
    };
    db.prepare("INSERT INTO events VALUES(?, ?, ?)").run(
      targetWorkflow,
      targetSeq + 1,
      canonical(otherEvent),
    );

    // 预置另一个工作流的事件
    const unrelatedEvent = {
      workflow_id: "wf-unrelated-999",
      project_id: "test-project",
      event_seq: 1,
      type: "RunStarted",
      run_id: "run-unrelated",
      created_at: "2026-10-19T08:00:00.000Z",
      payload: { status: "running" },
    };
    db.prepare("INSERT INTO events VALUES(?, ?, ?)").run(
      "wf-unrelated-999",
      1,
      canonical(unrelatedEvent),
    );

    db.close();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it("应当能精准恢复目标消息，并保留审计记录与旧值备份", () => {
    const target: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath,
    };

    const outcome = restoreHistoricalReply(target);
    expect(outcome.success).toBe(true);
    expect(outcome.restored).toBe(true);
    expect(outcome.alreadyRestored).toBe(false);
    expect(outcome.previousText).toBe("[敏感认证操作：仅保留状态]");
    expect(outcome.restoredTextLength).toBe(sampleRawText.length);

    // 验证数据库内更新
    const db = new Database(sqlitePath);
    const row = db
      .prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?")
      .get(targetWorkflow, targetSeq) as { data: string };
    const saved = JSON.parse(row.data);
    expect(saved.payload.public_text).toBe(sampleRawText);
    expect(saved.payload.backup_previous_text).toBe("[敏感认证操作：仅保留状态]");
    expect(saved.payload.restored_at).toBeDefined();

    // 验证非目标数据未受改动
    const otherRow = db
      .prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?")
      .get(targetWorkflow, targetSeq + 1) as { data: string };
    expect(JSON.parse(otherRow.data).payload.public_text).toBe("其他不受影响的消息");

    const unrelatedRow = db
      .prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?")
      .get("wf-unrelated-999", 1) as { data: string };
    expect(JSON.parse(unrelatedRow.data).type).toBe("RunStarted");
    db.close();
  });

  it("重复调用时应具有幂等性，不重复写入也不抛异常", () => {
    const invalidated: Array<{ workflowId: string; eventSeq?: number }> = [];
    const mockStore = {
      invalidatePublicEvent: (workflowId: string, eventSeq?: number) => {
        invalidated.push({ workflowId, eventSeq });
      },
    };

    const target: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath,
      store: mockStore,
    };

    // 第一次调用恢复
    const first = restoreHistoricalReply(target);
    expect(first.restored).toBe(true);
    expect(invalidated.length).toBe(1);

    // 第二次调用幂等跳过
    const second = restoreHistoricalReply(target);
    expect(second.success).toBe(true);
    expect(second.restored).toBe(false);
    expect(second.alreadyRestored).toBe(true);
    expect(invalidated.length).toBe(2);
  });

  it("当目标属性或身份冲突时，应当拒绝并抛错", () => {
    const targetWithWrongRun: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: "run-mismatch-wrong",
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath,
    };

    expect(() => restoreHistoricalReply(targetWithWrongRun)).toThrow(/运行ID不匹配/);

    const targetWithWrongConv: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: "cnv-mismatch-wrong",
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath,
    };

    expect(() => restoreHistoricalReply(targetWithWrongConv)).toThrow(/会话ID不匹配/);
  });

  it.each([
    "这是并发写入的新的合法正文，不是敏感认证占位",
    "password=r12-synthetic-secret\n这是包含合成凭据的并发正文，不得进入冲突错误。",
  ])("当前正文冲突时拒绝覆盖，错误不泄漏正文且记录不变 (R7/R12): %s", (currentText) => {
    const db = new Database(sqlitePath);
    const row = db
      .prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?")
      .get(targetWorkflow, targetSeq) as { data: string };
    const saved = JSON.parse(row.data);
    saved.payload.public_text = currentText;
    const conflictData = canonical(saved);
    db.prepare("UPDATE events SET data = ? WHERE workflow_id = ? AND seq = ?").run(
      conflictData,
      targetWorkflow,
      targetSeq,
    );
    db.close();

    const target: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath,
    };

    let thrown: unknown;
    try {
      restoreHistoricalReply(target);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("恢复操作未抛出预期冲突错误");
    expect(thrown.message).toMatch(/目标回复冲突：当前内容不等于预期旧值/);
    expect(thrown.message).toContain(`workflow_id=${targetWorkflow}`);
    expect(thrown.message).toContain(`seq=${targetSeq}`);
    expect(thrown.message).not.toContain(currentText);
    expect(thrown.message).not.toContain(currentText.slice(0, 30));
    expect(thrown.message).not.toContain("r12-synthetic-secret");

    const readDb = new Database(sqlitePath);
    try {
      const unchanged = readDb
        .prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?")
        .get(targetWorkflow, targetSeq) as { data: string };
      expect(unchanged.data).toBe(conflictData);
    } finally {
      readDb.close();
    }
  });

  it("严格检查来源有效性：空原文、缺少result.json或summary异常时均拒绝写入 (R9)", () => {
    // 1. 空原文
    const emptyRawPath = join(testDir, "empty-raw.txt");
    writeFileSync(emptyRawPath, "   \n\t  ", "utf-8");
    const targetWithEmptyRaw: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath: emptyRawPath,
      resultJsonPath,
    };
    expect(() => restoreHistoricalReply(targetWithEmptyRaw)).toThrow(/原文内容为空/);

    // 2. result.json 缺失
    const targetWithMissingResultJson: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath: join(testDir, "non-existent-result.json"),
    };
    expect(() => restoreHistoricalReply(targetWithMissingResultJson)).toThrow(/交叉核对来源文件缺失/);

    // 3. result.json 损坏
    const corruptedResultPath = join(testDir, "corrupted-result.json");
    writeFileSync(corruptedResultPath, "{not-json", "utf-8");
    const targetWithCorruptedJson: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath: corruptedResultPath,
    };
    expect(() => restoreHistoricalReply(targetWithCorruptedJson)).toThrow(/交叉核对文件解析失败/);

    // 4. result.json 缺少有效的 summary
    const noSummaryPath = join(testDir, "no-summary.json");
    writeFileSync(noSummaryPath, JSON.stringify({ other: 123 }), "utf-8");
    const targetWithNoSummary: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath: noSummaryPath,
    };
    expect(() => restoreHistoricalReply(targetWithNoSummary)).toThrow(/缺少有效的字符串 summary 字段/);

    // 5. 原文与 summary 冲突
    writeFileSync(resultJsonPath, JSON.stringify({ summary: "完全不一致的摘要文本" }), "utf-8");
    const targetWithConflictSummary: HistoryRecoveryTarget = {
      sqlitePath,
      workflowId: targetWorkflow,
      eventSeq: targetSeq,
      runId: targetRunId,
      conversationId: targetConversationId,
      activityId: targetActivityId,
      rawResultPath,
      resultJsonPath,
    };
    expect(() => restoreHistoricalReply(targetWithConflictSummary)).toThrow(/交叉核对不匹配/);
  });
});
