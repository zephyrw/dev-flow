import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical } from "./util.js";

export interface HistoryRecoveryTarget {
  sqlitePath: string;
  workflowId: string;
  eventSeq: number;
  runId: string;
  conversationId: string;
  activityId: string;
  rawResultPath: string;
  resultJsonPath?: string;
  expectedPreviousText?: string;
  store?: { invalidatePublicEvent: (workflowId: string, eventSeq?: number) => void };
}

export interface HistoryRecoveryOutcome {
  success: boolean;
  restored: boolean;
  alreadyRestored: boolean;
  message: string;
  previousText?: string;
  restoredTextLength?: number;
  restoredTextBytes?: number;
}

export function verifySourceMaterial(target: HistoryRecoveryTarget): { rawText: string; byteCount: number } {
  if (!existsSync(target.rawResultPath)) {
    throw new Error(`原文文件不存在: ${target.rawResultPath}`);
  }
  const rawBuffer = readFileSync(target.rawResultPath);
  const rawText = rawBuffer.toString("utf-8");
  if (!rawText || rawText.trim().length === 0) {
    throw new Error(`原文内容为空，拒绝恢复: ${target.rawResultPath}`);
  }
  const byteCount = rawBuffer.byteLength;

  const resultPath = target.resultJsonPath ?? join(dirname(target.rawResultPath), "result.json");
  if (!existsSync(resultPath)) {
    throw new Error(`交叉核对来源文件缺失: ${resultPath}`);
  }
  let resultObj: any;
  try {
    resultObj = JSON.parse(readFileSync(resultPath, "utf-8"));
  } catch (e: any) {
    throw new Error(`交叉核对文件解析失败: ${e.message}`);
  }
  if (typeof resultObj?.summary !== "string" || resultObj.summary.trim().length === 0) {
    throw new Error(`交叉核对文件中缺少有效的字符串 summary 字段`);
  }
  if (resultObj.summary.trim() !== rawText.trim()) {
    throw new Error(`原文与 result.json summary 交叉核对不匹配: 原文与摘要不一致`);
  }

  return { rawText, byteCount };
}

export function restoreHistoricalReply(target: HistoryRecoveryTarget): HistoryRecoveryOutcome {
  const { rawText, byteCount } = verifySourceMaterial(target);

  if (!existsSync(target.sqlitePath)) {
    throw new Error(`数据库文件不存在: ${target.sqlitePath}`);
  }

  const maxRetries = 6;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const db = new Database(target.sqlitePath, { timeout: 15000 });
    try {
      db.pragma("busy_timeout = 15000");

      const runInTx = db.transaction(() => {
        const row = db
          .prepare("SELECT data FROM events WHERE workflow_id = ? AND seq = ?")
          .get(target.workflowId, target.eventSeq) as { data: string } | undefined;

        if (!row) {
          throw new Error(`目标事件不存在: workflow_id=${target.workflowId}, seq=${target.eventSeq}`);
        }

        let event: any;
        try {
          event = JSON.parse(row.data);
        } catch (e: any) {
          throw new Error(`目标事件 JSON 反序列化失败: ${e.message}`);
        }

        if (event.type !== "ConversationActivity") {
          throw new Error(`目标事件类型不匹配: 期望 ConversationActivity, 实际 ${event.type}`);
        }
        if (event.run_id !== target.runId) {
          throw new Error(`目标事件运行ID不匹配: 期望 ${target.runId}, 实际 ${event.run_id}`);
        }

        const payload = event.payload;
        if (!payload || typeof payload !== "object") {
          throw new Error(`目标事件 payload 无效`);
        }

        if (payload.conversation_id !== target.conversationId) {
          throw new Error(`会话ID不匹配: 期望 ${target.conversationId}, 实际 ${payload.conversation_id}`);
        }
        if (payload.activity_id !== target.activityId) {
          throw new Error(`活动ID不匹配: 期望 ${target.activityId}, 实际 ${payload.activity_id}`);
        }

        // 幂等性检查
        if (payload.public_text === rawText) {
          target.store?.invalidatePublicEvent(target.workflowId, target.eventSeq);
          return {
            success: true,
            restored: false,
            alreadyRestored: true,
            message: "目标回复已经处于恢复后状态，无需重复写入",
            previousText: payload.backup_previous_text ?? rawText,
            restoredTextLength: rawText.length,
            restoredTextBytes: byteCount,
          };
        }

        // 冲突检查：当前内容必须匹配预期旧值，否则拒绝覆盖合法的新内容
        const expectedPreviousText = target.expectedPreviousText ?? "[敏感认证操作：仅保留状态]";
        if (payload.public_text !== expectedPreviousText) {
          throw new Error(
            `目标回复冲突：当前内容不等于预期旧值，拒绝覆盖可能已修改的正文 (workflow_id=${target.workflowId}, seq=${target.eventSeq})`
          );
        }

        const previousText = payload.public_text;
        payload.public_text = rawText;
        payload.restored_at = new Date().toISOString();
        payload.backup_previous_text = previousText;
        event.payload = payload;

        const updatedJson = canonical(event);
        const res = db
          .prepare("UPDATE events SET data = ? WHERE workflow_id = ? AND seq = ?")
          .run(updatedJson, target.workflowId, target.eventSeq);

        if (res.changes !== 1) {
          throw new Error(`更新事件行数异常: 期望 1, 实际 ${res.changes}`);
        }

        target.store?.invalidatePublicEvent(target.workflowId, target.eventSeq);

        return {
          success: true,
          restored: true,
          alreadyRestored: false,
          message: "历史模型回复恢复成功",
          previousText,
          restoredTextLength: rawText.length,
          restoredTextBytes: byteCount,
        };
      });

      return runInTx.immediate();
    } catch (e: any) {
      lastError = e;
      if (e.code === "SQLITE_BUSY" || e.code === "SQLITE_BUSY_SNAPSHOT") {
        const delay = attempt * 200;
        const start = Date.now();
        while (Date.now() - start < delay) {}
        continue;
      }
      throw e;
    } finally {
      try {
        db.close();
      } catch {}
    }
  }

  throw lastError ?? new Error(`在多次重试后未能完成历史恢复`);
}
