import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolProfile } from "../../packages/contracts/src/index.js";

const profile: ToolProfile = {
  id: "planner",
  revision: 1,
  adapterId: "codex",
  modelSelection: "explicit",
  modelId: "gpt-6-astra",
  selectionKind: "fixed",
  reasoning: { mode: "explicit", value: "high" },
  options: {},
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const api = () => import("../../apps/web/src/components/model-api.js");

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-20T00:00:00Z"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Web model operation lifecycle", () => {
  it("waits for a refresh to commit instead of reading the old directory at HTTP 202", async () => {
    let polls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return json({ id: "refresh-1", status: "ready" });
      polls += 1;
      return json({
        id: "refresh-1",
        status: polls === 1 ? "processing" : "committed",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const { refreshAdapterModels } = await api();
    let settled = false;
    const result = refreshAdapterModels("codex").then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toMatchObject({ status: "committed" });
    expect(fetcher.mock.calls[2]?.[0]).toBe("/api/model-operations/refresh-1");
  });

  it("reports a discovery failure and stops polling", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      json(
        init?.method === "POST"
          ? { id: "discover-1", status: "ready" }
          : {
              id: "discover-1",
              status: "failed",
              error_code: "TOOL_NOT_FOUND",
              error_message: "CLI missing",
            },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { discoverTools } = await api();
    const result = discoverTools(["codex"]).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({
      code: "TOOL_NOT_FOUND",
      message: "CLI missing",
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a valid 20-second verification pending beyond 16 seconds", async () => {
    const started = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        json(
          init?.method === "POST"
            ? {
                id: "verify-long",
                status: "checking",
                deadline_at: new Date(started + 60000).toISOString(),
              }
            : {
                status: Date.now() - started >= 20000 ? "verified" : "checking",
              },
        ),
      ),
    );
    const { verifyModelAccess } = await api();
    let settled = false;
    const result = verifyModelAccess(profile).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(16500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5500);
    await expect(result).resolves.toMatchObject({ status: "verified" });
  });

  it("shares polling until the last subscriber closes, then resumes the server job without another POST", async () => {
    let completed = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      json(
        init?.method === "POST"
          ? { id: "verify-shared", status: "checking" }
          : { status: completed ? "verified" : "checking" },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { verifyModelAccess } = await api();
    const one = new AbortController();
    const two = new AbortController();
    const first = verifyModelAccess(profile, one.signal).catch(
      (error) => error,
    );
    const second = verifyModelAccess(profile, two.signal).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    one.abort();
    expect((await first).name).toBe("AbortError");
    const before = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher.mock.calls.length).toBeGreaterThan(before);
    two.abort();
    expect((await second).name).toBe("AbortError");
    const after = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(after);
    completed = true;
    await expect(verifyModelAccess(profile)).resolves.toMatchObject({
      status: "verified",
      verificationId: "verify-shared",
    });
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => url.includes("cancel"))).toBe(
      false,
    );
  });

  it("reopening while the initial POST is outstanding reuses that request", async () => {
    let resolvePost!: (value: Response) => void;
    const post = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const fetcher = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? post
        : Promise.resolve(json({ status: "verified" })),
    );
    vi.stubGlobal("fetch", fetcher);
    const { verifyModelAccess } = await api();
    const controller = new AbortController();
    const first = verifyModelAccess(profile, controller.signal).catch(
      (error) => error,
    );
    controller.abort();
    expect((await first).name).toBe("AbortError");
    const reopened = verifyModelAccess(profile);
    resolvePost(json({ id: "pending-post", status: "checking" }));
    await expect(reopened).resolves.toMatchObject({ status: "verified" });
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("reads a terminal server job once when reopened after its deadline", async () => {
    const controller = new AbortController();
    let completed = false;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      json(
        init?.method === "POST"
          ? {
              id: "expired-panel",
              status: "checking",
              deadline_at: new Date(Date.now() + 1000).toISOString(),
            }
          : {
              status: completed ? "failed" : "checking",
              error_message: "verification deadline exceeded",
            },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const { verifyModelAccess } = await api();
    const first = verifyModelAccess(profile, controller.signal).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await first).name).toBe("AbortError");
    await vi.advanceTimersByTimeAsync(10000);
    completed = true;
    await expect(verifyModelAccess(profile)).resolves.toMatchObject({
      status: "failed",
    });
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });

  it("keeps force revalidation separate from ordinary verification", async () => {
    const bodies: Array<{ force: boolean }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ status: "verified" });
      }),
    );
    const { verifyModelAccess } = await api();
    await Promise.all([
      verifyModelAccess(profile),
      verifyModelAccess(profile, undefined, true),
    ]);
    expect(bodies.map((body) => body.force)).toEqual([false, true]);
  });

  it("returns inactive installer draft separately from the effective defaults", async () => {
    const pending = { ...profile, modelId: "pending-model" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          defaults: {
            revision: 4,
            plannerProfile: profile,
            executorProfile: profile,
          },
          pending_draft: {
            expected_defaults_revision: 4,
            plannerProfile: pending,
            executorProfile: profile,
          },
        }),
      ),
    );
    const { getModelDefaults } = await api();
    const result = await getModelDefaults();
    expect(result.plannerProfile.modelId).toBe("gpt-6-astra");
    expect(result.pendingDraft?.plannerProfile.modelId).toBe("pending-model");
    expect(result.pendingDraft?.expected_defaults_revision).toBe(4);
  });
});
