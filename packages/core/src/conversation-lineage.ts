import type { Run } from "../../contracts/src/index.js";
import type { RunContinuation } from "../../contracts/src/tr-handoff.js";
import type { Store } from "../../store/src/store.js";

export function sessionFamily(purpose: string, runId: string): string {
  if (["implement", "plan_self_check", "functional_fix", "planner_takeover", "merge_conflict"].includes(purpose)) return "execution";
  if (purpose === "quality_review") return "review:" + runId;
  if (purpose === "aside") return "aside:" + runId;
  return purpose;
}
export function conversationLineageKey(workflowId: string, family: string) {
  return workflowId + ":lineage:" + family;
}
type Conversation = { id?: string; fingerprint?: string; run_id?: string; family?: string };

/** Only scheduler-bound continuation may influence this Run. */
export function boundConversationContinuation(store: Store, run: Run): RunContinuation | undefined {
  const purpose = run.purpose === "quality_review" ? "review" : run.purpose === "planning" ? "planning"
    : ["implement", "functional_fix", "planner_takeover"].includes(run.purpose ?? "") ? "execute" : undefined;
  for (const value of [run.continuation, store.get<RunContinuation>("run_continuation", run.id)]) {
    if (!value || value.purpose !== purpose) continue;
    const source = store.get<Run>("run", value.source_run_id);
    if (source && source.workflow_id !== run.workflow_id) continue;
    return value;
  }
}

function lineageFamily(store: Store, run: Run): string {
  const saved = store.get<{ family: string }>("run_conversation_lineage", run.id);
  if (saved) return saved.family;
  if (run.purpose !== "quality_review") return sessionFamily(run.purpose ?? "implement", run.id);
  // A review follow-up keeps its review's family; an independent review gets a
  // fresh family. This lets an A-B-A switch reset even a clarification chain.
  let source = run;
  const seen = new Set<string>();
  while (!seen.has(source.id)) {
    seen.add(source.id);
    const known = store.get<{ family: string }>("run_conversation_lineage", source.id);
    if (known) return known.family;
    const continuation = boundConversationContinuation(store, source);
    const prior = continuation && store.get<Run>("run", continuation.source_run_id);
    if (!prior || prior.workflow_id !== run.workflow_id || prior.purpose !== "quality_review") break;
    source = prior;
  }
  return sessionFamily("quality_review", source.id);
}

function previousConversation(store: Store, run: Run, family: string) {
  return store.get<Conversation>("native_conversation", conversationLineageKey(run.workflow_id, family)) ??
    (family === "execution" ? store.get<Conversation>("conversation", run.workflow_id) : undefined);
}

export function continuationSessionToResume(store: Store, run: Run, fingerprint = run.invocation_fingerprint) {
  const continuation = boundConversationContinuation(store, run);
  if (!continuation || !fingerprint) return undefined;
  const source = store.get<Run>("run", continuation.source_run_id);
  if (!source || source.workflow_id !== run.workflow_id) return undefined;
  const family = lineageFamily(store, run);
  const previous = previousConversation(store, run, family);
  const sourceFingerprint = source.invocation_fingerprint ?? source.model_binding?.invocation_fingerprint ??
    (previous?.run_id === source.id ? previous.fingerprint : undefined);
  if (sourceFingerprint !== fingerprint) return undefined;
  const id = continuation.conversation_id ?? source.conversation_id ??
    (previous?.run_id === source.id ? previous.id : undefined);
  if (!id) return undefined;
  if (previous && (previous.fingerprint !== fingerprint || previous.id !== id)) return undefined;
  return { id };
}

/** All launchers occupy one lineage before spawning, even before a session ID. */
export function beginRunConversation(store: Store, run: Run, fingerprint = run.invocation_fingerprint) {
  const family = lineageFamily(store, run);
  const key = conversationLineageKey(run.workflow_id, family);
  const previous = previousConversation(store, run, family);
  const continuation = boundConversationContinuation(store, run);

  // 显式账号恢复续接 (AGF-F08 / AGF-D09)
  const accountRecovery =
    store.get<{
      recovery_id: string;
      decision: string;
      original_conversation_id?: string;
    }>("account_recovery_continuation", run.id) ??
    (run as any).pending_model_retry?.account_recovery;

  if (accountRecovery) {
    if (accountRecovery.decision === "exact_resume") {
      if (!accountRecovery.original_conversation_id) {
        throw new Error("EXACT_RESUME_ORIGINAL_CONVERSATION_MISSING");
      }
      const resume = { id: accountRecovery.original_conversation_id };
      const current = { ...resume, fingerprint, family, profile: run.profile, run_id: run.id };
      store.put("run_conversation_lineage", run.id, run.workflow_id, { family });
      store.put("native_conversation", key, run.workflow_id, current);
      if (family === "execution") store.put("conversation", run.workflow_id, run.workflow_id, current);
      return resume;
    } else if (accountRecovery.decision === "recreate_root") {
      const current = { fingerprint, family, profile: run.profile, run_id: run.id };
      store.put("run_conversation_lineage", run.id, run.workflow_id, { family });
      store.put("native_conversation", key, run.workflow_id, current);
      if (family === "execution") store.put("conversation", run.workflow_id, run.workflow_id, current);
      return undefined;
    } else if (accountRecovery.decision === "manual_required") {
      throw new Error("ACCOUNT_RECOVERY_MANUAL_REQUIRED");
    }
  }

  const compatible = !!fingerprint && previous?.fingerprint === fingerprint && (!previous.family || previous.family === family);
  const resume = continuation
    ? continuationSessionToResume(store, run, fingerprint)
    : compatible && previous?.id ? { id: previous.id } : undefined;
  const current = { ...(resume ?? {}), fingerprint, family, profile: run.profile, run_id: run.id };
  store.put("run_conversation_lineage", run.id, run.workflow_id, { family });
  store.put("native_conversation", key, run.workflow_id, current);
  if (family === "execution") store.put("conversation", run.workflow_id, run.workflow_id, current);
  return resume;
}

export function retainRunConversation(store: Store, run: Run, conversationId: string, fingerprint = run.invocation_fingerprint) {
  const family = lineageFamily(store, run);
  const key = conversationLineageKey(run.workflow_id, family);
  const current = store.get<Conversation>("native_conversation", key);
  if (current?.run_id && current.run_id !== run.id) return;
  const record = { id: conversationId, fingerprint, family, profile: run.profile, run_id: run.id };
  store.put("native_conversation", key, run.workflow_id, record);
  if (family === "execution") store.put("conversation", run.workflow_id, run.workflow_id, record);
  const saved = store.get<Run>("run", run.id);
  if (saved) store.put("run", run.id, run.workflow_id, { ...saved, conversation_id: conversationId });
}
