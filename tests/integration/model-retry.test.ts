import { it, expect, vi } from "vitest";
import { prepared } from "../helpers.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";
import { bindProfile } from "../../packages/core/src/run-profile.js";
import { now } from "../../packages/core/src/util.js";
import { quotaRetryAt } from "../../packages/core/src/model-retry.js";
import { resumeModelWaits } from "../../packages/runtime/src/recovery.js";
import { buildServer } from "../../apps/api/src/server.js";

it("manual recovery after account switch clears the quota wait and dispatches immediately", async () => {
  const s = await preparedWithRun();
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  s.engine.block(
    s.workflow.id,
    new FlowError("MODEL_QUOTA", "old quota", 422, {
      result: { error: "Resets in 3h." },
    }),
  );
  const app = await buildServer(s.engine);
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/workflows/${s.workflow.id}/recover`,
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("QUEUED");
    expect(s.store.get("model_retry", s.workflow.id)).toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
  } finally {
    await app.close();
    s.store.close();
  }
});

it("uses the provider reset time plus grace and never invents a reset time", () => {
  expect(quotaRetryAt("Individual quota reached. Resets in 2h49m37s.", 0)).toBe(
    (2 * 3600 + 49 * 60 + 37 + 60) * 1000,
  );
  expect(quotaRetryAt("quota reached", 0)).toBeNull();
});
it("quota wait persists, does not run early, and resumes the same approved workflow when due", async () => {
  const s = await preparedWithRun();
  const dispatch = vi.spyOn(s.engine, "dispatch").mockResolvedValue(undefined);
  try {
    s.engine.block(
      s.workflow.id,
      new FlowError("MODEL_QUOTA", "额度不足", 422, {
        result: { error: "Resets in 5m." },
      }),
    );
    const retry = s.store.get<any>("model_retry", s.workflow.id);
    expect(retry).toMatchObject({
      run_id: s.workflow.run_id,
      plan_hash: s.workflow.plan_hash,
    });
    s.engine.recover();
    await resumeModelWaits(s.engine, retry.retry_at - 1);
    expect(s.engine.get(s.workflow.id).state).toBe("BLOCKED");
    expect(s.engine.summary(s.workflow.id).attention?.message).toContain(
      "自动继续",
    );
    await resumeModelWaits(s.engine, retry.retry_at);
    expect(s.engine.get(s.workflow.id).state).toBe("QUEUED");
    expect(s.store.get("model_retry", s.workflow.id)).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    s.store.close();
  }
});
it("a user pause cancels deferred execution", async () => {
  const s = await preparedWithRun();
  try {
    s.engine.block(
      s.workflow.id,
      new FlowError("MODEL_QUOTA", "额度不足", 422, {
        result: { error: "Resets in 5m." },
      }),
    );
    await s.engine.stop(s.workflow.id, "local_console");
    await resumeModelWaits(s.engine, Date.now() + 86400000);
    expect(s.store.get("model_retry", s.workflow.id)).toBeUndefined();
    expect(s.engine.get(s.workflow.id).state).toBe("STOPPED");
  } finally {
    s.store.close();
  }
});


async function preparedWithRun() {
  const s = await prepared();
  const binding = bindProfile(s.store, s.config, s.workflow.id, "implement");
  const run: Run = {
    ...binding, id: s.workflow.run_id!, workflow_id: s.workflow.id,
    plan_revision: s.workflow.plan_revision, adapter: binding.profile.adapterId,
    stage: s.workflow.stage, status: "running", started_at: now(), package_hash: "fixture",
  };
  s.store.put("run", run.id, s.workflow.id, run);
  return s;
}
