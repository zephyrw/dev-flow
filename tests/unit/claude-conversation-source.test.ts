import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ClaudeCodeNativeAdapter } from "../../packages/adapters/claude/src/adapter.js";
import {
  ClaudeConversationSource,
  bindClaudeAgentEvents,
  claudeResumeContinuation,
  claudeSourceId,
  claudeSubagentCapabilities,
  decodeClaudeHookLine,
  decodeClaudeStreamLine,
  decodeClaudeTranscriptLine,
  type ClaudeDecodeContext,
  type ClaudeEventPayload,
} from "../../packages/adapters/claude/src/conversation-source.js";
import {
  CLAUDE_READONLY_AGENT,
  CLAUDE_WRITE_TOOLS,
  applyClaudeSessionInvocation,
  claudeReadonlyAgentDefinition,
  parentAllowsAgentSpawn,
  prepareClaudeSessionScope,
  proveReadonlyDelegation,
  userGlobalClaudeDirs,
  type ClaudeAgentDefinition,
} from "../../packages/adapters/claude/src/scoped-hooks.js";
import type { NativeConversationEvent, RunContext } from "../../packages/adapters/sdk/src/interface.js";

const fixtureDir = fileURLToPath(
  new URL("../fixtures/conversations/claude-code/", import.meta.url),
);

function fixtureLines(name: string): string[] {
  return readFileSync(join(fixtureDir, name), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim());
}

function decodeLines(
  lines: string[],
  kind: ClaudeDecodeContext["sourceKind"],
  extra: Partial<ClaudeDecodeContext> = {},
): NativeConversationEvent[] {
  const events: NativeConversationEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const context: ClaudeDecodeContext = {
      sourceId: claudeSourceId(kind, "run-1"),
      sourceSeq: String(index + 1),
      sourceKind: kind,
      rootNativeId: "11111111-1111-4111-8111-111111111111",
      ...extra,
    };
    if (kind === "stream") events.push(...decodeClaudeStreamLine(line, context));
    else if (kind === "hook") events.push(...decodeClaudeHookLine(line, context));
    else events.push(...decodeClaudeTranscriptLine(line, context));
  }
  return events;
}

function payload(event: NativeConversationEvent): ClaudeEventPayload {
  return event.payload as ClaudeEventPayload;
}

function runContext(
  extra: Partial<RunContext> & { outputPath: string; purpose?: RunContext["purpose"] },
): RunContext {
  return {
    workflowId: "wf-1",
    runId: "run-1",
    stage: "execute",
    epoch: 1,
    workspaceRoots: { main: extra.outputPath },
    allowedPaths: ["README.md"],
    toolProfile: {
      id: "claude-profile",
      revision: 1,
      adapterId: "claude-code",
      modelSelection: "native-config",
      options: {},
    },
    purpose: extra.purpose ?? "implement",
    ...extra,
  };
}

describe("SA-U13 Claude conversation source", () => {
  it("binds Task/Agent calls to agent_id and dedups hook/stream/transcript", () => {
    const stream = decodeLines(fixtureLines("stream-task-spawn.jsonl"), "stream");
    const hook = decodeLines(
      fixtureLines("hook-subagent-start-stop.jsonl"),
      "hook",
    );
    const transcript = decodeLines(
      fixtureLines("child-transcript.jsonl"),
      "transcript",
      { agentNativeId: "agent-readonly-1" },
    );
    const merged = bindClaudeAgentEvents([...stream, ...hook, ...transcript]);
    const children = merged.filter(
      (event) => event.kind === "discovered" && event.agent_native_id,
    );
    expect(children).toHaveLength(1);
    expect(children[0]?.agent_native_id).toBe("agent-readonly-1");
    expect(payload(children[0]!).spawn_call_id).toBe("toolu_01TaskSpawn");
    expect(payload(children[0]!).agent_type).toBe("devflow-readonly");
    const taskCall = merged.find(
      (event) => payload(event).event === "task_call" || payload(event).spawn_call_id === "toolu_01TaskSpawn",
    );
    expect(taskCall?.agent_native_id).toBe("agent-readonly-1");
    const childActivities = merged.filter(
      (event) =>
        event.kind === "activity" &&
        event.agent_native_id === "agent-readonly-1",
    );
    expect(childActivities).toHaveLength(1);
    expect(payload(childActivities[0]!).public_text).toContain("README.md");
    const stops = merged.filter(
      (event) => payload(event).event === "subagent_stop",
    );
    expect(stops).toHaveLength(1);
  });

  it("does not treat unknown version events or ordinary tools as subagents", () => {
    const events = decodeLines(
      fixtureLines("unknown-version-events.jsonl"),
      "stream",
    );
    expect(
      events.filter((event) => payload(event).event === "task_call"),
    ).toHaveLength(1);
    expect(payload(events[0]!).spawn_call_id).toBe("toolu_01AgentSpawn");
    expect(
      events.some(
        (event) =>
          event.agent_native_id === "should-not-bind" ||
          event.agent_native_id === "also-not-a-hook",
      ),
    ).toBe(false);
    expect(
      events.some((event) => payload(event).spawn_call_id === "toolu_read"),
    ).toBe(false);
  });

  it("maps resume by parent, in-process child and background child", () => {
    expect(claudeResumeContinuation("parent", "2.1.270")).toEqual({
      resume: "native",
      continuation: "resume-native",
    });
    expect(claudeResumeContinuation("task-child", "2.1.270")).toEqual({
      resume: "unavailable",
      continuation: "recreate-after-confirmed-exit",
    });
    expect(claudeResumeContinuation("background-child", "2.1.270")).toEqual({
      resume: "native",
      continuation: "resume-native",
    });
    expect(claudeResumeContinuation("background-child", "2.0.12")).toEqual({
      resume: "unavailable",
      continuation: "recreate-after-confirmed-exit",
    });
    expect(claudeResumeContinuation("parent", "1.9.0")).toEqual({
      resume: "unavailable",
      continuation: "recreate-after-confirmed-exit",
    });
    const spawned = decodeLines(fixtureLines("stream-task-spawn.jsonl"), "stream");
    const call = spawned.find((event) => payload(event).event === "task_call");
    expect(payload(call!).continuation).toBe("recreate-after-confirmed-exit");
  });

  it("proves readonly child tools natively and rejects prompt-only agents", () => {
    const defined = claudeReadonlyAgentDefinition();
    expect(defined.tools).toEqual(["Read", "Glob", "Grep"]);
    for (const tool of CLAUDE_WRITE_TOOLS) {
      expect(defined.tools).not.toContain(tool);
      expect(defined.disallowedTools).toContain(tool);
    }
    expect(proveReadonlyDelegation(defined).status).toBe("verified");
    expect(
      proveReadonlyDelegation({
        description: "只读检查",
        prompt: "任意说明",
        tools: ["Read", "Glob", "Grep"],
      }).status,
    ).toBe("verified");
    const promptOnly: ClaudeAgentDefinition = {
      description: "请只读检查",
      prompt: "不要使用 Bash、Edit 或 Write",
    };
    expect(proveReadonlyDelegation(promptOnly)).toMatchObject({
      status: "unsupported",
    });
    const inheritedWrite: ClaudeAgentDefinition = {
      ...defined,
      tools: ["Read", "Bash"],
    };
    expect(proveReadonlyDelegation(inheritedWrite).status).toBe("unsupported");
    const capabilities = claudeSubagentCapabilities({
      cliVersion: "2.1.270",
      agents: { [CLAUDE_READONLY_AGENT]: defined },
      agentSpawnAllowed: true,
    });
    expect(capabilities.readonly_delegation).toBe("verified");
    expect(capabilities.discovery).toBe("native");
    expect(capabilities.resume).toBe("native");
  });

  it("writes session hooks only to the current Run directory", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-session-"));
    const scope = prepareClaudeSessionScope(join(root, "claude-session"));
    expect(scope.eventsPath.startsWith(root)).toBe(true);
    expect(scope.settingsPath.startsWith(root)).toBe(true);
    const settings = JSON.parse(readFileSync(scope.settingsPath, "utf8"));
    expect(settings.hooks.SubagentStart).toHaveLength(1);
    expect(settings.hooks.SubagentStop).toHaveLength(1);
    const command = settings.hooks.SubagentStart[0].hooks[0].command as string;
    expect(command).toContain(JSON.stringify(process.execPath));
    expect(command).toContain(JSON.stringify(scope.appendScriptPath));
    expect(command).not.toMatch(/Bash|rm |del /i);
    for (const globalDir of userGlobalClaudeDirs()) {
      expect(scope.directory.startsWith(globalDir)).toBe(false);
      expect(() => prepareClaudeSessionScope(globalDir)).toThrow(
        /禁止写入用户全局/,
      );
    }
    execFileSync(process.execPath, [scope.appendScriptPath], {
      input: JSON.stringify({
        hook_event_name: "SubagentStart",
        session_id: "11111111-1111-4111-8111-111111111111",
        agent_id: "agent-readonly-1",
        agent_type: "devflow-readonly",
        tool_use_id: "toolu_01TaskSpawn",
      }),
    });
    const recorded = readFileSync(scope.eventsPath, "utf8");
    expect(recorded).toContain("agent-readonly-1");
    execFileSync(process.execPath, [scope.appendScriptPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", agent_id: "x" }),
    });
    expect(readFileSync(scope.eventsPath, "utf8")).toBe(recorded);
  });

  it("injects session agents and keeps parent write denials", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-inv-"));
    const adapter = new ClaudeCodeNativeAdapter();
    const implement = adapter.buildInvocation(
      runContext({ outputPath: join(root, "result.json"), purpose: "implement" }),
      "claude",
    );
    expect(implement.args).toContain("--settings");
    expect(implement.args).toContain("--agents");
    expect(implement.args).toContain("--include-hook-events");
    expect(implement.args).toContain("--forward-subagent-text");
    const agentsJson = implement.args[implement.args.indexOf("--agents") + 1] ?? "";
    const agents = JSON.parse(agentsJson) as Record<string, ClaudeAgentDefinition>;
    expect(proveReadonlyDelegation(agents[CLAUDE_READONLY_AGENT]).status).toBe(
      "verified",
    );
    expect(parentAllowsAgentSpawn(implement.args)).toBe(true);
    expect(adapter.subagents?.readonly_delegation).toBe("verified");

    const planning = adapter.buildInvocation(
      runContext({
        outputPath: join(root, "plan.json"),
        purpose: "planning",
        runId: "run-plan",
      }),
      "claude",
    );
    expect(planning.args).toContain("--disallowedTools");
    expect(
      planning.args[planning.args.indexOf("--disallowedTools") + 1],
    ).toMatch(/Bash.*Write|Write.*Bash/);
    expect(
      planning.args[planning.args.indexOf("--disallowedTools") + 1],
    ).not.toMatch(/\bAgent\b/);
    expect(parentAllowsAgentSpawn(planning.args)).toBe(true);
    expect(planning.args.join(" ")).toMatch(/disallowedTools/);
    expect(planning.args.join(" ")).toMatch(/Bash/);
    expect(
      planning.args.filter((arg) => arg === "--agents"),
    ).toHaveLength(1);
    const planningAgents = JSON.parse(
      planning.args[planning.args.indexOf("--agents") + 1] ?? "{}",
    );
    expect(
      proveReadonlyDelegation(planningAgents[CLAUDE_READONLY_AGENT]).status,
    ).toBe("verified");
    for (const tool of CLAUDE_WRITE_TOOLS) {
      expect(planningAgents[CLAUDE_READONLY_AGENT].tools).not.toContain(tool);
    }
  });

  it("reads exact child transcript from a bound path and recovers after cursor", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-source-"));
    const transcript = join(root, "agent-readonly-1.jsonl");
    writeFileSync(
      transcript,
      readFileSync(join(fixtureDir, "child-transcript.jsonl")),
    );
    const source = new ClaudeConversationSource({
      rootNativeId: "11111111-1111-4111-8111-111111111111",
      agents: { [CLAUDE_READONLY_AGENT]: claudeReadonlyAgentDefinition() },
    });
    source.registerTranscript("agent-readonly-1", transcript);
    const first = await source.readEvents({
      source_id: claudeSourceId("transcript", "agent-readonly-1"),
      source_seq: "0",
    });
    expect(first.some((event) => event.kind === "activity")).toBe(true);
    expect(first.every((event) => event.agent_native_id === "agent-readonly-1")).toBe(
      true,
    );
    const again = await source.readEvents({
      source_id: claudeSourceId("transcript", "agent-readonly-1"),
      source_seq: String(readFileSync(transcript).length),
    });
    expect(again).toEqual([]);
    source.registerTranscript("agent-readonly-1", root + "/../escape.jsonl");
    expect(
      await source.readEvents({
        source_id: claudeSourceId("transcript", "missing"),
      }),
    ).toEqual([]);
  });

  it("decodes live stream chunks through the adapter binder", () => {
    const adapter = new ClaudeCodeNativeAdapter();
    const events = adapter.decodeConversation({
      stream: "stdout",
      data: fixtureLines("stream-task-spawn.jsonl").join("\n") + "\n",
      timestamp: "2026-09-20T00:00:00.000Z",
      runId: "run-1",
    });
    const child = events.find((event) => event.agent_native_id === "agent-readonly-1");
    expect(child).toBeTruthy();
    expect(child?.root_native_id).toBe("11111111-1111-4111-8111-111111111111");
  });
});

describe("SA-U13 Claude session invocation helper", () => {
  it("does not rewrite caller args when no prompt is present", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-helper-"));
    const scope = prepareClaudeSessionScope(join(root, "claude-session"));
    const applied = applyClaudeSessionInvocation(
      {
        executable: "claude",
        args: ["--print"],
        cwd: root,
        env: {},
      },
      scope,
    );
    expect(applied.args.at(-1)).toBe("--forward-subagent-text");
    expect(existsSync(scope.settingsPath)).toBe(true);
  });
});
