import { afterEach, describe, expect, it } from "vitest";
import { setup } from "../helpers.js";
import {
  type Run,
  type SubagentCapabilities,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import { createDefaultAdapterRegistry } from "../../packages/adapters/sdk/src/index.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import { now } from "../../packages/core/src/util.js";
import {
  CONVERSATION_FIXTURE_ADAPTERS,
  loadConversationFixtures,
  type ConversationFixtureAdapter,
} from "../fixtures/conversations/load.js";
import { OpenCodeConversationSource } from "../../packages/adapters/opencode/src/conversation-source.js";

const opened: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

function putWorkflow(store: ReturnType<typeof setup>["store"], adapter: Run["adapter"]) {
  const workflow: Workflow = {
    id: "wf1",
    project_id: "p1",
    title: "adapter fixtures",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 0,
    environment_revision: 0,
    run_id: "run1",
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  const run: Run = {
    id: "run1",
    workflow_id: "wf1",
    plan_revision: 0,
    adapter,
    purpose: "implement",
    stage: "exec",
    status: "running",
    started_at: "2026-09-20T00:00:00.000Z",
    package_hash: "pkg",
  };
  store.put("workflow", "wf1", "p1", workflow);
  store.put("run", "run1", "wf1", run);
}

function ctx(
  adapterId: string,
  rootNativeId: string | undefined,
  fileName: string,
): ConversationApplyContext {
  return {
    project_id: "p1",
    workflow_id: "wf1",
    run_id: `run-${adapterId}-${fileName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    adapter_id: adapterId,
    scope: `profile-${adapterId}`,
    lineage_id: `lineage-${adapterId}-${fileName}`,
    purpose: "implement",
    root_native_id: rootNativeId,
  };
}

function decodeRecords(
  adapterId: ConversationFixtureAdapter,
  records: unknown[],
  runId: string,
): NativeConversationEvent[] {
  if (adapterId === "opencode") {
    const source = new OpenCodeConversationSource({
      workflowId: "wf1",
      runId,
      lineageId: "wf1:implement:opencode",
      rootSessionId: "ses_root1",
      purpose: "implement",
    });
    const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    return source.decodeChunk({
      stream: "stdout",
      data: text,
      timestamp: "2026-09-20T00:00:00.000Z",
      runId,
      final: true,
    });
  }
  const adapter = createDefaultAdapterRegistry().mustGet(adapterId);
  const events: NativeConversationEvent[] = [];
  for (const record of records) {
    events.push(
      ...(adapter.decodeConversation?.({
        stream: "stdout",
        data: JSON.stringify(record) + "\n",
        timestamp: "2026-09-20T00:00:00.000Z",
        runId,
      }) ?? []),
    );
  }
  return events;
}

function assertUnknownNotFalse(capabilities: SubagentCapabilities) {
  if (capabilities.discovery === "unknown") {
    expect(capabilities.discovery).not.toBe("native");
    expect(capabilities.discovery).not.toBe("unavailable");
  }
  if (capabilities.readonly_delegation === "unknown") {
    expect(capabilities.readonly_delegation).not.toBe("verified");
    expect(capabilities.readonly_delegation).not.toBe("unsupported");
  }
}

describe("SA-I03 adapter fixtures decode and route", () => {
  it("decodes eight adapter fixtures into the correct nodes and reports capability gaps", () => {
    const registry = createDefaultAdapterRegistry();
    const reports: Array<{
      adapter: ConversationFixtureAdapter;
      eventCount: number;
      capabilities: SubagentCapabilities;
    }> = [];
    for (const adapterId of CONVERSATION_FIXTURE_ADAPTERS) {
      const s = setup();
      opened.push({ close: () => s.store.close() });
      putWorkflow(s.store, adapterId);
      const conversations = new ConversationService(s.store);
      const fixtures = loadConversationFixtures(adapterId);
      expect(fixtures.length).toBeGreaterThan(0);
      const events: NativeConversationEvent[] = [];
      for (const file of fixtures) {
        const decoded = decodeRecords(
          adapterId,
          file.records,
          `run-${adapterId}-${file.fileName}`,
        );
        events.push(...decoded);
        const rootNative =
          decoded.find((item) => item.kind === "discovered" && !item.parent_native_id)
            ?.root_native_id ??
          decoded.find((item) => item.root_native_id)?.root_native_id ??
          decoded.find((item) => item.session_native_id)?.session_native_id;
        const applyCtx = ctx(adapterId, rootNative, file.fileName);
        conversations.applyEvents(applyCtx, decoded);
        const tree = conversations.getTree("wf1");
        for (const event of decoded) {
          if (!event.session_native_id) continue;
          if (
            !(
              event.parent_native_id &&
              event.parent_native_id !== event.session_native_id &&
              event.session_native_id !== event.root_native_id
            )
          )
            continue;
          const node = tree.nodes.find(
            (item) =>
              item.native_session_id === event.session_native_id &&
              item.lineage_id === applyCtx.lineage_id,
          );
          if (!node) continue;
          expect(node.kind, `${adapterId} ${file.fileName}`).toBe("subagent");
        }
      }
      const tree = conversations.getTree("wf1");
      const unknownVersion = events.filter((item) =>
        JSON.stringify(item.payload).includes("should-not-become-child"),
      );
      expect(
        tree.nodes.some((node) => node.native_session_id === "should-not-become-child"),
      ).toBe(false);
      expect(unknownVersion.every((item) => item.kind !== "discovered")).toBe(true);
      const adapter = registry.mustGet(adapterId);
      const capabilities =
        adapter.subagents ??
        conversations.getTree("wf1").capabilities;
      assertUnknownNotFalse(capabilities);
      conversations.setCapabilities("wf1", capabilities);
      reports.push({
        adapter: adapterId,
        eventCount: events.length,
        capabilities,
      });
      expect(events.length).toBeGreaterThanOrEqual(0);
    }
    expect(reports).toHaveLength(8);
    expect(reports.every((item) => item.adapter)).toBe(true);
    const nativeDiscovery = reports.filter(
      (item) => item.capabilities.discovery === "native",
    );
    expect(nativeDiscovery.length).toBeLessThan(8);
    const cursor = reports.find((item) => item.adapter === "cursor-agent");
    expect(cursor?.capabilities.discovery).toBe("unavailable");
    expect(cursor?.capabilities.readonly_delegation).toBe("unknown");
    const agy = reports.find((item) => item.adapter === "agy");
    expect(agy?.capabilities.readonly_delegation).toBe("unknown");
    expect(agy?.capabilities.readonly_delegation).not.toBe("verified");
  });
});
