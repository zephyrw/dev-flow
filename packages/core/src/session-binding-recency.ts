import type { Store } from "../../store/src/store.js";
import type { SessionBinding } from "../../contracts/src/session-binding.js";
import type { Run } from "../../contracts/src/index.js";
import { requireCondition } from "../../contracts/src/index.js";

interface NativeConfirmation {
  binding_id: string;
  conversation_id: string;
}

/** Caller holds the binding transaction; index row order survives Store reopening. */
export function recordNativeConfirmation(store: Store, binding: SessionBinding): void {
  const conversationId = binding.conversation_id;
  requireCondition(typeof conversationId === "string" && !!conversationId.trim(),
    "INVALID_CONVERSATION_ID", "原生会话 ID 尚未确认，禁止记录确认顺序", 400);
  // Store.put is an upsert, so move only this private ordering index to the end.
  // Keep the binding entity, its version, owner and by-ID identity untouched.
  store.remove("session_binding_confirmation", binding.id);
  store.put("session_binding_confirmation", binding.id, binding.workflow_id, {
    binding_id: binding.id, conversation_id: conversationId,
  } satisfies NativeConfirmation);
}

/** Native confirmation order wins over millisecond clock ties or clock rollback. */
export function confirmedBindingComparator(store: Store, workflowId: string): (a: SessionBinding, b: SessionBinding) => number {
  const confirmations = new Map(store.list<NativeConfirmation>("session_binding_confirmation", workflowId)
    .map((record, index) => [record.binding_id, { ...record, order: index + 1 }]));
  const historicalOrder = new Map(store.list<SessionBinding>("session_binding", workflowId)
    .map((binding, index) => [binding.id, index + 1]));
  const order = (binding: SessionBinding) => {
    const confirmation = confirmations.get(binding.id);
    return confirmation && confirmation.conversation_id === binding.conversation_id ? confirmation.order : 0;
  };
  const started = (binding: SessionBinding) => binding.latest_run_id
    ? store.get<Run>("run", binding.latest_run_id)?.started_at ?? "" : "";
  return (a, b) => order(b) - order(a) || b.updated_at.localeCompare(a.updated_at) ||
    started(b).localeCompare(started(a)) || b.created_at.localeCompare(a.created_at) ||
    (historicalOrder.get(b.id) ?? 0) - (historicalOrder.get(a.id) ?? 0);
}
