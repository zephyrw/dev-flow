import { it, expect } from "vitest";
import { setup } from "../helpers.js";
import {
  RunTelemetry,
  routeNativeConversationEvent,
  routeRawTelemetryEvent,
  shouldApplyRootSessionIdentity,
} from "../../packages/runtime/src/run-telemetry.js";
import { conversationActivityKey, ConversationActivityPayloadSchema } from "../../packages/contracts/src/conversation.js";
import { publicEvent } from "../../packages/core/src/util.js";
import {
  conversationLogs,
  conversationActivityLogEntry,
} from "../../packages/presentation/src/conversation-activity.js";
import { readableLogs } from "../../packages/presentation/src/activity.js";
import type { Workflow, Run } from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";

function fixture(purpose: Run["purpose"] = "planner_takeover", adapter: "codex" | "agy" = "codex") {
  const s = setup();
  const w = {
    id: "w",
    project_id: "p",
    run_id: "r",
    state: "EXECUTING",
  } as Workflow;
  const run = {
    id: "r",
    workflow_id: "w",
    adapter,
    purpose,
    status: "running",
    started_at: new Date().toISOString(),
    profile: {
      id: "profile",
      revision: 1,
      adapterId: adapter,
      modelSelection: "explicit",
      modelId: "requested-model",
      options: {},
    },
  } as Run;
  s.store.put("run", run.id, w.id, run);
  return { ...s, w, run, telemetry: new RunTelemetry(s.store, w, run) };
}

function childActivity(
  session: string,
  itemId: string,
  command: string,
  seq: string,
): NativeConversationEvent {
  return {
    source_id: "fixture",
    source_seq: seq,
    root_native_id: "root-session",
    session_native_id: session,
    parent_native_id: "root-session",
    kind: "activity",
    payload: {
      type: "item.started",
      item: {
        id: itemId,
        type: "command_execution",
        command,
      },
    },
  };
}

it.each([
  { label: "below limit", make: (limit: number) => "x".repeat(limit - 1) },
  { label: "at limit", make: (limit: number) => "x".repeat(limit) },
  { label: "over limit", make: (limit: number) => "x".repeat(limit + 1) },
  { label: "redaction expands at cut", make: (limit: number) => "x".repeat(limit - 12) + " token=a " },
  { label: "truncated JSON", make: (limit: number) => JSON.stringify({ value: "x".repeat(limit), token: "private-secret", reasoning: "private-thought" }) },
])("public activity limits survive persistence and repeated redaction: $label", ({ make }) => {
  const s = fixture();
  try {
    for (const session of ["root-session", "child-a"]) {
      s.telemetry.acceptConversationEvent({
        source_id: "fixture",
        source_seq: session,
        root_native_id: "root-session",
        session_native_id: session,
        ...(session === "child-a" ? { parent_native_id: "root-session" } : {}),
        kind: "activity",
        payload: {
          id: "bounded",
          kind: "tool",
          status: "active",
          title: make(200),
          text: make(16000),
          command: make(32000),
          cwd: make(4000),
          result_text: make(16000),
        },
      });
    }
    s.telemetry.flush();
    const events = s.store.events("w", 0, 1000);
    const activities = events.filter((event) => event.type === "ConversationActivity");
    expect(activities).toHaveLength(2);
    for (const event of activities) {
      const published = s.store.publicEvent(event);
      const parsed = ConversationActivityPayloadSchema.parse(published.payload);
      expect(publicEvent(published.payload)).toEqual(parsed);
      expect(parsed.command).toBeTruthy();
      expect(parsed.cwd).toBeTruthy();
      expect(parsed.result_text).toBeTruthy();
      expect(parsed.public_text).toBeTruthy();
      expect(parsed.status).toBe("running");
      if (publicEvent(make(32000)).length > 32000)
        expect(parsed.command!.endsWith("…")).toBe(true);
      const serialized = JSON.stringify(parsed);
      expect(serialized).not.toContain("token=a");
      expect(serialized).not.toContain("private-secret");
      expect(serialized).not.toContain("private-thought");
    }
    const root = events.find((event) => event.type === "NativeActivity")!.payload as any;
    for (const [field, limit] of Object.entries({ text: 16000, command: 32000, cwd: 4000, resultText: 16000 })) {
      expect(root[field].length).toBeLessThanOrEqual(limit);
      expect(publicEvent(root[field])).toBe(root[field]);
    }
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it.each([
  { flush: false, text: undefined, status: "done", expected: "completed" },
  { flush: false, text: " \n\t", status: "error", expected: "failed" },
  { flush: true, text: undefined, status: "done", expected: "completed" },
  { flush: true, text: " \n\t", status: "error", expected: "failed" },
])("status-only updates retain concrete text (flush=$flush, status=$status)", ({ flush, text, status, expected }) => {
  const s = fixture();
  try {
    const event = childActivity("child-a", "operation", "", "1");
    s.telemetry.acceptConversationEvent({
      ...event,
      payload: {
        id: "operation", kind: "tool", status: "active",
        title: "读取文件", text: "读取 src/example.ts", cwd: "C:/repo",
        command: "read src/example.ts", result_text: "exit code: 0",
      },
    });
    if (flush) s.telemetry.flush();
    s.telemetry.acceptConversationEvent({
      ...event, source_seq: "2",
      payload: {
        id: "operation", kind: "tool", status, text,
        cwd: " \t", command: " ", result_text: "\n",
      },
    });
    s.telemetry.flush();
    const activities = s.store.events("w", 0, 1000).filter((entry) => entry.type === "ConversationActivity");
    expect(activities).toHaveLength(flush ? 2 : 1);
    expect(activities.at(-1)!.payload).toMatchObject({
      public_text: "读取 src/example.ts", status: expected, cwd: "C:/repo",
      command: "read src/example.ts", result_text: "exit code: 0",
    });
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it.each([false, true])("authentication output stays suppressed across merged increments (flush=%s)", (flush) => {
  const s = fixture();
  try {
    for (const session of ["root-session", "child-a"]) {
      const event = {
        source_id: "fixture", root_native_id: "root-session",
        session_native_id: session,
        ...(session === "child-a" ? { parent_native_id: "root-session" } : {}),
        kind: "activity" as const,
      };
      s.telemetry.acceptConversationEvent({ ...event, source_seq: `${session}-1`, payload: {
        id: "auth", kind: "tool", status: "active", title: "执行命令",
        command: "tool login", text: "unlabelled-credential", cwd: "private/auth-path",
        result_text: "unlabelled-credential",
      } });
      if (flush) s.telemetry.flush();
      s.telemetry.acceptConversationEvent({ ...event, source_seq: `${session}-2`, payload: {
        id: "auth", kind: "tool", status: "done", title: "执行命令",
        text: "unlabelled-credential", cwd: "private/auth-path", result_text: "unlabelled-credential",
      } });
    }
    s.telemetry.flush();
    const events = s.store.events("w", 0, 1000);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("unlabelled-credential");
    expect(serialized).not.toContain("private/auth-path");
    for (const session of ["root-session", "child-a"]) {
      const activity = events.filter((event) => event.type === "ConversationActivity" &&
        (event.payload as any).conversation_id === session).at(-1)!.payload as any;
      expect(activity.status).toBe("completed");
      expect(activity.title).toContain("敏感认证操作");
      expect(activity.command).toBeUndefined();
      expect(activity.cwd).toBeUndefined();
      expect(activity.result_text).toBeUndefined();
    }
    const root = events.filter((event) => event.type === "NativeActivity").at(-1)!.payload as any;
    expect(root.status).toBe("done");
    expect(root.resultText).toBeUndefined();
    expect(s.telemetry.observation.active_tools).toBe(0);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("route 先区分 root/child，子事件不绑定主会话身份", () => {
  const bound = {
    nativeRootId: "root-session",
    conversationId: "root-session",
    attemptId: "r",
    rootConversationId: "root-session",
  };
  const child = routeNativeConversationEvent(
    childActivity("child-a", "item_1", "pnpm test", "1"),
    bound,
    "r",
  );
  expect(child.scope).toBe("child");
  expect(shouldApplyRootSessionIdentity(child)).toBe(false);
  expect(child.applyRootModel).toBe(false);
  expect(child.applyRootQuota).toBe(false);
  const root = routeRawTelemetryEvent(
    { type: "thread.started", thread_id: "root-session" },
    {},
    "r",
  );
  expect(root.scope).toBe("root");
  expect(shouldApplyRootSessionIdentity(root)).toBe(true);
});

it("无结构子字段的历史事件只进入根活动，不从自然语言重建树", () => {
  const s = fixture();
  try {
    s.telemetry.accept({ type: "thread.started", thread_id: "root-session" });
    s.telemetry.accept({
      type: "item.completed",
      item: {
        id: "msg",
        type: "agent_message",
        text: "我启动了 3 个 Agent 分别处理接口、测试和复核",
      },
    });
    s.telemetry.flush();
    const events = s.store.events("w", 0, 1000);
    expect(events.filter((e) => e.type === "ConversationActivity")).toHaveLength(
      0,
    );
    const logs = readableLogs(events, "w");
    expect(logs.some((row) => row.text.includes("我启动了 3 个 Agent"))).toBe(
      true,
    );
    expect(conversationLogs(events, "child-a")).toHaveLength(0);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("同一 Run 多个子会话复用 item ID 时互不覆盖，且不更新 root 的 model/quota", () => {
  const s = fixture();
  try {
    s.telemetry.accept({ type: "thread.started", thread_id: "root-session" });
    s.telemetry.accept({
      type: "item.started",
      item: { id: "item_1", type: "command_execution", command: "root-cmd" },
    });
    s.telemetry.metadata({
      actual_model: "root-model",
      model_source: "native_event",
    });
    s.telemetry.quota(
      { primary: { used_percent: 10, window_minutes: 60 } },
      new Date().toISOString(),
      "native_event",
    );
    s.telemetry.acceptConversationEvent(
      childActivity("child-a", "item_1", "child-a-cmd", "1"),
    );
    s.telemetry.acceptConversationEvent(
      childActivity("child-b", "item_1", "child-b-cmd", "2"),
    );
    s.telemetry.acceptConversationEvent({
      source_id: "fixture",
      source_seq: "3",
      root_native_id: "root-session",
      session_native_id: "child-a",
      parent_native_id: "root-session",
      kind: "model",
      payload: { model: "child-model" },
    });
    s.telemetry.acceptConversationEvent({
      source_id: "fixture",
      source_seq: "4",
      root_native_id: "root-session",
      session_native_id: "child-a",
      parent_native_id: "root-session",
      kind: "quota",
      payload: { primary: { used_percent: 99, window_minutes: 60 } },
      occurred_at: new Date().toISOString(),
    });
    s.telemetry.flush();
    expect(s.telemetry.observation.conversation_id).toBe("root-session");
    expect(s.telemetry.observation.actual_model).toBe("root-model");
    expect(s.telemetry.observation.quota?.buckets[0]?.windows[0]?.used_percent).toBe(
      10,
    );
    const events = s.store.events("w", 0, 1000);
    const childEvents = events.filter((e) => e.type === "ConversationActivity");
    expect(childEvents).toHaveLength(2);
    const keys = childEvents.map((e) =>
      conversationActivityKey(
        (e.payload as any).conversation_id,
        (e.payload as any).attempt_id,
        (e.payload as any).activity_id,
      ),
    );
    expect(keys).toEqual([
      conversationActivityKey("child-a", "r", "item_1"),
      conversationActivityKey("child-b", "r", "item_1"),
    ]);
    expect(conversationLogs(events, "child-a")[0]).toMatchObject({
      text: "child-a-cmd",
      command: "child-a-cmd",
    });
    expect(conversationLogs(events, "child-b")[0]).toMatchObject({
      text: "child-b-cmd",
    });
    const main = readableLogs(events, "w");
    expect(main.some((row) => row.command === "root-cmd")).toBe(true);
    expect(main.some((row) => row.command === "child-a-cmd")).toBe(false);
    expect(main.some((row) => row.command === "child-b-cmd")).toBe(false);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("finish 只结束根活动，不把后代标成 interrupted", () => {
  const s = fixture();
  try {
    s.telemetry.accept({ type: "thread.started", thread_id: "root-session" });
    s.telemetry.accept({
      type: "item.started",
      item: { id: "root-tool", type: "command_execution", command: "root-cmd" },
    });
    s.telemetry.acceptConversationEvent(
      childActivity("child-a", "item_1", "child-cmd", "1"),
    );
    s.telemetry.finish();
    const events = s.store.events("w", 0, 1000);
    const rootLog = readableLogs(events, "w").find(
      (row) => row.command === "root-cmd",
    );
    expect(rootLog?.status).toBe("interrupted");
    expect(conversationLogs(events, "child-a")[0]?.status).toBe("active");
    expect(
      (events.find((e) => e.type === "ConversationActivity")?.payload as any)
        .status,
    ).toBe("running");
  } finally {
    s.store.close();
  }
});

it("agy 子 step 与根 step 共用 index 时不覆盖，且 aside 不进主日志", () => {
  const s = fixture("planner_takeover", "agy");
  try {
    s.telemetry.accept({
      event: "init",
      init: { model: "root-agy" },
      conversation_id: "root-agy",
    });
    s.telemetry.accept({
      event: "step_update",
      conversation_id: "root-agy",
      step_update: {
        conversation_id: "root-agy",
        step_index: 1,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "root-agy-cmd" } },
      },
    });
    s.telemetry.accept({
      event: "step_update",
      conversation_id: "root-agy",
      step_update: {
        conversation_id: "child-agy",
        step_index: 1,
        step_type: "tool",
        state: "ACTIVE",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "child-agy-cmd" } },
      },
    });
    s.telemetry.flush();
    expect(s.telemetry.observation.actual_model).toBe("root-agy");
    expect(s.telemetry.observation.conversation_id).toBe("root-agy");
    const events = s.store.events("w", 0, 1000);
    expect(conversationLogs(events, "child-agy")[0]?.command).toBe(
      "child-agy-cmd",
    );
    expect(
      readableLogs(events, "w").some((row) => row.command === "child-agy-cmd"),
    ).toBe(false);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("aside 活动仍隔离，ConversationActivity 也不进入主日志", () => {
  const s = fixture("aside");
  try {
    s.telemetry.accept({ type: "thread.started", thread_id: "aside-session" });
    s.telemetry.acceptConversationEvent(
      childActivity("aside-child", "item_1", "aside-cmd", "1"),
    );
    s.telemetry.flush();
    const events = s.store.events("w", 0, 1000);
    expect(events.filter((e) => e.type === "NativeActivity")).toHaveLength(0);
    expect(events.filter((e) => e.type === "ConversationActivity")).toHaveLength(
      0,
    );
    expect(events.filter((e) => e.type === "RunObserved")).toHaveLength(0);
    expect(readableLogs(events, "w")).toHaveLength(0);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("无法区分根子时保持旧根行为并记录 adapter 缺口", () => {
  const s = fixture();
  try {
    s.telemetry.accept({ type: "thread.started", thread_id: "root-session" });
    s.telemetry.accept({
      type: "item.started",
      session_id: "mystery-session",
      item: { id: "item_1", type: "command_execution", command: "mystery" },
    });
    s.telemetry.flush();
    expect(s.telemetry.identityGaps[0]?.reason).toBe(
      "undifferentiated_session",
    );
    expect(s.telemetry.observation.conversation_id).toBe("mystery-session");
    expect(
      readableLogs(s.store.events("w", 0, 1000), "w").some(
        (row) => row.command === "mystery",
      ),
    ).toBe(true);
    const gapRoute = routeRawTelemetryEvent(
      { type: "item.started", session_id: "mystery-session" },
      { nativeRootId: "root-session" },
      "r",
    );
    expect(gapRoute.scope).toBe("root");
    expect(gapRoute.identityGap).toBe("undifferentiated_session");
    expect(shouldApplyRootSessionIdentity(gapRoute)).toBe(true);
  } finally {
    s.telemetry.finish();
    s.store.close();
  }
});

it("ConversationActivity 映射为现有 LogEntry，并按 conversation_id 分页隔离", () => {
  const mapped = conversationActivityLogEntry({
    event_seq: 9,
    created_at: "2026-09-20T00:00:00.000Z",
    payload: {
      conversation_id: "child-a",
      attempt_id: "attempt-1",
      root_id: "root-session",
      activity_id: "item_1",
      source_event_id: "fixture:1",
      public_text: "child-cmd",
      title: "执行命令",
      status: "running",
      kind: "tool",
      command: "child-cmd",
    },
  });
  expect(mapped).toMatchObject({
    key: conversationActivityKey("child-a", "attempt-1", "item_1"),
    kind: "tool",
    status: "active",
    command: "child-cmd",
    sequence: 9,
  });
});
