import { homedir } from "node:os";
import {
  AgySubagentRecords,
  agySubagentStatus,
} from "../../../../packages/adapters/agy/src/subagent-records.js";
import {
  isTerminalConversationStatus,
  type ConversationAttempt,
  type ConversationNode,
  type ConversationTreeSnapshot,
} from "../../../../packages/contracts/src/conversation.js";

const records = new AgySubagentRecords(homedir());

function delegationStep(node: ConversationNode) {
  if (node.kind !== "subagent" || node.adapter_id !== "agy") return;
  const match = /^agy:([0-9a-f-]{36}):step:(\d+)$/i.exec(node.spawn_call_id ?? "");
  if (match) return { parent: match[1]!, step: Number(match[2]) };
}

export async function projectAgySubagents(tree: ConversationTreeSnapshot) {
  const nodesById = new Map(tree.nodes.map(node => [node.id, node]));
  const attemptsById = new Map(tree.attempts.map(attempt => [attempt.id, attempt]));
  const names = new Map<string, ReturnType<typeof records.readDelegationNames>>();
  const children = await Promise.all(tree.nodes.flatMap(node => {
    const source = delegationStep(node);
    if (!source) return [];
    return [(async () => {
      const receipt = node.native_session_id ? undefined : await records.readDelegation(source.parent, source.step);
      const session = node.native_session_id ?? receipt;
      let title = node.title;
      if (title === node.spawn_call_id) {
        let pending = names.get(source.parent);
        if (!pending) {
          pending = records.readDelegationNames(source.parent);
          names.set(source.parent, pending);
        }
        title = (await pending).get(source.step)?.slice(0, 200) ?? title;
      }
      const parent = node.parent_id ? nodesById.get(node.parent_id) : tree.nodes.find(
        candidate => candidate.root_id === node.root_id && candidate.native_session_id === source.parent,
      );
      return { node, source, session, receipt, title, parent };
    })()];
  }));
  if (children.length === 0) return tree;
  const summaries = records.readSummaries(children.flatMap(child => child.session ? [child.session] : []));
  for (const { node, source, session, receipt, title, parent } of children) {
    const found = session ? summaries.get(session) : undefined;
    const summary = found?.parent_conversation_id === source.parent ? found : undefined;
    node.title = title !== node.spawn_call_id
      ? title
      : summary?.agent_name?.trim().slice(0, 200) || title;
    node.parent_id ??= parent?.id;
    node.native_session_id ??= receipt;
    node.native_parent_session_id ??= parent?.native_session_id;
    const attempt = node.current_attempt_id ? attemptsById.get(node.current_attempt_id) : undefined;
    const parentAttempt = parent?.current_attempt_id ? attemptsById.get(parent.current_attempt_id) : undefined;
    if (!attempt || isTerminalConversationStatus(attempt.status) || attempt.status === "pausing") continue;
    const status = agySubagentStatus(summary);
    if (status && isTerminalConversationStatus(status)) {
      attempt.status = status;
      attempt.freshness = "fresh";
    } else if (parentAttempt && isTerminalConversationStatus(parentAttempt.status)) {
      attempt.status = "interrupted";
    } else if (status) {
      attempt.status = status;
      attempt.freshness = "fresh";
    } else if (receipt && attempt.status === "discovered") {
      attempt.status = "starting";
    }
  }
  return tree;
}

export async function readAgySubagentActivities(
  node: ConversationNode,
  attempt: ConversationAttempt | undefined,
) {
  const source = delegationStep(node);
  if (!source || !attempt) return [];
  const session = node.native_session_id ?? await records.readDelegation(source.parent, source.step);
  return session ? records.readActivities(session) : [];
}
