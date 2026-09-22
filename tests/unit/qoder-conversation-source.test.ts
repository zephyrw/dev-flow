import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QoderNativeAdapter } from "../../packages/adapters/qoder/src/adapter.js";
import {
  applyQoderConstrainedDelegationArgs,
  evaluateQoderReadonlyDelegation,
  parseQoderReadonlyInvocation,
  QoderConversationDecoder,
  QoderConversationSource,
  QoderStreamMapper,
  qoderSpawnIsConstrained,
  qoderSubagentCapabilities,
  QODER_READONLY_CHILD_AGENT,
  QODER_READONLY_DELEGATION_TOOL,
  QODER_READONLY_READ_TOOLS,
} from "../../packages/adapters/qoder/src/conversation-source.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";

const fixtureDir = join(
  process.cwd(),
  "tests/fixtures/conversations/qoder",
);

function decodeFixture(name: string): NativeConversationEvent[] {
  const text = readFileSync(join(fixtureDir, name), "utf8");
  const mapper = new QoderStreamMapper(`fixture:${name}`);
  const events: NativeConversationEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    events.push(...mapper.decodeLine(line, "2026-09-20T00:00:00.000Z"));
  }
  return events;
}

function sampleContext(purpose: RunContext["purpose"]): RunContext {
  return {
    workflowId: "wf_qoder",
    runId: "run_qoder",
    stage: purpose,
    epoch: 1,
    workspaceRoots: { repo: "C:/repo" },
    allowedPaths: ["app.ts"],
    purpose,
    toolProfile: {
      id: "prof_qoder",
      revision: 1,
      adapterId: "qoder",
      modelSelection: "native-config",
      options: {},
    },
  };
}

describe("SA-U17 qoder conversation source", () => {
  it("does not treat an unconstrained Agent/Task whitelist as verified readonly delegation", () => {
    const result = evaluateQoderReadonlyDelegation({
      allowedTools: ["Read", "Glob", "Grep", "Agent", "Task"],
    });
    expect(result.readonly_delegation).toBe("unsupported");
    expect(result.reason).toContain("任意 Agent");
    expect(
      evaluateQoderReadonlyDelegation({
        allowedTools: ["Read", "Glob", "Grep", "Agent"],
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit"],
      }).readonly_delegation,
    ).toBe("unsupported");
    expect(qoderSpawnIsConstrained({ description: "任意委派" })).toBe(false);
  });

  it("verifies constrained Agent delegation only when child tools stay read-only", () => {
    const verified = evaluateQoderReadonlyDelegation({
      allowedTools: [...QODER_READONLY_READ_TOOLS, QODER_READONLY_DELEGATION_TOOL],
      disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task"],
      childAgents: {
        [QODER_READONLY_CHILD_AGENT]: {
          tools: [...QODER_READONLY_READ_TOOLS],
        },
      },
    });
    expect(verified.readonly_delegation).toBe("verified");
    expect(
      evaluateQoderReadonlyDelegation({
        allowedTools: [...QODER_READONLY_READ_TOOLS, QODER_READONLY_DELEGATION_TOOL],
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "Task"],
        childAgents: {
          [QODER_READONLY_CHILD_AGENT]: { tools: ["Read", "Write"] },
        },
      }).readonly_delegation,
    ).toBe("unsupported");
    expect(
      qoderSpawnIsConstrained({
        subagent_type: QODER_READONLY_CHILD_AGENT,
        tools: [...QODER_READONLY_READ_TOOLS],
      }),
    ).toBe(true);
  });

  it("rewrites readonly invocation onto constrained delegation instead of Agent,Task", () => {
    const rewritten = applyQoderConstrainedDelegationArgs([
      "--print",
      "--tools",
      "Read,Glob,Grep,Agent,Task",
      "--disallowed-tools",
      "Bash,Edit,Write",
      "--agents",
      JSON.stringify({
        "devflow-readonly-child": { description: "default child" },
      }),
    ]);
    const parsed = parseQoderReadonlyInvocation(rewritten);
    expect(parsed.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Agent",
    ]);
    expect(parsed.allowedTools).not.toContain("Task");
    expect(parsed.disallowedTools).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "NotebookEdit", "Task"]),
    );
    expect(parsed.childAgents?.[QODER_READONLY_CHILD_AGENT]?.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
    ]);
    expect(evaluateQoderReadonlyDelegation(parsed).readonly_delegation).toBe(
      "verified",
    );
  });

  it("keeps agent and session identities separate across root and child events", () => {
    const events = decodeFixture("identity-split.jsonl");
    const root = events.find(
      (event) =>
        event.kind === "discovered" &&
        event.session_native_id === "qoder-session-root-003",
    );
    expect(root?.agent_native_id).toBe("qoder-agent-root-003");
    expect(root?.session_native_id).not.toBe(root?.agent_native_id);
    const child = events.find(
      (event) => event.session_native_id === "qoder-session-child-aa",
    );
    expect(child?.agent_native_id).toBe("qoder-agent-child-bb");
    expect(child?.session_native_id).toBe("qoder-session-child-aa");
    expect(child?.parent_native_id).toBe("qoder-session-root-003");
    expect(
      events.every((event) => {
        if (!event.session_native_id || !event.agent_native_id) return true;
        if (event.session_native_id.endsWith("aa"))
          return event.agent_native_id.endsWith("bb");
        if (event.session_native_id.endsWith("003"))
          return event.agent_native_id.endsWith("003");
        return true;
      }),
    ).toBe(true);
  });

  it("records resume identifiers from native session ids and splits constrained children", () => {
    const events = decodeFixture("constrained-delegate.jsonl");
    const rootInit = events.find(
      (event) =>
        event.kind === "discovered" &&
        event.session_native_id === "qoder-session-root-001",
    );
    expect(
      (rootInit?.payload as { resume_session_id?: string }).resume_session_id,
    ).toBe("qoder-session-root-001");
    const spawn = events.find(
      (event) =>
        event.kind === "discovered" &&
        (event.payload as { spawn_call_id?: string }).spawn_call_id ===
          "call_review_1" &&
        (event.payload as { readonly_constrained?: boolean })
          .readonly_constrained === true,
    );
    expect(spawn).toBeDefined();
    const child = events.find(
      (event) =>
        event.kind === "discovered" &&
        event.agent_native_id === "qoder-agent-child-9f",
    );
    expect(child?.session_native_id).toBe("qoder-session-child-9f");
    expect(child?.agent_native_id).not.toBe(child?.session_native_id);
    expect(
      (child?.payload as { resume_session_id?: string }).resume_session_id,
    ).toBe("qoder-session-child-9f");
    const childActivity = events.find(
      (event) =>
        event.kind === "activity" &&
        event.session_native_id === "qoder-session-child-9f",
    );
    expect(childActivity?.agent_native_id).toBe("qoder-agent-child-9f");
    expect(
      (decodeFixture("resume.jsonl").find((event) => event.kind === "state")
        ?.payload as { resume_session_id?: string }).resume_session_id,
    ).toBe("qoder-session-resume-004");
  });

  it("does not invent child conversations from unknown events or unconstrained spawn defaults", () => {
    expect(decodeFixture("unknown-event.jsonl")).toEqual([]);
    const unconstrained = decodeFixture("unconstrained-delegate.jsonl");
    const agentSpawn = unconstrained.find(
      (event) =>
        (event.payload as { spawn_call_id?: string }).spawn_call_id ===
        "call_open_1",
    );
    expect(
      (agentSpawn?.payload as { readonly_constrained?: boolean })
        .readonly_constrained,
    ).toBe(false);
    const openChild = unconstrained.find(
      (event) => event.agent_native_id === "qoder-agent-open-1",
    );
    expect(openChild?.session_native_id).toBeUndefined();
  });

  it("exposes capabilities and applies constrained readonly args on the qoder adapter", () => {
    const adapter = new QoderNativeAdapter();
    expect(adapter.subagents).toMatchObject(qoderSubagentCapabilities());
    expect(adapter.subagents.readonly_delegation).toBe("verified");
    expect(adapter.subagents.discovery).toBe("native");
    expect(adapter.subagents.file_input).toEqual({
      text: true,
      image: false,
      binary: false,
    });
    const planning = adapter.buildInvocation(
      sampleContext("planning"),
      "C:/fake/qoder.exe",
    );
    const parsed = parseQoderReadonlyInvocation(planning.args);
    expect(evaluateQoderReadonlyDelegation(parsed).readonly_delegation).toBe(
      "verified",
    );
    const implementing = adapter.buildInvocation(
      sampleContext("implement"),
      "C:/fake/qoder.exe",
    );
    expect(implementing.args).not.toContain("--tools");
    const decoder = new QoderConversationDecoder("qoder:stream:test");
    const streamed = decoder.push({
      stream: "stdout",
      timestamp: "2026-09-20T00:00:00.000Z",
      data: readFileSync(join(fixtureDir, "root-init.jsonl")),
      final: true,
    });
    expect(streamed.some((event) => event.kind === "discovered")).toBe(true);
  });

  it("reads only a bound jsonl source and keeps resume identifiers", async () => {
    const source = new QoderConversationSource({
      filePath: join(fixtureDir, "constrained-delegate.jsonl"),
      rootNativeId: "qoder-session-root-001",
    });
    const events = await source.readEvents({
      source_id: source.sourceId,
      source_seq: "0",
    });
    expect(
      events.some(
        (event) =>
          event.kind === "discovered" &&
          event.agent_native_id === "qoder-agent-child-9f" &&
          (event.payload as { resume_session_id?: string }).resume_session_id ===
            "qoder-session-child-9f",
      ),
    ).toBe(true);
    const adapter = new QoderNativeAdapter();
    adapter.bindConversationFile(
      join(fixtureDir, "resume.jsonl"),
      "qoder-session-resume-004",
    );
    const recovered = await adapter.readConversationEvents({
      source_id: join(fixtureDir, "resume.jsonl"),
      source_seq: "0",
    });
    expect(
      recovered.some(
        (event) =>
          (event.payload as { resume_session_id?: string }).resume_session_id ===
          "qoder-session-resume-004",
      ),
    ).toBe(true);
    expect(
      await adapter.readConversationEvents({
        source_id: "C:/not-bound/session.jsonl",
      }),
    ).toEqual([]);
  });
});
