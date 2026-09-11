import { it, expect } from "vitest";
import { once } from "node:events";
import { setup, project, plan } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { objectHash } from "../../packages/core/src/util.js";
const headers = { host: "localhost:14810", origin: "http://localhost:14810" };

it("local console opens without pairing, cookies or login, including old credentials", async () => {
  const s = setup();
  s.store.put("credential", "old", "human", { publicKey: "unused" });
  const app = await buildServer(s.engine);
  try {
    for (const cookie of [undefined, "devflow_session=expired"]) {
      const response = await app.inject({
        url: "/api/projects",
        headers: { host: headers.host, ...(cookie ? { cookie } : {}) },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
    for (const path of [
      "status",
      "register/options",
      "register/verify",
      "challenge",
      "verify",
      "logout",
    ]) {
      const response = await app.inject({
        method: path === "status" ? "GET" : "POST",
        url: "/api/auth/" + path,
        headers,
        ...(path === "status" ? {} : { payload: {} }),
      });
      expect(response.statusCode).toBe(404);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/mcp",
          headers: { host: headers.host },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    s.store.close();
  }
});

it("button approval binds the viewed version, rejects foreign pages and repeated submissions", async () => {
  const s = setup(),
    p = project(".");
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "local approval",
      request: "fixture",
      complexity: "simple",
      workspace_mode: "new_worktree",
    },
    "local",
  );
  s.engine.submitPlan(
    w.id,
    plan(objectHash(p), "a".repeat(40)),
    w.version,
    "p1",
  );
  const app = await buildServer(s.engine);
  const url = `/api/workflows/${w.id}/approve`;
  const original = s.engine.binding(w.id, "approve");
  try {
    for (const extra of [
      { origin: "http://evil.example" },
      { origin: "null" },
      { origin: "http://localhost:9999" },
      { "sec-fetch-site": "cross-site" },
      { authorization: "Bearer model-token" },
    ]) {
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { ...headers, ...extra },
            payload: { binding: original },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { host: headers.host },
          payload: { binding: original },
        })
      ).statusCode,
    ).toBe(403);
    expect(s.engine.get(w.id).state).toBe("PLAN_PENDING");
    s.engine.submitPlan(
      w.id,
      plan(objectHash(p), "a".repeat(40)),
      s.engine.get(w.id).version,
      "p2",
    );
    const stale = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { binding: original },
    });
    expect(stale.json().error.code).toBe("BINDING_CHANGED");
    expect(s.store.list("human_proof")).toEqual([]);
    const binding = s.engine.binding(w.id, "approve");
    expect(
      (await app.inject({ method: "POST", url, headers, payload: { binding } }))
        .statusCode,
    ).toBe(200);
    expect(s.engine.get(w.id).state).toBe("QUEUED");
    expect(
      (await app.inject({ method: "POST", url, headers, payload: { binding } }))
        .statusCode,
    ).not.toBe(200);
    expect(s.store.list("approval", w.id)).toHaveLength(1);
    expect(s.store.list("human_proof")).toEqual([]);
  } finally {
    await app.close();
    s.store.close();
  }
});

it("event streams work without login and reject missing or foreign Origin at upgrade", async () => {
  const s = setup();
  const app = await buildServer(s.engine);
  await app.ready();
  const socket = await app.injectWS("/api/notifications", { headers });
  try {
    const incoming = once(socket, "message");
    s.store.event("wf-local", "p", "StateChanged", { to: "HUMAN_PENDING" });
    expect(JSON.parse(String((await incoming)[0])).workflow_id).toBe(
      "wf-local",
    );
    for (const origin of [undefined, "http://evil.example"]) {
      const response = await app.inject({
        url: "/api/notifications",
        headers: {
          host: headers.host,
          upgrade: "websocket",
          ...(origin ? { origin } : {}),
        },
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (
        await app.inject({
          url: "/api/workflows",
          headers: { host: headers.host, "sec-fetch-site": "same-site" },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    socket.terminate();
    await app.close();
    s.store.close();
  }
});
