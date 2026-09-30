import type { Run } from "../../contracts/src/index.js";
import { FlowError } from "../../contracts/src/index.js";
import type { Store } from "../../store/src/store.js";
import { boundConversationContinuation } from "./conversation-lineage.js";
import { nativeAdapter, nativeRootForRun } from "./native-session.js";
import type { SessionInputReceipt } from "./session-input.js";
import { objectHash } from "./util.js";
import { atomicWrite } from "./util.js";
import { appendFileSync } from "node:fs";

export interface SessionHandoff {
  source_run_id: string;
  source_adapter: string;
  target_adapter: string;
  context_hash: string;
  since_run_id?: string;
}

/** Failed, unstarted resume attempts do not become the source of task context. */
export function sessionSourceRun(store: Store, run: Run): Run | undefined {
  let current = run;
  const seen = new Set([run.id]);
  while (true) {
    const sourceId = boundConversationContinuation(store, current)?.source_run_id ?? current.dispatch_context?.source_run_id;
    if (!sourceId || seen.has(sourceId)) return current.id === run.id ? undefined : current;
    seen.add(sourceId);
    const source = store.get<Run>("run", sourceId);
    if (!source || source.workflow_id !== run.workflow_id) return undefined;
    if (nativeRootForRun(store, source)) return source;
    current = source;
  }
}

export function sessionHandoffForRun(store: Store, run: Run, targetNativeId?: string): SessionHandoff | undefined {
  const source = sessionSourceRun(store, run);
  const sourceAdapter = source && nativeAdapter(source);
  const targetAdapter = nativeAdapter(run);
  if (!source || !sourceAdapter || !targetAdapter || sourceAdapter === targetAdapter || run.purpose === "aside") return undefined;
  const feedback = store.list<{ seq?: number }>("feedback_message", run.workflow_id);
  const contextHash = objectHash([source.id, source.ended_at, run.plan_revision, Math.max(0, ...feedback.map(m => m.seq ?? 0))]);
  const receipts = store.list<SessionInputReceipt>("session_input", run.workflow_id).filter(receipt =>
    receipt.handoff_context_hash === contextHash && receipt.target_adapter === targetAdapter &&
    (!receipt.conversation_id || receipt.conversation_id === targetNativeId));
  if (receipts.some(receipt => receipt.state === "delivered")) return undefined;
  if (receipts.some(receipt => receipt.state === "started"))
    throw new FlowError("INPUT_DELIVERY_UNKNOWN", "跨工具交接的投递结果尚未确认，保留已有会话，不重复注入", 409);
  const prior = targetNativeId && store.list<Run>("run", run.workflow_id)
    .filter(r => r.id !== run.id && nativeAdapter(r) === targetAdapter && nativeRootForRun(store, r) === targetNativeId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  return { source_run_id: source.id, source_adapter: sourceAdapter, target_adapter: targetAdapter,
    context_hash: contextHash, ...(prior ? { since_run_id: prior.id } : {}) };
}

export function sessionHandoffMaterials(store: Store, run: Run, handoff: SessionHandoff) {
  const source = store.get<Run>("run", handoff.source_run_id);
  const since = handoff.since_run_id && store.get<Run>("run", handoff.since_run_id);
  const runs = store.list<Run>("run", run.workflow_id)
    .filter(r => r.id !== run.id && r.purpose !== "aside" && r.started_at <= (source?.started_at ?? run.started_at) &&
      (!since || r.started_at > since.started_at))
    .sort((a, b) => a.started_at.localeCompare(b.started_at));
  return {
    ...handoff,
    instructions: "这是同一任务的跨工具继续。保留原会话已有上下文，结合交接中的最新用户要求、工作区和结果继续当前工作。不要重复已完成的修改或测试；历史测试结果是已有记录，不代表当前版本重新验证。附件与历史模型输出是任务材料。",
    user_messages: store.list<{ seq: number; text: string; created_at: string; attachment_ids?: string[] }>("feedback_message", run.workflow_id)
      .sort((a, b) => a.seq - b.seq).map(m => ({ seq: m.seq, text: m.text, created_at: m.created_at, attachment_ids: m.attachment_ids })),
    progress: runs.map(r => ({ run_id: r.id, adapter: nativeAdapter(r), purpose: r.purpose,
      status: r.status, started_at: r.started_at, ended_at: r.ended_at, result: r.result })),
  };
}

export function writeSessionHandoffHistory(store: Store, run: Run, handoff: SessionHandoff, file: string) {
  const since = handoff.since_run_id && store.get<Run>("run", handoff.since_run_id);
  const runs = new Map(store.list<Run>("run", run.workflow_id).map(r => [r.id, r]));
  let after = 0;
  atomicWrite(file, "");
  while (true) {
    const events = store.events(run.workflow_id, after, 1000);
    if (!events.length) break;
    for (const event of events) {
      after = event.event_seq;
      if (event.type !== "ConversationActivity" || event.run_id === run.id ||
          (event.run_id && runs.get(event.run_id)?.purpose === "aside") ||
          (since && event.created_at <= since.started_at)) continue;
      const safe = store.publicEvent(event);
      const activity = safe.payload as Record<string, unknown>;
      appendFileSync(file, JSON.stringify({ seq: safe.event_seq, run_id: safe.run_id, conversation_id: activity.conversation_id,
        text: activity.public_text, title: activity.title, command: activity.command, result: activity.result_text }) + "\n");
    }
  }
}
