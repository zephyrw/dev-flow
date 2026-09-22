import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  OpenCodeConversationSource,
  bindOpenCodeInstance,
  decodeOpenCodeJsonEvent,
  evaluateOpenCodeReadonlyTask,
  openCodeSubagentCapabilities,
  type OpenCodeHttpClient,
  type OpenCodeInstanceBinding,
} from "../../packages/adapters/opencode/src/conversation-source.js";
import { parseJsonLine } from "../../packages/adapters/sdk/src/conversation-source.js";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/conversations/opencode",
);

function readFixture(name: string): string {
  return readFileSync(join(fixtureRoot, name), "utf8");
}

function readJson<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

function jsonlEvents(name: string): unknown[] {
  return readFixture(name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseJsonLine(line))
    .filter((item) => item !== undefined);
}

function binding(
  extra: Partial<OpenCodeInstanceBinding> = {},
): OpenCodeInstanceBinding {
  return {
    workflowId: "wf1",
    runId: "run1",
    lineageId: "wf1:run1",
    rootSessionId: "ses_root1",
    purpose: "quality_review",
    cliVersion: "1.18.30",
    agentName: "devflow-review",
    ...extra,
  };
}

describe("SA-U18 OpenCode conversation source", () => {
  it("binds the current instance session and splits root/child from json events", () => {
    const current = binding();
    const events = jsonlEvents("run-json-root-and-task.jsonl").flatMap((raw) =>
      decodeOpenCodeJsonEvent(raw, current),
    );
    const child = events.filter((item) => item.session_native_id === "ses_child1");
    const root = events.filter((item) => item.session_native_id === "ses_root1");
    expect(child.some((item) => item.kind === "discovered")).toBe(true);
    expect(child.some((item) => item.kind === "model")).toBe(true);
    expect(
      child.find((item) => item.kind === "model")?.payload,
    ).toMatchObject({ actual_model: "openai/gpt-5" });
    expect(root.some((item) => item.kind === "activity")).toBe(true);
    expect(
      events.some((item) => JSON.stringify(item.payload).includes("私有推理")),
    ).toBe(false);
    expect(
      events.some((item) => item.payload && (item.payload as { activity_id?: string }).activity_id === "codex-item"),
    ).toBe(false);
    const accepted = bindOpenCodeInstance(
      { sessionId: "ses_root1", runId: "run1" },
      current,
    );
    expect(accepted.ok).toBe(true);
  });

  it("rejects external instances and unbound global servers", () => {
    const current = binding({
      managedServer: {
        origin: "http://127.0.0.1:41200",
        runId: "run1",
      },
    });
    expect(
      bindOpenCodeInstance(
        { attachUrl: "http://localhost:4096", runId: "run1" },
        current,
      ).ok,
    ).toBe(false);
    expect(
      bindOpenCodeInstance(
        { origin: "http://10.0.0.8:4096", runId: "run1" },
        current,
      ).ok,
    ).toBe(false);
    expect(
      bindOpenCodeInstance({ sessionId: "ses_other", runId: "run1" }, current)
        .ok,
    ).toBe(false);
    expect(
      bindOpenCodeInstance({ runId: "run-other" }, current).ok,
    ).toBe(false);
    expect(
      bindOpenCodeInstance(
        { origin: "http://127.0.0.1:41200", sessionId: "ses_root1", runId: "run1" },
        current,
      ).ok,
    ).toBe(true);
  });

  it("reads children, activity and abort only from the bound managed server", async () => {
    const children = readJson<unknown[]>("children.json");
    const rootMessages = readJson<unknown[]>("messages-root.json");
    const childMessages = readJson<unknown[]>("messages-child.json");
    const status = readJson<Record<string, unknown>>("status.json");
    let aborted = "";
    const http: OpenCodeHttpClient = {
      async get(path: string) {
        if (path === "/session/ses_root1/children") return children;
        if (path === "/session/ses_root1/message") return rootMessages;
        if (path === "/session/ses_child1/message") return childMessages;
        if (path === "/session/status") return status;
        throw new Error("unexpected " + path);
      },
      async post(path: string) {
        aborted = path;
        return true;
      },
    };
    const source = new OpenCodeConversationSource(
      binding({
        managedServer: {
          origin: "http://127.0.0.1:41200",
          runId: "run1",
        },
      }),
      http,
    );
    const caps = source.capabilities();
    expect(caps.discovery).toBe("native");
    expect(caps.activity).toBe("native");
    expect(caps.stop).toBe("native");
    const events = await source.readEvents({
      source_id: "opencode:server:run1",
      source_seq: "0",
    });
    expect(
      events.some(
        (item) =>
          item.kind === "discovered" && item.session_native_id === "ses_child1",
      ),
    ).toBe(true);
    expect(events.some((item) => item.session_native_id === "ses_foreign")).toBe(
      false,
    );
    expect(
      events.some(
        (item) =>
          item.kind === "activity" &&
          item.session_native_id === "ses_child1" &&
          JSON.stringify(item.payload).includes("fixed.txt"),
      ),
    ).toBe(true);
    const stopped = await source.abort({
      conversation_id: "conv_child",
      native_session_id: "ses_child1",
    });
    expect(stopped.confirmation).toBe("native");
    expect(aborted).toBe("/session/ses_child1/abort");
    const foreign = await source.abort({
      conversation_id: "conv_x",
      native_session_id: "ses_foreign",
    });
    expect(foreign.confirmation).toBe("unconfirmed");
  });

  it("records local trusted-source gaps when no bindable server exists", async () => {
    const source = new OpenCodeConversationSource(
      binding({
        agentConfig: readJson("agent-task-denied.json"),
        eventFilePath: join(fixtureRoot, "run-json-root-and-task.jsonl"),
      }),
    );
    const caps = source.capabilities();
    expect(caps.discovery).toBe("scoped-record");
    expect(caps.activity).toBe("scoped-record");
    expect(caps.stop).toBe("unavailable");
    expect(caps.reason).toMatch(/没有可绑定的 HTTP server/);
    expect(caps.reason).toMatch(/未另启常驻服务/);
    const events = await source.readEvents({
      source_id: "opencode:json:run1",
      source_seq: "0",
    });
    expect(events.some((item) => item.session_native_id === "ses_child1")).toBe(
      true,
    );
    const stopped = await source.abort({
      conversation_id: "conv_child",
      native_session_id: "ses_child1",
    });
    expect(stopped.confirmation).toBe("unconfirmed");
    expect(stopped.reason).toMatch(/abort/);
  });

  it("only treats task permission as verified when subagents stay read-only", () => {
    const verified = evaluateOpenCodeReadonlyTask(
      readJson("agent-readonly-task.json"),
    );
    expect(verified.readonly_delegation).toBe("verified");
    expect(verified.allowed_agents).toEqual(["devflow-review"]);
    expect(
      evaluateOpenCodeReadonlyTask(readJson("agent-open-task.json"))
        .readonly_delegation,
    ).toBe("unsupported");
    expect(
      evaluateOpenCodeReadonlyTask(readJson("agent-task-denied.json"))
        .readonly_delegation,
    ).toBe("unsupported");
    expect(
      evaluateOpenCodeReadonlyTask({
        agent: {
          "devflow-review": {
            permission: {
              "*": "deny",
              read: "allow",
              task: { "*": "deny", explore: "allow" },
            },
          },
        },
      }).readonly_delegation,
    ).toBe("unsupported");
  });

  it("does not claim native children APIs without a bound instance", () => {
    const caps = openCodeSubagentCapabilities({
      workflowId: "wf1",
      runId: "run1",
      lineageId: "wf1:run1",
    });
    expect(caps.discovery).toBe("unknown");
    expect(caps.stop).toBe("unavailable");
    expect(caps.reason).toMatch(/没有可绑定的 OpenCode 实例/);
  });

  it("ignores global --attach and only binds a same-run --port server", () => {
    const input = {
      workflowId: "wf1",
      runId: "run1",
      stage: "quality_review",
      epoch: 1,
      workspaceRoots: { repo: "C:/tmp" },
      allowedPaths: ["README.md"],
      purpose: "quality_review" as const,
      toolProfile: {
        id: "p1",
        revision: 1,
        adapterId: "opencode" as const,
        modelSelection: "native-config" as const,
        options: {},
      },
    };
    const attached = OpenCodeConversationSource.fromPrepared(input, {
      executable: "opencode",
      args: [
        "run",
        "--format",
        "json",
        "--attach",
        "http://localhost:4096",
        "prompt",
      ],
      cwd: "C:/tmp",
      env: {},
    });
    expect(attached.capabilities().discovery).toBe("unknown");
    expect(attached.capabilities().stop).toBe("unavailable");
    const managed = OpenCodeConversationSource.fromPrepared(input, {
      executable: "opencode",
      args: ["run", "--format", "json", "--port", "41200", "prompt"],
      cwd: "C:/tmp",
      env: {},
    });
    expect(managed.capabilities().discovery).toBe("native");
    expect(managed.capabilities().stop).toBe("native");
  });
});
