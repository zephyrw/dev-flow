import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Store } from "../../packages/store/src/store.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import { WorkflowAsideHistory } from "../../packages/asides/src/workflow-history.js";
import { workflowAsidesPlugin } from "../../apps/api/src/routes/workflow-asides.js";
import { CONVERSATION_ERROR, FlowError } from "../../packages/contracts/src/index.js";
import type { AsideSession } from "../../packages/contracts/src/feedback.js";

const PROJECT_A = "proj_wf_aside_a";
const WF_A1 = "wf_iso_a1";
const WF_A2 = "wf_iso_a2";

describe("workflow asides task isolation", () => {
  let root: string;
  let store: Store;
  let asides: AsideSessionService;
  let history: WorkflowAsideHistory;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devflow-wf-aside-"));
    store = new Store(join(root, "devflow.sqlite"));
    asides = new AsideSessionService(store);
    history = new WorkflowAsideHistory(store);
    putWorkflow(store, WF_A1, PROJECT_A, "同项目任务 A1");
    putWorkflow(store, WF_A2, PROJECT_A, "同项目任务 A2");
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it("同项目下不同任务的临时提问完全隔离，各自维护快照与 1/N", async () => {
    const a1First = asides.submitQuestion(WF_A1, "A1 问题 1");
    await waitTick();
    const a1Second = asides.submitQuestion(WF_A1, "A1 问题 2");
    await waitTick();
    const a2First = asides.submitQuestion(WF_A2, "A2 问题 1");

    const pageA1 = history.listPage(WF_A1);
    const pageA2 = history.listPage(WF_A2);

    expect(pageA1.total).toBe(2);
    expect(pageA1.items.map((item) => item.id)).toEqual([a1Second.id, a1First.id]);
    expect(pageA2.total).toBe(1);
    expect(pageA2.items.map((item) => item.id)).toEqual([a2First.id]);

    expect(history.position(WF_A1, a1Second.id)).toMatchObject({
      index: 1,
      total: 2,
      next_id: a1First.id,
    });
    expect(history.position(WF_A2, a2First.id)).toEqual({
      index: 1,
      total: 1,
      prev_id: undefined,
      next_id: undefined,
    });
  });

  it("拒绝跨任务读取详情、定位与分页游标", async () => {
    const a1First = asides.submitQuestion(WF_A1, "A1 仅此任务可见 1");
    await waitTick();
    asides.submitQuestion(WF_A1, "A1 仅此任务可见 2");
    asides.submitQuestion(WF_A2, "A2 问题");

    const pageA1 = history.listPage(WF_A1, { limit: 1 });
    expect(pageA1.next_cursor).toBeTruthy();

    expect(() =>
      history.listPage(WF_A2, { before: pageA1.next_cursor! }),
    ).toThrowError(FlowError);
    try {
      history.listPage(WF_A2, { before: pageA1.next_cursor! });
    } catch (error) {
      expect(error).toMatchObject({
        code: CONVERSATION_ERROR.INVALID_CURSOR,
        status: 400,
      });
    }

    try {
      history.position(WF_A2, a1First.id);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: CONVERSATION_ERROR.ASIDE_NOT_IN_WORKFLOW,
        status: 404,
      });
    }

    try {
      history.getDetail(WF_A2, a1First.id);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({
        code: CONVERSATION_ERROR.ASIDE_NOT_IN_WORKFLOW,
        status: 404,
      });
    }
  });

  it("支持历史 aside_session 回填与 waiting_account 状态记录", () => {
    putLegacyAside(store, {
      id: "legacy_a1",
      workflow_id: WF_A1,
      question: "旧版遗留 A1",
      created_at: "2026-09-20T09:00:00.000Z",
      status: "completed",
      answer: "已处理",
    });
    putLegacyAside(store, {
      id: "legacy_a2",
      workflow_id: WF_A2,
      question: "旧版遗留 A2",
      created_at: "2026-09-20T09:05:00.000Z",
      status: "waiting_account",
    });

    const pageA1 = history.listPage(WF_A1);
    const pageA2 = history.listPage(WF_A2);
    expect(pageA1.items.map((item) => item.id)).toEqual(["legacy_a1"]);
    expect(pageA2.items.map((item) => item.id)).toEqual(["legacy_a2"]);
    expect(pageA2.items[0]?.status).toBe("waiting_account");
  });

  it("任务 B 新增与更新提问不会出现在任务 A 的增量更新中", () => {
    const a1 = asides.submitQuestion(WF_A1, "A1 问题");
    const snapA1 = history.listUpdates(WF_A1, 0);
    expect(snapA1.items.map((i) => i.id)).toEqual([a1.id]);

    const a2 = asides.submitQuestion(WF_A2, "A2 问题");
    asides.completeSession(WF_A2, a2.id, "A2 答案");

    const afterA1 = history.listUpdates(WF_A1, snapA1.snapshot_cursor);
    expect(afterA1.items).toEqual([]);
    expect(afterA1.snapshot_cursor).toBe(snapA1.snapshot_cursor);
  });
});

describe("workflow asides HTTP routes", () => {
  let root: string;
  let store: Store;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "devflow-wf-aside-http-"));
    store = new Store(join(root, "devflow.sqlite"));
    putWorkflow(store, WF_A1, PROJECT_A, "HTTP A1");
    putWorkflow(store, WF_A2, PROJECT_A, "HTTP A2");
    const asides = new AsideSessionService(store);
    asides.submitQuestion(WF_A1, "A1 HTTP 1");
    asides.submitQuestion(WF_A1, "A1 HTTP 2");
    asides.submitQuestion(WF_A2, "A2 HTTP 1");

    app = Fastify({ logger: false });
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof FlowError) {
        reply.code(error.status).send({
          error: { code: error.code, message: error.message },
        });
        return;
      }
      throw error;
    });
    await app.register(workflowAsidesPlugin, { store, human: () => {} });
  });

  afterEach(async () => {
    await app.close();
    try {
      store.close();
    } catch {}
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it("分页、详情、位置、增量与跨任务隔离拒绝符合契约", async () => {
    const listA1 = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A1}/aside-history?limit=1`,
    });
    expect(listA1.statusCode).toBe(200);
    const pageA1 = listA1.json();
    expect(pageA1.total).toBe(2);
    expect(pageA1.items).toHaveLength(1);
    expect(pageA1.items[0]?.workflow_id).toBe(WF_A1);

    const asideA1Id = pageA1.items[0].id as string;
    const detailA1 = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A1}/asides/${asideA1Id}`,
    });
    expect(detailA1.statusCode).toBe(200);
    expect(detailA1.json().id).toBe(asideA1Id);

    const posA1 = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A1}/asides/${asideA1Id}/position?snapshot_cursor=${pageA1.snapshot_cursor}`,
    });
    expect(posA1.statusCode).toBe(200);
    expect(posA1.json()).toMatchObject({ index: 1, total: 2 });

    const listA2 = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A2}/aside-history`,
    });
    expect(listA2.statusCode).toBe(200);
    expect(listA2.json().total).toBe(1);
    expect(listA2.json().items[0]?.workflow_id).toBe(WF_A2);

    const crossDetail = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A2}/asides/${asideA1Id}`,
    });
    expect(crossDetail.statusCode).toBe(404);
    expect(crossDetail.json().error.code).toBe(
      CONVERSATION_ERROR.ASIDE_NOT_IN_WORKFLOW,
    );

    const crossCursor = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A2}/aside-history?before=${encodeURIComponent(pageA1.next_cursor)}`,
    });
    expect(crossCursor.statusCode).toBe(400);
    expect(crossCursor.json().error.code).toBe(
      CONVERSATION_ERROR.INVALID_CURSOR,
    );

    const updatesA1 = await app.inject({
      method: "GET",
      url: `/api/workflows/${WF_A1}/aside-updates?after=0`,
    });
    expect(updatesA1.statusCode).toBe(200);
    expect(updatesA1.json().items).toHaveLength(2);
    expect(updatesA1.json().snapshot_cursor).toBe(pageA1.snapshot_cursor);
  });
});

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function putWorkflow(
  store: Store,
  id: string,
  projectId: string,
  title: string,
) {
  store.put("workflow", id, projectId, {
    id,
    project_id: projectId,
    title,
    state: "EXECUTING",
    version: 1,
    plan_revision: 1,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
  });
}

function putLegacyAside(
  store: Store,
  input: {
    id: string;
    workflow_id: string;
    question: string;
    created_at: string;
    status: AsideSession["status"];
    answer?: string;
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
    status: input.status,
    answer: input.answer,
    created_at: input.created_at,
    expires_at: "2026-12-31T00:00:00.000Z",
    completed_at: input.answer ? input.created_at : undefined,
  };
  store.put("aside_session", session.id, session.workflow_id, session);
}
