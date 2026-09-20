import type { Run } from "../../contracts/src/index.js";
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

/** Every launcher occupies the same lineage before starting, including a run
 * which is stopped before the client emits its first conversation ID. */
export function beginRunConversation(store: Store, run: Run, fingerprint = run.invocation_fingerprint) {
  const family = sessionFamily(run.purpose ?? "implement", run.id);
  const key = conversationLineageKey(run.workflow_id, family);
  const previous = store.get<Conversation>("native_conversation", key) ??
    (family === "execution" ? store.get<Conversation>("conversation", run.workflow_id) : undefined);
  const compatible = !!fingerprint && previous?.fingerprint === fingerprint &&
    (!previous.family || previous.family === family);
  const resume = compatible && previous?.id ? { id: previous.id } : undefined;
  const current = { ...(resume ?? {}), fingerprint, family, profile: run.profile, run_id: run.id };
  store.put("native_conversation", key, run.workflow_id, current);
  if (family === "execution") store.put("conversation", run.workflow_id, run.workflow_id, current);
  return resume;
}

export function retainRunConversation(store: Store, run: Run, conversationId: string, fingerprint = run.invocation_fingerprint) {
  const family = sessionFamily(run.purpose ?? "implement", run.id);
  const key = conversationLineageKey(run.workflow_id, family);
  const current = store.get<Conversation>("native_conversation", key);
  // A late event from a stopped process cannot take ownership from a new run.
  if (current?.run_id && current.run_id !== run.id) return;
  const record = { id: conversationId, fingerprint, family, profile: run.profile, run_id: run.id };
  store.put("native_conversation", key, run.workflow_id, record);
  if (family === "execution") store.put("conversation", run.workflow_id, run.workflow_id, record);
}
