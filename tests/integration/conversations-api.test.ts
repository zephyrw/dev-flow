import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { setup } from "../helpers.js";
import {
  CONVERSATION_ERROR,
  type Run,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import { now } from "../../packages/core/src/util.js";
import {
  conversationPlugin,
} from "../../apps/api/src/routes/conversations.js";
import { consoleHumanGuard } from "../../apps/api/src/routes/conversation-files.js";

const opened: Array<{
  app: Awaited<ReturnType<typeof Fastify>>;
  store: ReturnType<typeof setup>["store"];
}> = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.app.close();
    item.store.close();
  }
});

function workflow(id: string, runId?: string): Workflow {
  return {
    id,
    project_id: "p1",
    title: id === "wf-old" ? "旧任务" : "会话查询",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "new_worktree",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 0,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
    run_id: runId,
  };
}

function runRecord(id: string, workflowId: string, extra: Partial<Run> = {}): Run {
  return {
    id,
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: extra.adapter ?? "codex",
    purpose: extra.purpose ?? "implement",
    stage: extra.stage ?? "execute",
    status: extra.status ?? "running",
    conversation_id: extra.conversation_id,
    started_at: extra.started_at ?? "2026-09-20T00:00:00.000Z",
    ended_at: extra.ended_at,
    package_hash: "pkg",
    result: extra.result,
  };
}

function ctx(
  extra: Partial<ConversationApplyContext> = {},
): ConversationApplyContext {
  return {
    project_id: "p1",
    workflow_id: "wf1",
    run_id: "run1",
    adapter_id: "codex",
    scope: "profile-codex",
    lineage_id: "lineage-implement",
    purpose: "implement",
    root_native_id: "root-native",
    ...extra,
  };
}

function event(
  extra: Partial<NativeConversationEvent> & {
    payload?: Record<string, unknown>;
  },
): NativeConversationEvent {
  return {
    source_id: extra.source_id ?? "src-1",
    source_seq: extra.source_seq ?? "1",
    root_native_id: extra.root_native_id ?? "root-native",
    session_native_id: extra.session_native_id,
    agent_native_id: extra.agent_native_id,
    parent_native_id: extra.parent_native_id,
    kind: extra.kind ?? "discovered",
    occurred_at: extra.occurred_at,
    payload: extra.payload ?? {},
  };
}

async function startApp(
  prepare?: (service: ConversationService, store: ReturnType<typeof setup>["store"]) => void,
) {
  const s = setup();
  s.store.put("workflow", "wf1", "p1", workflow("wf1", "run1"));
  s.store.put("workflow", "wf2", "p1", workflow("wf2", "run2"));
  s.store.put("run", "run1", "wf1", runRecord("run1", "wf1"));
  s.store.put("run", "run2", "wf2", runRecord("run2", "wf2"));
  const conversations = new ConversationService(s.store);
  prepare?.(conversations, s.store);
  const app = Fastify({ logger: false });
  await app.register(conversationPlugin, {
    conversations,
    store: s.store,
    human: consoleHumanGuard,
  });
  await app.ready();
  opened.push({ app, store: s.store });
  return { s, app, conversations };
}

function seedTree(service: ConversationService) {
  const base = ctx();
  const root = service.applyEvent(
    base,
    event({
      session_native_id: "root-native",
      payload: { title: "主会话", status: "running" },
    }),
  ).node!;
  const child = service.applyEvent(
    base,
    event({
      source_seq: "2",
      session_native_id: "child-native",
      parent_native_id: "root-native",
      payload: {
        title: "子 Agent",
        task_summary: "核对接口",
        status: "running",
      },
    }),
  ).node!;
  const grandchild = service.applyEvent(
    base,
    event({
      source_seq: "3",
      session_native_id: "grand-native",
      parent_native_id: "child-native",
      payload: { title: "更深一层", status: "waiting" },
    }),
  ).node!;
  return { root, child, grandchild };
}

describe("SA-I05 conversation query API", () => {
  it("returns current tree, historical root summaries, capabilities and cursor", async () => {
    const { app, s } = await startApp((service) => {
      const oldRoot = service.applyEvent(
        ctx(),
        event({
          session_native_id: "root-native",
          payload: { title: "上一轮主会话", status: "completed" },
        }),
      ).node!;
      const next = ctx({
        run_id: "run-new",
        root_native_id: "root-native-2",
        lineage_id: "lineage-new",
      });
      service.applyEvent(
        next,
        event({
          source_id: "src-new",
          source_seq: "1",
          root_native_id: "root-native-2",
          session_native_id: "root-native-2",
          payload: {
            title: "当前主会话",
            status: "running",
            replaces_conversation_id: oldRoot.id,
          },
        }),
      );
      service.applyEvent(
        next,
        event({
          source_id: "src-new",
          source_seq: "2",
          root_native_id: "root-native-2",
          session_native_id: "child-now",
          parent_native_id: "root-native-2",
          payload: { title: "当前子 Agent", status: "running" },
        }),
      );
      service.setCapabilities("wf1", {
        discovery: "native",
        activity: "native",
        stop: "native",
        resume: "parent-instruction",
        readonly_delegation: "verified",
        file_input: { text: true, image: true, binary: false },
      });
    });
    s.store.put(
      "run",
      "run-new",
      "wf1",
      runRecord("run-new", "wf1", { status: "running" }),
    );
    const listed = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversations",
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.roots.length).toBe(2);
    expect(body.roots.map((item: { title: string }) => item.title)).toEqual(
      expect.arrayContaining(["上一轮主会话", "当前主会话"]),
    );
    expect(body.nodes.every((node: { kind: string }) => node.kind !== undefined)).toBe(
      true,
    );
    expect(body.nodes.some((node: { title: string }) => node.title === "当前子 Agent")).toBe(
      true,
    );
    expect(
      body.nodes.some((node: { title: string }) => node.title === "上一轮主会话"),
    ).toBe(false);
    expect(body.active_root_id).toBeTruthy();
    expect(body.capabilities.discovery).toBe("native");
    expect(body.cursor).toBe(s.store.eventCursor("wf1"));
    const previous = body.roots.find(
      (item: { title: string }) => item.title === "上一轮主会话",
    );
    const historical = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations?root_id=${previous.id}`,
    });
    expect(historical.statusCode).toBe(200);
    expect(
      historical
        .json()
        .nodes.some((node: { title: string }) => node.title === "上一轮主会话"),
    ).toBe(true);
    expect(
      historical
        .json()
        .nodes.some((node: { title: string }) => node.title === "当前子 Agent"),
    ).toBe(false);
    expect(s.store.list<Run>("run").map((item) => item.id).sort()).toEqual(
      ["run-new", "run1", "run2"].sort(),
    );
  });

  it("shows legacy root without inventing child agents", async () => {
    const { app, s } = await startApp((_, store) => {
      store.put("workflow", "wf-old", "p1", workflow("wf-old", "run-old"));
      store.put(
        "run",
        "run-old",
        "wf-old",
        runRecord("run-old", "wf-old", {
          adapter: "agy",
          status: "completed",
          conversation_id: "native-old",
          started_at: "2026-09-01T00:00:00.000Z",
          ended_at: "2026-09-01T01:00:00.000Z",
        }),
      );
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/workflows/wf-old/conversations",
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].kind).toBe("main");
    expect(body.nodes.filter((node: { kind: string }) => node.kind === "subagent")).toHaveLength(
      0,
    );
    expect(body.capabilities.reason).toBe("历史未记录子会话");
    const detail = await app.inject({
      method: "GET",
      url: `/api/workflows/wf-old/conversations/${body.nodes[0].id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().attempts).toHaveLength(1);
    const activities = await app.inject({
      method: "GET",
      url: `/api/workflows/wf-old/conversations/${body.nodes[0].id}/activities`,
    });
    expect(activities.statusCode).toBe(200);
    expect(activities.json()).toMatchObject({ items: [], has_more: false });
    expect(s.store.list<Run>("run").some((item) => item.id === "run-old")).toBe(true);
  });

  it("returns node ancestors, attempts and public run fields", async () => {
    const { app } = await startApp((service) => {
      seedTree(service);
    });
    const tree = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversations",
    });
    const child = tree
      .json()
      .nodes.find((node: { title: string }) => node.title === "子 Agent");
    const grand = tree
      .json()
      .nodes.find((node: { title: string }) => node.title === "更深一层");
    expect(child).toBeTruthy();
    const detail = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${grand.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.node.title).toBe("更深一层");
    expect(body.ancestors.map((item: { title: string }) => item.title)).toEqual([
      "子 Agent",
      "主会话",
    ]);
    expect(body.attempts.length).toBeGreaterThan(0);
    expect(body.run).toMatchObject({
      id: "run1",
      workflow_id: "wf1",
      adapter: "codex",
      purpose: "implement",
      status: "running",
    });
    expect(body.run.result).toBeUndefined();
    expect(body.attempts[0].source_cursor).toBeUndefined();
    expect(body.runtime.model_label).toBeTruthy();
  });

  it("rejects a node that belongs to another workflow", async () => {
    let foreignId = "";
    const { app } = await startApp((service) => {
      seedTree(service);
      foreignId = service.applyEvent(
        ctx({ workflow_id: "wf2", run_id: "run2", scope: "profile-wf2" }),
        event({
          source_id: "src-wf2",
          session_native_id: "root-native",
          payload: { title: "其他任务主会话", status: "running" },
        }),
      ).node!.id;
    });
    const rejected = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${foreignId}`,
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe(
      CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
    );
    const activities = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${foreignId}/activities`,
    });
    expect(activities.statusCode).toBe(409);
    expect(activities.json().error.code).toBe(
      CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
    );
    const scoped = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations?root_id=${foreignId}`,
    });
    expect(scoped.statusCode).toBe(409);
    expect(scoped.json().error.code).toBe(
      CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
    );
  });

  it("pages activities by before_seq without duplicating the same cursor", async () => {
    const { app } = await startApp((service) => {
      const root = seedTree(service).root;
      for (let i = 0; i < 3; i++) {
        service.applyEvent(
          ctx(),
          event({
            kind: "activity",
            source_seq: String(10 + i),
            session_native_id: "root-native",
            payload: {
              activity_id: `a${i}`,
              public_text: `root-${i}`,
              kind: "message",
            },
          }),
        );
      }
      service.applyEvent(
        ctx(),
        event({
          kind: "activity",
          source_seq: "21",
          session_native_id: "child-native",
          parent_native_id: "root-native",
          payload: {
            activity_id: "child-a",
            public_text: "child-only",
            kind: "tool",
          },
        }),
      );
      return root;
    });
    const tree = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversations",
    });
    const root = tree.json().nodes.find((node: { kind: string }) => node.kind === "main");
    const child = tree
      .json()
      .nodes.find((node: { title: string }) => node.title === "子 Agent");
    const first = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?limit=2`,
    });
    expect(first.statusCode).toBe(200);
    const page = first.json();
    expect(page.items).toHaveLength(2);
    expect(page.has_more).toBe(true);
    expect(page.next_before_seq).toEqual(expect.any(Number));
    expect(
      page.items.every(
        (item: { conversation_id: string }) => item.conversation_id === root.id,
      ),
    ).toBe(true);
    const again = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?limit=2`,
    });
    expect(again.json().items.map((item: { key: string }) => item.key)).toEqual(
      page.items.map((item: { key: string }) => item.key),
    );
    const older = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?limit=2&before_seq=${page.next_before_seq}`,
    });
    expect(older.statusCode).toBe(200);
    const olderKeys = older.json().items.map((item: { key: string }) => item.key);
    const firstKeys = page.items.map((item: { key: string }) => item.key);
    expect(older.json().has_more).toBe(false);
    expect(olderKeys.some((key: string) => firstKeys.includes(key))).toBe(false);
    const childPage = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${child.id}/activities`,
    });
    expect(childPage.json().items).toHaveLength(1);
    expect(childPage.json().items[0].text).toBe("child-only");
    const invalid = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?before_seq=abc`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe(CONVERSATION_ERROR.INVALID_CURSOR);
    const missing = await app.inject({
      method: "GET",
      url: "/api/workflows/missing/conversations",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe(CONVERSATION_ERROR.NOT_FOUND);
    const tokenDenied = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversations",
      headers: { authorization: "Bearer model-token" },
    });
    expect(tokenDenied.statusCode).toBe(403);
  });
});
