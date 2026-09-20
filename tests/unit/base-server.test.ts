import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createBaseServer } from "../../apps/api/src/base-server.js";
import { modelErrorRetryable } from "../../apps/api/src/model-routes.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { AccountServiceError } from "../../packages/agy-accounts/src/service.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
});
const headers = {
  host: "localhost:24832",
  origin: "http://localhost:24832",
  "content-type": "application/json",
};

it.each([
  [new FlowError("MODEL_PROBE_TIMEOUT", "probe timed out", 503), 503, true],
  [new FlowError("MODEL_ACCESS_REQUIRED", "verify first", 422), 422, false],
  [new AccountServiceError("AGY_ACCOUNT_WAIT", 409), 409, false],
] as const)(
  "preserves typed failure %s across the shared server",
  async (failure, status, retryable) => {
    ({ app } = createBaseServer({
      port: 24832,
      humanOrigin: headers.origin,
      mode: "full",
      registerStatic: false,
      errorRetryable: modelErrorRetryable,
    }));
    app.post("/api/failure", async () => {
      throw failure;
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/failure",
      headers,
      payload: { request_id: "model-operation" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({
      error: {
        code: failure.code,
        message: failure.message,
        retryable,
        request_id: "model-operation",
      },
      request_id: "model-operation",
    });
  },
);
