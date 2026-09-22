import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { setup, prepared } from "../helpers.js";
import { Store } from "../../packages/store/src/store.js";
import { runMigrations } from "../../packages/store/src/migrations/index.js";
import {
  CONVERSATION_ENTITY,
  FlowError,
  type Run,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { ConversationService } from "../../packages/core/src/conversation-service.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import { ProjectAsideHistory } from "../../packages/asides/src/project-history.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import {
  requestOperation,
  decideOperation,
  type OperationRequest,
} from "../../packages/core/src/interactions.js";
import { resumeApproved } from "../../packages/runtime/src/recovery.js";
import type { AsideSession } from "../../packages/contracts/src/feedback.js";

const opened: Array<{ close: () => Promise<void> | void }> = [];

afterEach(async () => {
  for (const item of opened.splice(0)) await item.close();
});

function putLegacyWorkflow(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS entities_owner ON entities(kind,owner);
    CREATE TABLE IF NOT EXISTS events(workflow_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workflow_id,seq));
    CREATE TABLE IF NOT EXISTS dedup(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,data TEXT NOT NULL);
  `);
  db.pragma("user_version = 1");
  const workflow = {
    id: "wf-old",
    project_id: "p1",
    title: "旧任务",
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "COMPLETED",
    stage: "exec",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    run_id: "run-old",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T01:00:00.000Z",
    feedback: ["旧反馈"],
  };
  const run = {
    id: "run-old",
    workflow_id: "wf-old",
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    stage: "exec",
    status: "completed",
    conversation_id: "native-old",
    started_at: "2026-09-01T00:00:00.000Z",
    ended_at: "2026-09-01T01:00:00.000Z",
    package_hash: "pkg",
  };
  const insert = db.prepare(
    "INSERT INTO entities(kind,id,owner,data) VALUES(?,?,?,?)",
  );
  insert.run("workflow", "wf-old", "p1", JSON.stringify(workflow));
  insert.run("run", "run-old", "wf-old", JSON.stringify(run));
  insert.run(
    "aside_session",
    "aside_legacy",
    "wf-old",
    JSON.stringify({
      id: "aside_legacy",
      workflow_id: "wf-old",
      profile_revision: "1",
      context_ref: "workflow:wf-old:context",
      question: "历史提问",
      refs: [],
      attachment_ids: [],
      status: "completed",
      answer: "历史答案",
      created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-12-31T00:00:00.000Z",
      completed_at: "2026-09-01T00:10:00.000Z",
    }),
  );
  db.prepare("INSERT INTO events VALUES(?,?,?)").run(
    "wf-old",
    1,
    JSON.stringify({
      workflow_id: "wf-old",
      project_id: "p1",
      event_seq: 1,
      type: "NativeActivity",
      payload: { text: "旧活动", conversation: "native-old" },
      created_at: "2026-09-01T00:00:01.000Z",
      run_id: "run-old",
    }),
  );
}

describe("SA-I22 old sqlite, events and runs remain readable", () => {
  it("reads old rows after index init and aside backfill without changing them", () => {
    const s = setup();
    opened.push({ close: () => s.store.close() });
    const file = join(s.root, "legacy", "devflow.sqlite");
    mkdirSync(join(s.root, "legacy"), { recursive: true });
    const raw = new Database(file);
    putLegacyWorkflow(raw);
    raw.close();
    const store = new Store(file);
    opened.push({ close: () => store.close() });
    const workflow = store.get<Workflow>("workflow", "wf-old");
    const run = store.get<Run>("run", "run-old");
    expect(workflow?.title).toBe("旧任务");
    expect(workflow?.feedback).toEqual(["旧反馈"]);
    expect(run?.conversation_id).toBe("native-old");
    expect((run as { child_agents?: unknown }).child_agents).toBeUndefined();
    const conversations = new ConversationService(store);
    const tree = conversations.getTree("wf-old");
    expect(tree.nodes).toHaveLength(1);
    expect(tree.nodes[0]?.kind).toBe("main");
    expect(tree.nodes.filter((node) => node.kind === "subagent")).toHaveLength(0);
    expect(tree.capabilities.reason).toBe("历史未记录子会话");
    const oldEvent = store.events("wf-old")[0];
    expect(oldEvent?.type).toBe("NativeActivity");
    const beforeAside = store.get<AsideSession>("aside_session", "aside_legacy");
    runMigrations(store.db);
    runMigrations(store.db);
    const history = new ProjectAsideHistory(store);
    history.backfillProject("p1");
    expect(store.get<Workflow>("workflow", "wf-old")).toEqual(workflow);
    expect(store.get<Run>("run", "run-old")).toEqual(run);
    expect(store.get<AsideSession>("aside_session", "aside_legacy")).toEqual(
      beforeAside,
    );
    expect(store.events("wf-old")[0]).toEqual(oldEvent);
    expect(
      store.get(CONVERSATION_ENTITY.projectAsideIndex, "aside_legacy"),
    ).toMatchObject({
      id: "aside_legacy",
      question_preview: "历史提问",
      status: "completed",
    });
  });
});

describe("SA-I23 original feedback, stop, recover, asides and auth entries", () => {
  it("keeps original feedback, aside, stop and recover results", async () => {
    const s = await prepared();
    opened.push({ close: () => s.store.close() });
    const feedback = new FeedbackService(s.store);
    const first = feedback.submitFeedback({
      request_id: "fb-keep",
      workflow_id: s.workflow.id,
      kind: "execution",
      text: "原反馈入口",
    });
    const again = feedback.submitFeedback({
      request_id: "fb-keep",
      workflow_id: s.workflow.id,
      kind: "execution",
      text: "原反馈入口",
    });
    expect(again.message_id).toBe(first.message_id);
    const asides = new AsideSessionService(s.store);
    const question = asides.submitQuestion(s.workflow.id, "只读提问仍走原入口");
    expect(question.status).toBe("active");
    await s.engine.stop(s.workflow.id, "local_console");
    expect(s.engine.get(s.workflow.id).state).toBe("STOPPED");
    const recovered = resumeApproved(s.engine, s.workflow.id);
    expect(recovered.state).toBe("QUEUED");
  });

  it("requires an explicit authorization decision and ignores recover or messages", async () => {
    const s = await prepared();
    opened.push({ close: () => s.store.close() });
    const requested = requestOperation(s.engine, s.principal, s.workflow.id, {
      repo_id: "main",
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      reason: "需要用户确认后才能执行该命令",
    });
    expect(requested.status).toBe("pending");
    expect(s.engine.get(s.workflow.id).state).toBe("WAITING_AUTHORIZATION");
    const feedback = new FeedbackService(s.store);
    feedback.submitFeedback({
      request_id: "msg-bypass",
      workflow_id: s.workflow.id,
      kind: "execution",
      text: "同意执行",
    });
    const pending = s.store.get<OperationRequest>(
      "operation_request",
      requested.id,
    );
    expect(pending?.status).toBe("pending");
    expect(() => resumeApproved(s.engine, s.workflow.id)).toThrowError(FlowError);
    try {
      resumeApproved(s.engine, s.workflow.id);
    } catch (error) {
      expect(error).toMatchObject({ code: "AUTHORIZATION_PENDING" });
    }
    const decided = decideOperation(
      s.engine,
      s.workflow.id,
      requested.id,
      true,
      requested.fingerprint,
      "人工批准",
    );
    expect(decided.status).toBe("approved");
  });
});
