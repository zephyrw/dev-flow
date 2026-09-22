import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Store } from "../../packages/store/src/store.js";
import { AsideSessionService } from "../../packages/asides/src/service.js";
import {
  ProjectAsideHistory,
  encodeAsidePageCursor,
} from "../../packages/asides/src/project-history.js";
import { projectAsidesPlugin } from "../../apps/api/src/routes/project-asides.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  CONVERSATION_EVENT,
  FlowError,
  type ProjectAsideCursor,
  type ProjectAsideIndex,
} from "../../packages/contracts/src/index.js";
import type { AsideSession } from "../../packages/contracts/src/feedback.js";

const PROJECT_A = "proj_aside_a";
const PROJECT_B = "proj_aside_b";
const WF_A1 = "wf_aside_a1";
const WF_A2 = "wf_aside_a2";
const WF_B1 = "wf_aside_b1";

describe("SA-U20 project asides", () => {
  let root: string;
  let store: Store;
  let asides: AsideSessionService;
  let history: ProjectAsideHistory;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devflow-u20-"));
    store = new Store(join(root, "devflow.sqlite"));
    asides = new AsideSessionService(store);
    history = new ProjectAsideHistory(store);
    putWorkflow(store, WF_A1, PROJECT_A, "任务 A1");
    putWorkflow(store, WF_A2, PROJECT_A, "任务 A2");
    putWorkflow(store, WF_B1, PROJECT_B, "任务 B1");
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  });

  it("按 created_at DESC, id DESC 稳定排序并给出 1/N 位置", () => {
    putLegacyAside(store, {
      id: "aside_same_a",
      workflow_id: WF_A1,
      question: "同一时刻 A",
      created_at: "2026-09-20T10:00:00.000Z",
      status: "completed",
      answer: "A",
    });
    putLegacyAside(store, {
      id: "aside_same_b",
      workflow_id: WF_A1,
      question: "同一时刻 B",
      created_at: "2026-09-20T10:00:00.000Z",
      status: "completed",
      answer: "B",
    });
    putLegacyAside(store, {
      id: "aside_newer",
      workflow_id: WF_A2,
      question: "更新的问题",
      created_at: "2026-09-20T11:00:00.000Z",
      status: "completed",
      answer: "newer",
    });
    history.backfillProject(PROJECT_A);

    const page = history.listPage(PROJECT_A, { limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual([
      "aside_newer",
      "aside_same_b",
      "aside_same_a",
    ]);
    expect(page.total).toBe(3);

    const pos = history.position(PROJECT_A, "aside_same_b");
    expect(pos).toMatchObject({
      index: 2,
      total: 3,
      prev_id: "aside_newer",
      next_id: "aside_same_a",
    });
  });

  it("快照游标冻结历史成员，状态仍可更新", async () => {
    const first = asides.submitQuestion(WF_A1, "问题 1");
    await waitTick();
    const second = asides.submitQuestion(WF_A1, "问题 2");
    const snapshot = history.listPage(PROJECT_A).snapshot_cursor;
    expect(snapshot).toBeGreaterThan(0);

    await waitTick();
    const third = asides.submitQuestion(WF_A1, "问题 3");
    const frozen = history.listPage(PROJECT_A, { snapshot_cursor: snapshot });
    expect(frozen.total).toBe(2);
    expect(frozen.items.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(frozen.items.some((item) => item.id === third.id)).toBe(false);

    asides.completeSession(WF_A1, first.id, "已回答");
    const frozenAfter = history.listPage(PROJECT_A, {
      snapshot_cursor: snapshot,
    });
    expect(frozenAfter.total).toBe(2);
    expect(frozenAfter.items.find((item) => item.id === first.id)?.status).toBe(
      "completed",
    );

    const latest = history.listPage(PROJECT_A);
    expect(latest.total).toBe(3);
    expect(latest.items[0]?.id).toBe(third.id);
  });

  it("排名变化后仍按 ID 定位选中项并重算 1/N", async () => {
    const older = asides.submitQuestion(WF_A1, "较早问题");
    await waitTick();
    const selected = asides.submitQuestion(WF_A1, "选中问题");
    const beforeInsert = history.position(PROJECT_A, selected.id);
    expect(beforeInsert.index).toBe(1);

    await waitTick();
    asides.submitQuestion(WF_A2, "更新的问题");
    const afterInsert = history.position(PROJECT_A, selected.id);
    expect(afterInsert.index).toBe(2);
    expect(afterInsert.total).toBe(3);
    expect(afterInsert.next_id).toBe(older.id);
  });

  it("拒绝把项目 A 的分页游标用于项目 B", async () => {
    asides.submitQuestion(WF_A1, "项目 A 问题 1");
    await waitTick();
    asides.submitQuestion(WF_A1, "项目 A 问题 2");
    const fromA = history.listPage(PROJECT_A, { limit: 1 });
    expect(fromA.next_cursor).toBeTruthy();

    asides.submitQuestion(WF_B1, "项目 B 问题");
    expect(() =>
      history.listPage(PROJECT_B, { before: fromA.next_cursor! }),
    ).toThrowError(FlowError);
    try {
      history.listPage(PROJECT_B, { before: fromA.next_cursor! });
    } catch (error) {
      expect(error).toMatchObject({
        code: CONVERSATION_ERROR.INVALID_CURSOR,
        status: 400,
      });
    }

    const foreign = encodeAsidePageCursor({
      project_id: PROJECT_A,
      created_at: "2026-09-20T10:00:00.000Z",
      id: "aside_x",
      snapshot: 1,
    });
    expect(() => history.listPage(PROJECT_B, { before: foreign })).toThrowError(
      /不属于当前项目/,
    );
  });

  it("索引保留来源任务，迟到 complete 不能覆盖用户 cancel", () => {
    const fromA1 = asides.submitQuestion(WF_A1, "来自任务 A1");
    const fromA2 = asides.submitQuestion(WF_A2, "来自任务 A2");
    const page = history.listPage(PROJECT_A);
    expect(page.items.find((item) => item.id === fromA1.id)?.workflow_id).toBe(
      WF_A1,
    );
    expect(page.items.find((item) => item.id === fromA2.id)?.workflow_id).toBe(
      WF_A2,
    );

    asides.cancelSession(WF_A1, fromA1.id);
    const late = asides.completeSession(WF_A1, fromA1.id, "迟到答案");
    expect(late.status).toBe("cancelled");
    expect(late.answer).toBeUndefined();
    const stored = store.get<AsideSession>("aside_session", fromA1.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.answer).toBeUndefined();
    expect(stored?.workflow_id).toBe(WF_A1);

    const index = store.get<ProjectAsideIndex>(
      CONVERSATION_ENTITY.projectAsideIndex,
      fromA1.id,
    );
    expect(index?.status).toBe("cancelled");
    expect(index?.workflow_id).toBe(WF_A1);

    const promoted = store.get<AsideSession>("aside_session", fromA2.id);
    expect(promoted?.status).toBe("active");
  });

  it("已完成提问不会被迟到 cancel 改写", () => {
    const session = asides.submitQuestion(WF_A1, "已完成");
    asides.completeSession(WF_A1, session.id, "正式答案");
    asides.cancelSession(WF_A1, session.id);
    const stored = store.get<AsideSession>("aside_session", session.id);
    expect(stored?.status).toBe("completed");
    expect(stored?.answer).toBe("正式答案");
  });

  it("旧数据有界回填可重复，并保留旧 ID、状态、答案和归属", () => {
    putLegacyAside(store, {
      id: "aside_legacy",
      workflow_id: WF_A1,
      question: "历史提问",
      created_at: "2026-01-01T00:00:00.000Z",
      status: "completed",
      answer: "历史答案",
    });
    expect(history.backfillProject(PROJECT_A, 1)).toBe(1);
    expect(history.backfillProject(PROJECT_A, 1)).toBe(0);

    const session = store.get<AsideSession>("aside_session", "aside_legacy");
    expect(session).toMatchObject({
      id: "aside_legacy",
      workflow_id: WF_A1,
      status: "completed",
      answer: "历史答案",
    });
    const index = store.get<ProjectAsideIndex>(
      CONVERSATION_ENTITY.projectAsideIndex,
      "aside_legacy",
    );
    expect(index).toMatchObject({
      id: "aside_legacy",
      project_id: PROJECT_A,
      workflow_id: WF_A1,
      status: "completed",
      question_preview: "历史提问",
    });
  });

  it("索引与项目游标随状态更新递增，并写出 AsideUpdated", () => {
    const session = asides.submitQuestion(WF_A1, "跟踪游标");
    const created = store.get<ProjectAsideIndex>(
      CONVERSATION_ENTITY.projectAsideIndex,
      session.id,
    );
    const createdCursor = store.get<ProjectAsideCursor>(
      CONVERSATION_ENTITY.projectAsideCursor,
      PROJECT_A,
    );
    expect(created?.created_project_seq).toBe(createdCursor?.seq);
    expect(created?.updated_project_seq).toBe(createdCursor?.seq);

    asides.completeSession(WF_A1, session.id, "回答");
    const updated = store.get<ProjectAsideIndex>(
      CONVERSATION_ENTITY.projectAsideIndex,
      session.id,
    );
    const updatedCursor = store.get<ProjectAsideCursor>(
      CONVERSATION_ENTITY.projectAsideCursor,
      PROJECT_A,
    );
    expect(updated?.created_project_seq).toBe(created?.created_project_seq);
    expect(updated?.updated_project_seq).toBe(updatedCursor?.seq);
    expect(updatedCursor!.seq).toBeGreaterThan(createdCursor!.seq);

    const events = store.events(WF_A1);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === CONVERSATION_EVENT.asideUpdated)).toHaveLength(
      2,
    );
  });

  it("增量更新只返回 after 之后的变动，并可合并为最新状态", () => {
    const session = asides.submitQuestion(WF_A1, "增量");
    const afterCreate = history.currentSnapshot(PROJECT_A);
    asides.completeSession(WF_A1, session.id, "完成");
    const updates = history.listUpdates(PROJECT_A, afterCreate);
    expect(updates.items).toEqual([
      {
        id: session.id,
        status: "completed",
        updated_project_seq: updates.snapshot_cursor,
      },
    ]);
    expect(history.listUpdates(PROJECT_A, updates.snapshot_cursor).items).toEqual(
      [],
    );
  });

  it("不扩大全局 1 个 active 与每任务 3 个 queued", () => {
    const first = asides.submitQuestion(WF_A1, "占用");
    expect(first.status).toBe("active");
    expect(asides.submitQuestion(WF_A1, "排队 1").status).toBe("queued");
    expect(asides.submitQuestion(WF_A1, "排队 2").status).toBe("queued");
    expect(asides.submitQuestion(WF_A1, "排队 3").status).toBe("queued");
    expect(() => asides.submitQuestion(WF_A1, "超限")).toThrow(/排队提问已达上限/);
    expect(asides.submitQuestion(WF_A2, "跨任务排队").status).toBe("queued");
    const all = store.list<AsideSession>("aside_session");
    expect(all.filter((item) => item.status === "active")).toHaveLength(1);
    expect(
      all.filter((item) => item.workflow_id === WF_A1 && item.status === "queued"),
    ).toHaveLength(3);
  });
});

describe("SA-U20 project aside HTTP", () => {
  let root: string;
  let store: Store;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "devflow-u20-http-"));
    store = new Store(join(root, "devflow.sqlite"));
    putWorkflow(store, WF_A1, PROJECT_A, "任务 A1");
    putWorkflow(store, WF_B1, PROJECT_B, "任务 B1");
    const asides = new AsideSessionService(store);
    asides.submitQuestion(WF_A1, "HTTP 问题 1");
    asides.submitQuestion(WF_A1, "HTTP 问题 2");
    asides.submitQuestion(WF_B1, "其他项目");
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
    await app.register(projectAsidesPlugin, { store, human: () => {} });
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

  it("分页、位置与增量接口返回约定字段", async () => {
    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides?limit=1`,
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json();
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.next_cursor).toBeTruthy();
    expect(page.snapshot_cursor).toBeGreaterThan(0);
    expect(page.items[0]).toMatchObject({
      project_id: PROJECT_A,
      workflow_id: WF_A1,
      status: expect.stringMatching(/active|queued|completed/),
    });

    const asideId = page.items[0].id as string;
    const positioned = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/asides/${asideId}/position?snapshot_cursor=${page.snapshot_cursor}`,
    });
    expect(positioned.statusCode).toBe(200);
    expect(positioned.json()).toMatchObject({ index: 1, total: 2 });

    const updates = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_A}/aside-updates?after=0`,
    });
    expect(updates.statusCode).toBe(200);
    expect(updates.json().items.length).toBeGreaterThan(0);
    expect(updates.json().snapshot_cursor).toBe(page.snapshot_cursor);

    const rejected = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_B}/asides?before=${encodeURIComponent(page.next_cursor)}`,
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe(CONVERSATION_ERROR.INVALID_CURSOR);
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
