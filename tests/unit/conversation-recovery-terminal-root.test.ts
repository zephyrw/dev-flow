import { expect, it } from "vitest";
import {
  unknownSubagentCapabilities,
  type ConversationNode,
  type ConversationTreeSnapshot,
} from "../../packages/contracts/src/index.js";
import { buildManifest } from "../../packages/runtime/src/conversation-recovery.js";
import { executeRecoveryGuidance } from "../../packages/core/src/conversation-guidance.js";

const timestamp = "2026-09-28T07:13:01.000Z";

function fixture(rootStatus: "completed" | "cancelled") {
  const definitions: Pick<ConversationNode, "id" | "kind" | "purpose" | "parent_id">[] = [
    { id: "root", kind: "main", purpose: "implement" },
    { id: "done-child", kind: "subagent", purpose: "implement", parent_id: "root" },
    { id: "cancelled-child", kind: "subagent", purpose: "implement", parent_id: "root" },
    { id: "aside-done", kind: "aside", purpose: "aside", parent_id: "root" },
    { id: "aside-cancelled", kind: "aside", purpose: "aside", parent_id: "root" },
  ];
  const nodes: ConversationNode[] = definitions.map((node) => ({
    ...node,
    project_id: "project",
    workflow_id: "workflow",
    root_id: "root",
    adapter_id: "agy",
    native_session_id: `native-${node.id}`,
    title: node.id,
    lineage_id: "implementation",
    created_at: timestamp,
    updated_at: timestamp,
  }));
  const tree: ConversationTreeSnapshot = {
    nodes,
    attempts: nodes.map((node) => ({
      id: `attempt-${node.id}`,
      conversation_id: node.id,
      root_id: "root",
      workflow_id: "workflow",
      run_id: "source-run",
      generation: 0,
      status: node.id === "root" ? rootStatus : node.id.includes("cancelled") ? "cancelled" : "completed",
      observed_at: timestamp,
      freshness: "fresh",
    })),
    active_root_id: "root",
    capabilities: unknownSubagentCapabilities(),
    cursor: 0,
  };
  return buildManifest({
    recovery_id: "recovery",
    workflow_id: "workflow",
    root_conversation_id: "root",
    source_run_id: "source-run",
    target_run_id: "target-run",
    reason: "user_resume",
    purpose: "implement",
    tree,
  });
}

it.each(["completed", "cancelled"] as const)(
  "does not instruct a resumed %s main conversation to skip itself, while preserving terminal children and excluding aside",
  (status) => {
    const manifest = fixture(status);
    expect(manifest.pending_children).toEqual([]);
    expect(manifest.completed_children.map((child) => child.conversation_id)).toEqual(["done-child"]);
    expect(manifest.cancelled_children).toEqual(["cancelled-child"]);
  },
);

it("ignores the main root in a legacy persisted skip list without losing actual terminal children or mutating history", () => {
  const manifest = fixture("completed");
  manifest.completed_children.unshift({ conversation_id: "root", summary: "old main completion" });
  manifest.cancelled_children.unshift("root");
  const original = structuredClone(manifest);

  const guidance = executeRecoveryGuidance(manifest, unknownSubagentCapabilities());

  expect(guidance).toContain("已完成、不要重跑：done-child");
  expect(guidance).toContain("用户已取消、不要重跑：cancelled-child");
  expect(guidance).not.toContain("不要重跑：root");
  expect(guidance).not.toContain("aside-done");
  expect(guidance).not.toContain("aside-cancelled");
  expect(manifest).toEqual(original);
});
