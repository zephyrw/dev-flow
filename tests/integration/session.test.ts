import { it, expect } from "vitest";
import { once } from "node:events";
import { setup } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";

it("logout revokes the copied cookie and closes both authenticated event channels", async () => {
  const s = setup();
  const app = await buildServer(s.engine);
  const token = s.engine.auth.issue({ role: "human" });
  const headers = {
    host: "localhost:14810",
    origin: "http://localhost:14810",
    cookie: `devflow_session=${token}`,
  };
  await app.ready();
  const events = await app.injectWS("/api/events?workflow_id=wf-session", {
    headers,
  });
  const notifications = await app.injectWS("/api/notifications", { headers });
  try {
    expect(
      (await app.inject({ url: "/api/projects", headers })).statusCode,
    ).toBe(200);
    const closed = [once(events, "close"), once(notifications, "close")];
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    for (const [code] of await Promise.all(closed)) expect(code).toBe(1008);
    expect(
      (await app.inject({ url: "/api/projects", headers })).statusCode,
    ).toBe(401);
    expect(() => s.engine.auth.verify(token)).toThrow(/失效/);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/logout",
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    events.terminate();
    notifications.terminate();
    await app.close();
    s.store.close();
  }
});

it("an idle event connection closes when the human session expires", async () => {
  const s = setup();
  const app = await buildServer(s.engine);
  await app.ready();
  const token = s.engine.auth.issue({ role: "human" }, 500);
  const socket = await app.injectWS("/api/notifications", {
    headers: { host: "localhost:14810", cookie: `devflow_session=${token}` },
  });
  try {
    const [code] = await once(socket, "close");
    expect(code).toBe(1008);
    expect(() => s.engine.auth.verify(token)).toThrow(/过期/);
  } finally {
    socket.terminate();
    await app.close();
    s.store.close();
  }
});
