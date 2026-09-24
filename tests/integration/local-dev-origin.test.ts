import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createBaseServer } from "../../apps/api/src/base-server.js";

describe("I04 — 本地开发前端 Origin 精确放行与安全边界", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  const backendPort = 24890;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const allowedDevFrontend = "http://127.0.0.1:5174";

  it("在本地开发模式下，允许指定的开发前端 Origin 发送写请求", async () => {
    const prevEnv = process.env.DEVFLOW_LOCAL_DEV;
    process.env.DEVFLOW_LOCAL_DEV = "1";

    try {
      ({ app } = createBaseServer({
        port: backendPort,
        humanOrigin: backendOrigin,
        mode: "full",
        registerStatic: false,
        developmentFrontendOrigin: allowedDevFrontend,
      }));

      app.post("/api/test-action", async () => {
        return { success: true };
      });

      // 1. 本实例开发前端 Origin 发起 POST 写请求：允许通过
      const devResponse = await app.inject({
        method: "POST",
        url: "/api/test-action",
        headers: {
          host: "127.0.0.1:5174",
          origin: allowedDevFrontend,
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
        payload: { message: "来自开发前端的写操作" },
      });

      expect(devResponse.statusCode).toBe(200);
      expect(devResponse.json()).toEqual({ success: true });
    } finally {
      process.env.DEVFLOW_LOCAL_DEV = prevEnv;
    }
  });

  it("拒绝未允许的其他 Origin（兄弟实例或恶意域）发起的写请求", async () => {
    const prevEnv = process.env.DEVFLOW_LOCAL_DEV;
    process.env.DEVFLOW_LOCAL_DEV = "1";

    try {
      ({ app } = createBaseServer({
        port: backendPort,
        humanOrigin: backendOrigin,
        mode: "full",
        registerStatic: false,
        developmentFrontendOrigin: allowedDevFrontend,
      }));

      app.post("/api/test-action", async () => {
        return { success: true };
      });

      // 尝试使用未授权的兄弟实例端口 Origin
      const unauthResponse = await app.inject({
        method: "POST",
        url: "/api/test-action",
        headers: {
          host: `127.0.0.1:${backendPort}`,
          origin: "http://127.0.0.1:9999",
          "content-type": "application/json",
        },
        payload: { message: "未授权的写请求" },
      });

      expect(unauthResponse.statusCode).toBe(403);
      expect(unauthResponse.json().error.code).toBe("ORIGIN_DENIED");
    } finally {
      process.env.DEVFLOW_LOCAL_DEV = prevEnv;
    }
  });

  it("携带模型 bearer token 调用控制台路由时严格拒绝，返回 403", async () => {
    const { app: localApp, humanCheck } = createBaseServer({
      port: backendPort,
      humanOrigin: backendOrigin,
      mode: "full",
      registerStatic: false,
    });
    app = localApp;

    app.post("/api/test-action", async (req) => {
      humanCheck(req);
      return { success: true };
    });

    const bearerResponse = await app.inject({
      method: "POST",
      url: "/api/test-action",
      headers: {
        host: `127.0.0.1:${backendPort}`,
        origin: backendOrigin,
        "content-type": "application/json",
        authorization: "Bearer mock-worker-token",
      },
      payload: {},
    });

    expect(bearerResponse.statusCode).toBe(403);
    expect(bearerResponse.json().error.code).toBe("FORBIDDEN");
  });

  it("生产模式（NODE_ENV=production）下忽略开发前端 Origin 放行", async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevLocalDev = process.env.DEVFLOW_LOCAL_DEV;
    process.env.NODE_ENV = "production";
    process.env.DEVFLOW_LOCAL_DEV = "1";

    try {
      ({ app } = createBaseServer({
        port: backendPort,
        humanOrigin: backendOrigin,
        mode: "full",
        registerStatic: false,
        developmentFrontendOrigin: allowedDevFrontend,
      }));

      app.post("/api/test-action", async () => {
        return { success: true };
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/test-action",
        headers: {
          host: "127.0.0.1:5174",
          origin: allowedDevFrontend,
          "content-type": "application/json",
        },
        payload: {},
      });

      // 生产模式下不会放行开发前端 Origin，返回 403 HOST_DENIED 或 ORIGIN_DENIED
      expect(response.statusCode).toBe(403);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      process.env.DEVFLOW_LOCAL_DEV = prevLocalDev;
    }
  });
});
