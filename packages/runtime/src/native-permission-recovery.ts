import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Engine } from "../../core/src/engine.js";
import { type Run, requireCondition } from "../../contracts/src/index.js";
import { pauseForNativePermission } from "../../core/src/native-permission.js";
import { AgyDeniedCalls } from "../../adapters/agy/src/permission-calls.js";
import { AgyNativeRecordSource } from "../../adapters/agy/src/native-record-source.js";
import { NativeDeniedCalls } from "./native-permission-events.js";

/** Human-triggered conversion of an older blocked Run; it never executes a tool. */
export function recoverNativePermission(engine: Engine, workflowId: string, expectedVersion: number) {
  const w = engine.get(workflowId);
  requireCondition(w.version === expectedVersion && w.state === "BLOCKED" &&
    ["NATIVE_PERMISSION_DENIED", "EXECUTION_FAILED", "NATIVE_RUN_FAILED"].includes(w.blocker?.code ?? ""),
    "INTERACTION_STALE", "当前任务权限状态已变化，请刷新后处理", 409);
  const run = engine.store.must<Run>("run", w.run_id!);
  requireCondition(["agy", "claude-code", "opencode"].includes(run.adapter) && run.workflow_id === w.id && run.plan_revision === w.plan_revision &&
    run.conversation_id && /^run-[a-z0-9-]+$/i.test(run.id), "INTERACTION_STALE", "无法确认被拒绝操作的来源会话", 409);

  const native = run.adapter === "agy" ? new AgyNativeRecordSource(homedir()) : undefined;
  const calls = native
    ? new AgyDeniedCalls((session, index) => native.read(session, index))
    : new NativeDeniedCalls(run.adapter as "claude-code" | "opencode");
  try {
    const path = join(engine.config.storage_root, "native-runs", run.id, "stdout.jsonl");
    if (statSync(path).size <= 32 * 1024 * 1024) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { calls.accept(JSON.parse(line), run.conversation_id); } catch { /* Incomplete metadata never grants permission. */ }
      }
    }
  } catch { /* A known permission blocker can still offer a non-authorizing interaction. */ }

  // AGY can confirm a current denial without complete parameters. Preserve that
  // fact and show action_required instead of inventing a grant or rejecting it.
  requireCondition(w.blocker?.code === "NATIVE_PERMISSION_DENIED" || calls.currentDenial,
    "NATIVE_PERMISSION_NOT_FOUND", "本轮日志未确认原生工具权限拒绝，请先核对实际运行错误", 409);
  return pauseForNativePermission(engine, run, calls.denied,
    calls.description || w.blocker?.message || "原生工具权限被拒绝", true);
}
