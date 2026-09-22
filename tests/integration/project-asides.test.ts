import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { setup } from "../helpers.js";
import {
  CONVERSATION_ERROR,
  FlowError,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import { ProjectAsideHistory } from "../../packages/asides/src/project-history.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { now } from "../../packages/core/src/util.js";
import { projectAsidesPlugin } from "../../apps/api/src/routes/project-asides.js";
import { consoleHumanGuard } from "../../apps/api/src/routes/conversation-files.js";
import type { AsideSession } from "../../packages/contracts/src/feedback.js";

const PROJECT_A = "proj_aside_a";
const PROJECT_B = "proj_aside_b";
const WF_A1 = "wf_aside_a1";
const WF_A2 = "wf_aside_a2";
const WF_B1 = "wf_aside_b1";

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
  projectId: string,
  title: string,
) {
  const workflow: Workflow = {
    id,
    project_id: projectId,
    title,
    request: "fixture",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: "exec",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  store.put("workflow", id, projectId, workflow);
}

function putLegacyAside(
  store: ReturnType<typeof setup>["store"],
  input: {
    id: string;
    workflow_id: string;
    question: string;
    created_at: string;
    status?: AsideSession["status"];
  },
) {
  const session: AsideSession = {
    id: input.id,
    workflow_id: input.workflow_id,
    profile_revision: "1",
    context_ref: `workflow:${input.workflow_id}:context`,
    question: input.question,
    refs: [],
    attachment_ids: [],
    status: input.status ?? "completed",
    created_at: input.created_at,
    expires_at: "2026-12-31T00:00:00.000Z",
    completed_at: "2026-09-20T00:00:00.000Z",
    answer: "done",
  };
  store.put("aside_session", session.id, session.workflow_id, session);
}

async function startApp() {
  const s = setup();
  putWorkflow(s.store, WF_A1, PROJECT_A, "任务 A1");
  putWorkflow(s.store, WF_A2, PROJECT_A, "任务 A2");
  putWorkflow(s.store, WF_B1, PROJECT_B, "任务 B1");
  const asides = new AsideSessionService(s.store);
  const history = new ProjectAsideHistory(s.store);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof FlowError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message },
      });
    }
    throw error;
  });
  await app.register(projectAsidesPlugin, {
    store: s.store,
    human: consoleHumanGuard,
  });
  await app.ready();
  opened.push({ app, store: s.store });
  return { s, app, asides, history };
}

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("SA-I19 project aside history across tasks", () => {
  it("pages more than 50 items from two tasks and hides another project", async () => {
    const { app, history, s } = await startApp();
    for (let i = 0; i < 30; i++) {
      putLegacyAside(s.store, {
        id: `aside_a1_${String(i).padStart(2, "0")}`,
        workflow_id: WF_A1,
        question: `A1 问题 ${i}`,
        created_at: `2026-09-20T10:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    for (let i = 0; i < 25; i++) {
      putLegacyAside(s.store, {
        id: `aside_a2_${String(i).padStart(2, "0")}`,
        workflow_id: WF_A2,
        question: `A2 问题 ${i}`,
        created_at: `2026-09-20T11:${String(i).padStart(2, "0")}:00.000Z`,
      });
    }
    putLegacyAside(s.store, {
      id: "aside_b_hidden",
      workflow_id: WF_B1,
      question: "项目 B 不可见",
      created_at: "2026-09-20T03:00:00.000Z",
    });
    history.backfillProject(PROJECT_A);
    history.backfillProject(PROJECT_B);
    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides?limit=50`,
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json();
    expect(page.total).toBe(55);
    expect(page.items).toHaveLength(50);
    expect(page.next_cursor).toBeTruthy();
    expect(page.items.some((item: { id: string }) => item.id === "aside_b_hidden")).toBe(
      false,
    );
    const older = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides?limit=50&before=${encodeURIComponent(page.next_cursor)}&snapshot_cursor=${page.snapshot_cursor}`,
    });
    expect(older.statusCode).toBe(200);
    expect(older.json().items).toHaveLength(5);
    const firstIds = page.items.map((item: { id: string }) => item.id);
    const olderIds = older.json().items.map((item: { id: string }) => item.id);
    expect(olderIds.some((id: string) => firstIds.includes(id))).toBe(false);
    const selected = page.items[0];
    const pos = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides/${selected.id}/position?snapshot_cursor=${page.snapshot_cursor}`,
    });
    expect(pos.statusCode).toBe(200);
    expect(pos.json()).toMatchObject({ index: 1, total: 55 });
    const hidden = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides/aside_b_hidden/position`,
    });
    expect(hidden.statusCode).toBeGreaterThanOrEqual(400);
    const other = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_B}/asides`,
    });
    expect(other.json().items.map((item: { id: string }) => item.id)).toEqual([
      "aside_b_hidden",
    ]);
    expect(other.json().items.some((item: { workflow_id: string }) => item.workflow_id === WF_A1)).toBe(
      false,
    );
  });

  it("keeps a snapshot stable after a new question", async () => {
    const { app, asides, history } = await startApp();
    asides.submitQuestion(WF_A1, "旧问题 1");
    await waitTick();
    asides.submitQuestion(WF_A2, "旧问题 2");
    const snapshot = history.listPage(PROJECT_A).snapshot_cursor;
    const frozen = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides?snapshot_cursor=${snapshot}`,
    });
    expect(frozen.json().total).toBe(2);
    await waitTick();
    asides.submitQuestion(WF_A1, "新问题");
    const stillFrozen = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides?snapshot_cursor=${snapshot}`,
    });
    expect(stillFrozen.json().total).toBe(2);
    expect(
      stillFrozen.json().items.some((item: { question_preview?: string }) =>
        String(item.question_preview ?? "").includes("新问题"),
      ),
    ).toBe(false);
    const latest = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides`,
    });
    expect(latest.json().total).toBe(3);
  });
});

describe("SA-I20 aside limits, races and feedback cursor", () => {
  it("enforces active+queued limits and keeps promote idempotent on the source task", async () => {
    const { asides, s } = await startApp();
    const first = asides.submitQuestion(WF_A1, "活跃");
    expect(first.status).toBe("active");
    const queued = [
      asides.submitQuestion(WF_A1, "排队 1"),
      asides.submitQuestion(WF_A1, "排队 2"),
      asides.submitQuestion(WF_A1, "排队 3"),
    ];
    expect(queued.every((item) => item.status === "queued")).toBe(true);
    expect(() => asides.submitQuestion(WF_A1, "超出")).toThrow(/上限/);
    const other = asides.submitQuestion(WF_A2, "其他任务排队");
    expect(other.status).toBe("queued");
    asides.completeSession(WF_A1, first.id, "答案");
    const promoted1 = asides.promoteToFormalFeedback(
      WF_A1,
      first.id,
      "转为正式反馈",
      1,
    );
    const promoted2 = asides.promoteToFormalFeedback(
      WF_A1,
      first.id,
      "转为正式反馈",
      1,
    );
    expect(promoted2.message_id).toBe(promoted1.message_id);
    expect(promoted1.workflow_id).toBe(WF_A1);
    const msgs = s.store.list<{ client_request_id: string }>(
      "feedback_message",
      WF_A1,
    );
    expect(
      msgs.filter((item) => item.client_request_id === `promoted_${first.id}`),
    ).toHaveLength(1);
    expect(s.store.list("feedback_message", WF_A2)).toHaveLength(0);
  });

  it("lets cancel win a complete race and does not move the main feedback cursor", async () => {
    const { asides, s } = await startApp();
    const feedback = new FeedbackService(s.store);
    feedback.submitFeedback({
      request_id: "fb-1",
      workflow_id: WF_A1,
      kind: "execution",
      text: "正式反馈",
    });
    const beforeSeq = Math.max(
      0,
      ...s.store.list<{ seq: number }>("feedback_message", WF_A1).map((item) => item.seq),
    );
    const beforeCursor = s.store.eventCursor(WF_A1);
    const session = asides.submitQuestion(WF_A1, "只读提问");
    await Promise.all([
      Promise.resolve(asides.cancelSession(WF_A1, session.id)),
      Promise.resolve(asides.completeSession(WF_A1, session.id, "迟到答案")),
    ]);
    const stored = s.store.get<AsideSession>("aside_session", session.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.answer).toBeUndefined();
    const afterSeq = Math.max(
      0,
      ...s.store.list<{ seq: number }>("feedback_message", WF_A1).map((item) => item.seq),
    );
    expect(afterSeq).toBe(beforeSeq);
    expect(s.store.eventCursor(WF_A1)).toBeGreaterThanOrEqual(beforeCursor);
    const workflow = s.store.get<Workflow>("workflow", WF_A1);
    expect(workflow?.feedback).toEqual([]);
  });
});
