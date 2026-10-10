import type { ConversationTreeSnapshot } from "../../../packages/contracts/src/conversation.js";

/** A projected legacy root can disappear when the next Run publishes its tree. */
export function selectConversationMessageTarget(
  tree: Pick<ConversationTreeSnapshot, "active_root_id" | "nodes" | "attempts">,
  workflowId: string,
  displayedRootId?: string,
  displayedGeneration?: number,
): { rootId: string; generation: number } {
  const roots = (tree.nodes ?? []).filter(node => node.id === node.root_id && node.kind === "main");
  const displayed = roots.find(root => root.id === displayedRootId);
  const rootId = displayed?.id ?? tree.active_root_id ?? roots[0]?.id ?? workflowId;
  const generations = (tree.attempts ?? []).filter(attempt => attempt.conversation_id === rootId).map(attempt => attempt.generation);
  const generation = generations.length ? Math.max(...generations) : undefined;
  return {
    rootId,
    generation: generation ?? (rootId === displayedRootId ? displayedGeneration : undefined) ?? 0,
  };
}

/** Refresh the explicitly viewed root; only a missing root may fall back to the active one. */
export async function resolveConversationMessageTarget(
  workflowId: string,
  rootConversationId?: string,
  expectedGeneration?: number,
  request: typeof fetch = fetch,
): Promise<{ rootId: string; generation: number }> {
  const url = "/api/workflows/" + encodeURIComponent(workflowId) + "/conversations";
  let response = await request(url + (rootConversationId ? "?root_id=" + encodeURIComponent(rootConversationId) : ""),
    { credentials: "same-origin" });
  if (rootConversationId && response.status === 404) {
    response = await request(url, { credentials: "same-origin" });
  }
  if (!response.ok) throw new Error("无法刷新目标会话，请重试");
  const tree: ConversationTreeSnapshot = await response.json();
  return selectConversationMessageTarget(tree, workflowId, rootConversationId, expectedGeneration);
}
