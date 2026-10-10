import type { Run } from "../../contracts/src/index.js";
import { FlowError } from "../../contracts/src/index.js";
import { computeSessionOwnerKey, type SessionBinding, type SessionBindingKey } from "../../contracts/src/session-binding.js";
import type { Store } from "../../store/src/store.js";
import { confirmedBindingComparator } from "../../core/src/session-binding-recency.js";

/** AGY stores native conversations locally; switching credentials does not move them. */
export function agySessionAcrossAccounts(store: Store, key: SessionBindingKey, preferredConversationId?: string): SessionBinding | undefined {
  if (key.adapter_id !== "agy") return undefined;
  const compatible = store.list<SessionBinding>("session_binding", key.workflow_id)
    .filter((binding) => binding.state === "bound" && !!binding.conversation_id &&
      binding.workflow_id === key.workflow_id && binding.adapter_id === key.adapter_id &&
      binding.host_id === key.host_id && binding.client_scope_id === key.client_scope_id &&
      binding.workspace_identity === key.workspace_identity &&
      (!preferredConversationId || binding.conversation_id === preferredConversationId))
    .filter((binding) => {
      const latest = binding.latest_run_id ? store.get<Run>("run", binding.latest_run_id) : undefined;
      return !latest || (latest.workflow_id === key.workflow_id && latest.purpose !== "aside");
    })
    .sort(confirmedBindingComparator(store, key.workflow_id));
  const binding = compatible[0];
  if (!binding?.conversation_id) return undefined;
  // Preserve ownership in both credential scopes before asking the CLI to resume.
  for (const provider_account_scope of [binding.provider_account_scope, key.provider_account_scope]) {
    const owner = store.get<{ workflow_id: string }>("session_owner_index", computeSessionOwnerKey({
      ...key, provider_account_scope, conversation_id: binding.conversation_id,
    }));
    if (owner && owner.workflow_id !== key.workflow_id) {
      throw new FlowError("SESSION_ALREADY_OWNED", "原生会话已由其他任务认领", 409);
    }
  }
  return binding;
}
