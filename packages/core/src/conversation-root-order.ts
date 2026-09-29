import type { Run } from "../../contracts/src/index.js";
import type { ConversationNode, ConversationTreeSnapshot } from "../../contracts/src/conversation.js";
import type { Store } from "../../store/src/store.js";

/** Reusing an existing native root starts a new attempt, not a new node. */
export function hasSuccessorRoot(store: Store, tree: ConversationTreeSnapshot, root: ConversationNode): boolean {
  const latestStartedAt = (node: ConversationNode) => {
    const attempt = tree.attempts.filter((item) => item.conversation_id === node.id)
      .sort((a, b) => b.generation - a.generation)[0];
    const run = attempt && store.get<Run>("run", attempt.run_id);
    // Run start is stable: a delayed event from an older attempt must not make
    // that root supersede the current run. Historical records may lack a Run.
    return run?.workflow_id === node.workflow_id ? run.started_at : attempt?.observed_at ?? node.created_at;
  };
  const rootTime = latestStartedAt(root);
  return tree.nodes.some((node) => {
    if (node.id !== node.root_id || node.id === root.id) return false;
    const replaces = node.replaces_conversation_id === root.id;
    if (!replaces && !(node.lineage_id === root.lineage_id &&
        node.adapter_id === root.adapter_id && node.kind === root.kind)) return false;
    const nodeTime = latestStartedAt(node);
    return nodeTime > rootTime || (nodeTime === rootTime && replaces);
  });
}
