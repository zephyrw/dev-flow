import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup, project, plan, proof } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { objectHash } from "../../packages/core/src/util.js";
import type { FastifyInstance } from "fastify";

const headers = {
  host: "localhost:14810",
  origin: "http://localhost:14810",
  "content-type": "application/json",
};
describe("计划驳回与只读问答 API", () => {
  let s: ReturnType<typeof setup>, app: FastifyInstance, id: string;
  beforeEach(async () => {
    s = setup();
    const p = project(s.root);
    s.store.put("project", p.id, "global", p);
    const w = s.engine.create(
      {
        project_id: p.id,
        title: "计划审阅",
        request: "修改文本",
        complexity: "simple",
        workspace_mode: "new_worktree",
      },
      "review",
    );
    id = w.id;
    s.engine.submitPlan(
      id,
      plan(objectHash(p), "a".repeat(40)),
      w.version,
      "plan",
    );
    app = await buildServer(s.engine);
  });
  afterEach(async () => {
    await app.close();
    s.store.close();
  });
  const payload = (s: ReturnType<typeof setup>, id: string) => {
    const w = s.engine.get(id);
    return {
      request_id: "review-request",
      expected_version: w.version,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash,
      text: "请补充回滚步骤及验收场景",
    };
  };
  const post = (path: string, body: unknown, extra = {}) =>
    app.inject({
      method: "POST",
      url: `/api/workflows/${id}/plan/${path}`,
      headers: { ...headers, ...extra },
      payload: body as any,
    });

  it.each([1, 2])(
    "第 %i 版驳回只派发规划，重复请求幂等，旧批准失效",
    async (revision) => {
      if (revision === 2)
        s.engine.submitPlan(
          id,
          s.engine.plan(id).plan,
          s.engine.get(id).version,
          "second",
        );
      const body = payload(s, id),
        approval = proof(s.engine, id, "approve");
      const result = await post("reject", body);
      expect(result.statusCode, result.body).toBe(200);
      expect(s.engine.get(id)).toMatchObject({
        state: "PLANNING",
        plan_revision: revision,
        feedback: [body.text],
      });
      expect(s.store.list<any>("feedback_message", id)).toMatchObject([
        {
          kind: "planning",
          target_document_revision: revision,
          text: body.text,
        },
      ]);
      expect(s.store.list("approval", id)).toHaveLength(0);
      expect(s.store.list("run", id)).toHaveLength(0);
      expect(s.store.jobs().map((j) => JSON.parse(j.data))).toEqual([
        { purpose: "planning" },
      ]);
      expect(() =>
        s.engine.approve(id, approval.proof, approval.binding),
      ).toThrow();
      const duplicate = await post("reject", body);
      expect(duplicate.statusCode).toBe(200);
      expect(s.store.list("feedback_message", id)).toHaveLength(1);
      expect(s.store.jobs()).toHaveLength(1);
      expect(
        (await post("reject", { ...body, text: "不同意见" })).statusCode,
      ).toBe(409);
    },
  );

  it("空意见、过期版本、错误计划哈希和模型令牌均不改变计划", async () => {
    const before = s.engine.get(id),
      body = payload(s, id);
    for (const patch of [
      { text: "   " },
      { expected_version: 1 },
      { plan_revision: 2 },
      { plan_hash: "wrong" },
    ])
      expect(
        (await post("reject", { ...body, ...patch })).statusCode,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (await post("reject", body, { authorization: "Bearer model-token" }))
        .statusCode,
    ).toBe(403);
    expect(s.engine.get(id)).toEqual(before);
    expect(s.store.list("feedback_message", id)).toHaveLength(0);
    expect(s.store.jobs()).toHaveLength(0);
  });

  it("已批准计划不能再驳回，失败不会遗留反馈", async () => {
    const approval = proof(s.engine, id, "approve");
    s.engine.approve(id, approval.proof, approval.binding);
    expect((await post("reject", payload(s, id))).statusCode).toBe(409);
    expect(s.engine.get(id).state).toBe("QUEUED");
    expect(s.store.list("feedback_message", id)).toHaveLength(0);
  });

  it("计划问答绑定版本、幂等且不改变审批、反馈、主任务版本", async () => {
    const before = s.engine.get(id);
    const { expected_version, ...body } = payload(s, id);
    const first = await post("questions", body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      plan_revision: 1,
      plan_hash: before.plan_hash,
      question: body.text,
    });
    expect((await post("questions", body)).json().id).toBe(first.json().id);
    expect(s.store.list("aside_session", id)).toHaveLength(1);
    expect(s.engine.get(id)).toEqual(before);
    expect(s.store.list("approval", id)).toHaveLength(0);
    expect(s.store.list("feedback_message", id)).toHaveLength(0);
    expect(
      (
        await post("questions", {
          ...body,
          request_id: "stale",
          plan_revision: 2,
        })
      ).statusCode,
    ).toBe(409);
    expect((await post("questions", { ...body, text: " " })).statusCode).toBe(
      422,
    );
    expect(
      (await post("questions", body, { authorization: "Bearer model-token" }))
        .statusCode,
    ).toBe(403);
    const history = await app.inject({
      url: `/api/workflows/${id}/plan/questions?plan_revision=1`,
      headers,
    });
    expect(history.json()).toHaveLength(1);
    expect(
      (
        await app.inject({
          url: `/api/workflows/${id}/plan/questions?plan_revision=2`,
          headers,
        })
      ).json(),
    ).toEqual([]);
  });
});
