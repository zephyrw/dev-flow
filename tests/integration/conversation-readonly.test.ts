import { afterEach, describe, expect, it } from "vitest";
import { setup } from "../helpers.js";
import type { Run, Workflow } from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";
import {
  clientInvocation,
  readOnlyPurpose,
} from "../../packages/adapters/sdk/src/invocation.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import { now } from "../../packages/core/src/util.js";
import { QoderNativeAdapter } from "../../packages/adapters/qoder/src/adapter.js";
import { ClaudeCodeNativeAdapter } from "../../packages/adapters/claude/src/adapter.js";
import { GrokBuildNativeAdapter } from "../../packages/adapters/grok/src/adapter.js";
import { CodexNativeAdapter } from "../../packages/adapters/codex/src/adapter.js";
import { CursorAgentNativeAdapter } from "../../packages/adapters/cursor/src/adapter.js";
import { OpenCodeNativeAdapter } from "../../packages/adapters/opencode/src/adapter.js";

const opened: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

const PURPOSES = [
  { purpose: "planning", runId: "run-plan", native: "plan-root" },
  { purpose: "implement", runId: "run-impl", native: "impl-root" },
  {
    purpose: "quality_review",
    runId: "run-review-before",
    native: "review-before-root",
    phase: "before_human",
  },
  {
    purpose: "quality_review",
    runId: "run-review-after",
    native: "review-after-root",
    phase: "after_human",
  },
  { purpose: "functional_fix", runId: "run-fix", native: "fix-root" },
] as const;

function putWorkflow(store: ReturnType<typeof setup>["store"]) {
  const workflow: Workflow = {
    id: "wf1",
    project_id: "p1",
    title: "readonly purposes",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    run_id: "run-impl",
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  store.put("workflow", "wf1", "p1", workflow);
  for (const item of PURPOSES) {
    const run: Run = {
      id: item.runId,
      workflow_id: "wf1",
      plan_revision: 1,
      adapter: "codex",
      purpose: item.purpose,
      stage: item.purpose === "planning" ? "planning" : "exec",
      status: "running",
      started_at: "2026-09-20T00:00:00.000Z",
      package_hash: "pkg",
    };
    store.put("run", item.runId, "wf1", run);
  }
}

function ctx(
  extra: Partial<ConversationApplyContext> & { purpose: string; run_id: string; root_native_id: string },
): ConversationApplyContext {
  return {
    project_id: "p1",
    workflow_id: "wf1",
    adapter_id: "codex",
    scope: extra.purpose,
    lineage_id: `wf1:${extra.purpose}:${extra.run_id}`,
    ...extra,
  };
}

function event(
  extra: Partial<NativeConversationEvent> & { payload?: Record<string, unknown> },
): NativeConversationEvent {
  return {
    source_id: extra.source_id ?? "src-1",
    source_seq: extra.source_seq ?? "1",
    root_native_id: extra.root_native_id ?? extra.session_native_id ?? "root",
    session_native_id: extra.session_native_id,
    agent_native_id: extra.agent_native_id,
    parent_native_id: extra.parent_native_id,
    kind: extra.kind ?? "discovered",
    payload: extra.payload ?? {},
  };
}

function runContext(purpose: RunContext["purpose"]): RunContext {
  return {
    workflowId: "wf1",
    runId: `run-${purpose}`,
    stage: purpose,
    epoch: 1,
    workspaceRoots: { main: "C:/tmp/readonly-ws" },
    allowedPaths: ["app.txt"],
    toolProfile: {
      id: "profile-1",
      revision: 1,
      adapterId: "codex",
      modelSelection: "native-config",
      options: {},
    },
    prompt: "只读列出固定文件",
    purpose,
  };
}

function argsText(invocation: { args: string[]; env: Record<string, string> }) {
  return `${invocation.args.join(" ")} ${invocation.env.OPENCODE_CONFIG_CONTENT ?? ""}`;
}

describe("SA-I04 readonly purposes and write refusal", () => {
  it("creates child nodes for planning, implement, pre/post review and repair", () => {
    const s = setup();
    opened.push({ close: () => s.store.close() });
    putWorkflow(s.store);
    const conversations = new ConversationService(s.store);
    for (const item of PURPOSES) {
      const context = ctx({
        purpose: item.purpose,
        run_id: item.runId,
        root_native_id: item.native,
      });
      conversations.applyEvent(
        context,
        event({
          source_id: `src-${item.runId}`,
          source_seq: "1",
          root_native_id: item.native,
          session_native_id: item.native,
          payload: { title: `${item.purpose} 主会话`, status: "running" },
        }),
      );
      conversations.applyEvent(
        context,
        event({
          source_id: `src-${item.runId}`,
          source_seq: "2",
          root_native_id: item.native,
          session_native_id: `${item.native}-child`,
          parent_native_id: item.native,
          payload: { title: `${item.purpose} 子 Agent`, status: "running" },
        }),
      );
    }
    const tree = conversations.getTree("wf1");
    const children = tree.nodes.filter((node) => node.kind === "subagent");
    expect(children).toHaveLength(PURPOSES.length);
    expect(new Set(tree.nodes.filter((node) => node.kind === "main").map((node) => node.id)).size).toBe(
      PURPOSES.length,
    );
    for (const item of PURPOSES) {
      const root = tree.nodes.find((node) => node.native_session_id === item.native);
      const child = tree.nodes.find(
        (node) => node.native_session_id === `${item.native}-child`,
      );
      expect(root?.purpose).toBe(item.purpose);
      expect(child?.parent_id).toBe(root?.id);
      expect(child?.purpose).toBe(item.purpose);
    }
  });

  it("rejects write tools at the native or controlled boundary for readonly purposes", () => {
    expect(readOnlyPurpose("planning")).toBe(true);
    expect(readOnlyPurpose("quality_review")).toBe(true);
    expect(readOnlyPurpose("implement")).toBe(false);
    expect(readOnlyPurpose("functional_fix")).toBe(false);
    const readonlyCtx = runContext("planning");
    const writeCtx = runContext("implement");
    const codex = new CodexNativeAdapter({ cliVersion: "0.50.0" });
    const claude = new ClaudeCodeNativeAdapter();
    const grok = new GrokBuildNativeAdapter();
    const qoder = new QoderNativeAdapter();
    const cursor = new CursorAgentNativeAdapter();
    const opencode = new OpenCodeNativeAdapter();
    const adapters = [
      { id: "codex", adapter: codex },
      { id: "claude-code", adapter: claude },
      { id: "grok-build", adapter: grok },
      { id: "qoder", adapter: qoder },
      { id: "cursor-agent", adapter: cursor },
      { id: "opencode", adapter: opencode },
    ] as const;
    for (const item of adapters) {
      const readonlyInv = item.adapter.buildInvocation(readonlyCtx, item.id);
      const writeInv = item.adapter.buildInvocation(writeCtx, item.id);
      const readonlyText = argsText(readonlyInv).toLowerCase();
      const writeText = argsText(writeInv).toLowerCase();
      if (item.id === "codex") {
        expect(readonlyText).toContain("read-only");
        expect(writeText).toContain("workspace-write");
      } else if (item.id === "cursor-agent") {
        expect(readonlyInv.args).toContain("ask");
        expect(writeInv.args).not.toContain("ask");
      } else if (item.id === "opencode") {
        expect(readonlyText).toContain('"write":"deny"');
        expect(readonlyText).toContain('"edit":"deny"');
        expect(writeInv.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      } else {
        expect(readonlyText).toMatch(/write|deny|disallowed|plan|ask/);
        expect(readonlyText).toMatch(/write/);
      }
      expect(readonlyText).not.toEqual(writeText);
    }
    const kimiReadonly = clientInvocation("kimi-code", readonlyCtx, "kimi");
    const kimiWrite = clientInvocation("kimi-code", writeCtx, "kimi");
    expect(kimiReadonly.args.join(" ")).toBe(kimiWrite.args.join(" "));
    expect(kimiReadonly.args.join(" ")).not.toMatch(/disallowed|deny|read-only/);
  });
});
