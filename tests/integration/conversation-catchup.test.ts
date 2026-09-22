import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup } from "../helpers.js";
import {
  type Run,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { NativeConversationEvent } from "../../packages/adapters/sdk/src/interface.js";
import {
  ConversationService,
  type ConversationApplyContext,
} from "../../packages/core/src/conversation-service.js";
import { ConversationObserver } from "../../packages/runtime/src/conversation-observer.js";
import { conversationPlugin } from "../../apps/api/src/routes/conversations.js";
import { consoleHumanGuard } from "../../apps/api/src/routes/conversation-files.js";
import { now } from "../../packages/core/src/util.js";
import {
  applyCatchupPage,
  catchupRound,
  type CatchupCursor,
  type CatchupEvent,
} from "../../apps/web/src/event-catchup.js";

const NODE_COUNT = 20;
const ACTIVITIES_PER_NODE = 20;
const ACTIVITY_TOTAL = NODE_COUNT * ACTIVITIES_PER_NODE;

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

function putWorkflow(
  store: ReturnType<typeof setup>["store"],
  id: string,
  runId: string,
) {
  const workflow: Workflow = {
    id,
    project_id: "p1",
    title: id,
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 0,
    environment_revision: 0,
    run_id: runId,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  const run: Run = {
    id: runId,
    workflow_id: id,
    plan_revision: 0,
    adapter: "codex",
    purpose: "implement",
    stage: "exec",
    status: "running",
    started_at: "2026-09-20T00:00:00.000Z",
    package_hash: "pkg",
  };
  store.put("workflow", id, "p1", workflow);
  store.put("run", runId, id, run);
}

function ctx(
  extra: Partial<ConversationApplyContext> = {},
): ConversationApplyContext {
  return {
    project_id: "p1",
    workflow_id: extra.workflow_id ?? "wf1",
    run_id: extra.run_id ?? "run1",
    adapter_id: extra.adapter_id ?? "codex",
    scope: extra.scope ?? "profile-codex",
    lineage_id: extra.lineage_id ?? "lineage-implement",
    purpose: extra.purpose ?? "implement",
    root_native_id: extra.root_native_id ?? "root-0",
    ...extra,
  };
}

function event(
  extra: Partial<NativeConversationEvent> & { payload?: Record<string, unknown> },
): NativeConversationEvent {
  return {
    source_id: extra.source_id ?? "src-1",
    source_seq: extra.source_seq ?? "1",
    root_native_id: extra.root_native_id ?? "root-0",
    session_native_id: extra.session_native_id,
    agent_native_id: extra.agent_native_id,
    parent_native_id: extra.parent_native_id,
    kind: extra.kind ?? "discovered",
    payload: extra.payload ?? {},
  };
}

async function startApp() {
  const s = setup();
  putWorkflow(s.store, "wf1", "run1");
  putWorkflow(s.store, "wf-old", "run-old");
  const conversations = new ConversationService(s.store);
  const app = Fastify({ logger: false });
  await app.register(conversationPlugin, {
    conversations,
    store: s.store,
    human: consoleHumanGuard,
  });
  app.get("/api/workflows/:id/history", async (req) => {
    const key = (req.params as { id: string }).id;
    const query = (req.query || {}) as { before?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 100) || 100));
    const before = query.before ? Number(query.before) : Number.MAX_SAFE_INTEGER;
    const rows = s.store.db
      .prepare(
        "SELECT data FROM events WHERE workflow_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
      )
      .all(key, before, limit) as { data: string }[];
    const events = rows.reverse().map((row) => JSON.parse(row.data));
    return {
      events,
      next_before: events.length === limit ? events[0]!.event_seq : null,
    };
  });
  await app.ready();
  opened.push({ app, store: s.store });
  return { s, app, conversations };
}

function seedTree(conversations: ConversationService) {
  conversations.applyEvent(
    ctx(),
    event({
      session_native_id: "root-0",
      payload: { title: "主会话", status: "running" },
    }),
  );
  let seq = 2;
  for (let i = 1; i < NODE_COUNT; i++) {
    conversations.applyEvent(
      ctx(),
      event({
        source_seq: String(seq++),
        session_native_id: `child-${i}`,
        parent_native_id: "root-0",
        payload: { title: `子 ${i}`, status: "running" },
      }),
    );
  }
  for (let i = 0; i < NODE_COUNT; i++) {
    const native = i === 0 ? "root-0" : `child-${i}`;
    const parent = i === 0 ? undefined : "root-0";
    for (let j = 0; j < ACTIVITIES_PER_NODE; j++) {
      conversations.applyEvent(
        ctx(),
        event({
          kind: "activity",
          source_seq: String(seq++),
          session_native_id: native,
          parent_native_id: parent,
          payload: {
            activity_id: `a-${i}-${j}`,
            public_text: `n${i}-s${j}`,
            kind: "message",
          },
        }),
      );
    }
  }
  return seq;
}

describe("SA-I21 catchup race, dedup and page budget (20 nodes / 400 activities)", () => {
  it("applies snapshot, websocket and catchup events only once", async () => {
    const { app, conversations, s } = await startApp();
    seedTree(conversations);
    const tree = await app.inject({
      method: "GET",
      url: "/api/workflows/wf1/conversations",
    });
    expect(tree.statusCode).toBe(200);
    expect(tree.json().nodes).toHaveLength(NODE_COUNT);
    expect(tree.json().cursor).toBe(s.store.eventCursor("wf1"));
    const live: CatchupEvent[] = [];
    const unsubscribe = (event: { workflow_id?: string; event_seq: number }) => {
      live.push({ workflow_id: event.workflow_id, event_seq: event.event_seq });
    };
    s.store.on("event", unsubscribe);
    conversations.applyEvent(
      ctx(),
      event({
        kind: "activity",
        source_seq: "9999",
        session_native_id: "root-0",
        payload: { activity_id: "live-dup", public_text: "ws" },
      }),
    );
    conversations.applyEvent(
      ctx({ workflow_id: "wf-old", run_id: "run-old", scope: "old" }),
      event({
        source_id: "src-old",
        session_native_id: "old-root",
        payload: { title: "迟到旧任务", status: "running" },
      }),
    );
    const received: CatchupEvent[] = [];
    const cursor = await catchupRound({
      cursor: { watermark: 0 },
      workflow: "wf1",
      read: async (path) => {
        const url = path.startsWith("/api/") ? path : `/api${path}`;
        const res = await app.inject({ method: "GET", url });
        return res.json();
      },
      receive: (events) => received.push(...events),
      isStopped: () => false,
      pageLimit: 20,
      eventLimit: 4000,
    });
    s.store.off("event", unsubscribe);
    const keys = new Set(
      [...received, ...live.filter((item) => item.workflow_id === "wf1")].map(
        (item) => `${item.workflow_id}:${item.event_seq}`,
      ),
    );
    expect(keys.size).toBeGreaterThan(ACTIVITY_TOTAL);
    expect(received.some((item) => item.workflow_id === "wf-old")).toBe(false);
    const lateLive = applyCatchupPage(
      { watermark: 0 },
      { events: live.filter((item) => item.workflow_id === "wf-old") },
      "wf1",
    );
    expect(lateLive.deliver).toEqual([]);
    expect(cursor.watermark).toBe(s.store.eventCursor("wf1"));
    const root = tree.json().nodes.find((node: { kind: string }) => node.kind === "main");
    const page = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?limit=100`,
    });
    expect(page.json().items.length).toBeLessThanOrEqual(100);
    const again = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?limit=100`,
    });
    expect(again.json().items.map((item: { key: string }) => item.key)).toEqual(
      page.json().items.map((item: { key: string }) => item.key),
    );
    conversations.applyEvent(
      ctx(),
      event({
        kind: "activity",
        source_seq: "9999",
        session_native_id: "root-0",
        payload: { activity_id: "live-dup", public_text: "ws" },
      }),
    );
    const afterDup = await app.inject({
      method: "GET",
      url: `/api/workflows/wf1/conversations/${root.id}/activities?limit=100`,
    });
    const dupKeys = afterDup
      .json()
      .items.filter((item: { text: string }) => item.text === "ws")
      .map((item: { key: string }) => item.key);
    expect(new Set(dupKeys).size).toBe(dupKeys.length);
  });

  it("continues a budget-limited catchup without duplicating pages", async () => {
    const { app, conversations } = await startApp();
    seedTree(conversations);
    const first = await catchupRound({
      cursor: { watermark: 0 },
      workflow: "wf1",
      read: async (path) => {
        const url = path.startsWith("/api/") ? path : `/api${path}`;
        return (await app.inject({ method: "GET", url })).json();
      },
      receive: () => {},
      isStopped: () => false,
      pageLimit: 2,
      eventLimit: 4000,
    });
    expect(first.before).toBeTruthy();
    const secondReads: string[] = [];
    const second = await catchupRound({
      cursor: first,
      workflow: "wf1",
      read: async (path) => {
        secondReads.push(path);
        const url = path.startsWith("/api/") ? path : `/api${path}`;
        return (await app.inject({ method: "GET", url })).json();
      },
      receive: () => {},
      isStopped: () => false,
      pageLimit: 20,
      eventLimit: 4000,
    });
    expect(secondReads[0]).toContain(`before=${first.before}`);
    expect(secondReads.some((path) => !path.includes("before="))).toBe(false);
    expect(second.watermark).toBeGreaterThan(0);
    const late = applyCatchupPage(
      { watermark: second.watermark },
      { events: [{ workflow_id: "wf-old", event_seq: 1 }] },
      "wf1",
    );
    expect(late.deliver).toEqual([]);
  });

  it("releases the observer after a terminal tree with no working descendants", async () => {
    const { s, conversations } = await startApp();
    const dir = join(s.root, "obs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        kind: "discovered",
        source_id: "file-1",
        source_seq: "0",
        root_native_id: "root-0",
        session_native_id: "root-0",
        payload: { title: "主会话", status: "completed" },
      }) + "\n",
    );
    const observer = new ConversationObserver({
      service: conversations,
      context: ctx(),
      pollIntervalMs: 50,
    });
    observer.addSource({
      source_id: "file-1",
      adapter_id: "codex",
      file_path: file,
      trusted_root: dir,
    });
    await observer.poll();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const countBefore = conversations.listActivities(
      "wf1",
      conversations.getTree("wf1").active_root_id!,
    ).items.length;
    writeFileSync(
      file,
      JSON.stringify({
        kind: "activity",
        source_id: "file-1",
        source_seq: "1",
        root_native_id: "root-0",
        session_native_id: "root-0",
        payload: { activity_id: "after-stop", public_text: "should-not-apply" },
      }) + "\n",
      { flag: "a" },
    );
    await observer.poll();
    const tree = conversations.getTree("wf1");
    const attempt = tree.attempts.at(-1);
    expect(attempt?.status).toBe("completed");
    expect(
      conversations.listActivities("wf1", tree.active_root_id!).items.length,
    ).toBe(countBefore);
    await observer.stop();
  });
});
