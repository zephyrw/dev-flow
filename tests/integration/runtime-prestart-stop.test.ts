import { afterEach, expect, it, vi } from "vitest";
import { setup, project } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { CliDispatchManager } from "../../packages/runtime/src/cli-dispatch.js";
import { FlowError, type Run } from "../../packages/contracts/src/index.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const s = setup();
  const p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create({
    project_id: p.id, title: "pre-start stop", request: "isolated stop regression",
    complexity: "simple", workspace_mode: "existing_workspace",
  }, "create");
  const run: Run = {
    id: "pre-start-run", workflow_id: w.id, plan_revision: 0,
    adapter: "agy", stage: "execute", status: "running", purpose: "implement",
    protocol: "lightweight", started_at: new Date().toISOString(), package_hash: "fixture",
  };
  s.store.put("run", run.id, w.id, run);
  s.engine.transition(w.id, [w.state], "EXECUTING", "execute", { run_id: run.id });
  vi.spyOn(s.engine, "plan").mockReturnValue({ plan: { task_model: "native-v2" } } as any);
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  return { ...s, w: s.engine.get(w.id), run, runtime };
}

const accessFailure = () => new FlowError("MODEL_ACCESS_REQUIRED", "保存前需要完成模型访问验证", 422);

it("a witnessed access failure before start lets engine.stop reach STOPPED and survives runtime recreation", async () => {
  const s = fixture();
  try {
    vi.spyOn(ProfileRuntime.prototype, "execute").mockRejectedValue(accessFailure());
    await expect(s.runtime.execute(s.w, s.run, "fixture")).rejects.toMatchObject({ code: "MODEL_ACCESS_REQUIRED" });
    expect(s.store.get("process_record", s.run.id)).toBeUndefined();
    expect(s.store.get("stop_result", s.run.id)).toEqual({ status: "confirmed_not_started" });
    s.engine.runtime = new LocalRuntime(s.engine);
    expect((await s.engine.stop(s.w.id)).state).toBe("STOPPED");
  } finally { s.store.close(); }
});

it("missing process records for a historical failed run remain unknown", async () => {
  const s = fixture();
  try {
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "failed", error: String(accessFailure()) });
    expect(await s.runtime.stop(s.run.id)).toEqual({ status: "unknown" });
    expect(s.store.get("stop_result", s.run.id)).toBeUndefined();
  } finally { s.store.close(); }
});

it("even a start attempt that throws before a process record cannot be mistaken for an untouched preflight", async () => {
  const s = fixture();
  try {
    s.runtime.processes.setAdmissionGuard(() => { throw accessFailure(); });
    vi.spyOn(ProfileRuntime.prototype, "execute").mockImplementation(async () => {
      s.runtime.processes.start({ id: s.run.id, executable: "never-launched", args: [], cwd: s.root, env: {}, timeout_ms: 1000 });
    });
    await expect(s.runtime.execute(s.w, s.run, "fixture")).rejects.toMatchObject({ code: "MODEL_ACCESS_REQUIRED" });
    expect(s.runtime.processes.hasStartAttempt(s.run.id)).toBe(true);
    expect(s.store.get("process_record", s.run.id)).toBeUndefined();
    expect(await s.runtime.stop(s.run.id)).toEqual({ status: "unknown" });
    expect(s.store.get("stop_result", s.run.id)).toBeUndefined();
  } finally { s.store.close(); }
});

it("an existing unconfirmed process record is never replaced by a preflight confirmation", async () => {
  const s = fixture();
  try {
    s.store.put("process_record", s.run.id, s.w.id, { status: "failed", confirmed: false });
    vi.spyOn(ProfileRuntime.prototype, "execute").mockRejectedValue(accessFailure());
    await expect(s.runtime.execute(s.w, s.run, "fixture")).rejects.toThrow();
    expect(await s.runtime.stop(s.run.id)).toEqual({ status: "unknown" });
    expect(s.store.get("stop_result", s.run.id)).toBeUndefined();
  } finally { s.store.close(); }
});

it("stop waits for preparation and never confirms a still-pending execute call", async () => {
  const s = fixture();
  let rejectExecute!: (error: Error) => void;
  let finishPreparation!: () => void;
  try {
    vi.spyOn(ProfileRuntime.prototype, "execute").mockImplementation(() => new Promise((_, reject) => { rejectExecute = reject; }));
    const execution = s.runtime.execute(s.w, s.run, "fixture");
    const rejected = expect(execution).rejects.toMatchObject({ code: "MODEL_ACCESS_REQUIRED" });
    (s.runtime as any).preparing.set(s.run.id, new Promise<void>((resolve) => { finishPreparation = resolve; }));
    let stopped = false;
    const stopping = s.runtime.stop(s.run.id).then((result) => { stopped = true; return result; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(s.store.get("stop_result", s.run.id)).toBeUndefined();
    finishPreparation();
    expect(await stopping).toEqual({ status: "unknown" });
    rejectExecute(accessFailure());
    await rejected;
    expect(await s.runtime.stop(s.run.id)).toEqual({ status: "confirmed_not_started" });
  } finally { s.store.close(); }
});

it("a stop retry with a confirmed receipt clears only the resolved unknown writer and allows dispatch", async () => {
  const s = fixture();
  try {
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "failed" });
    expect((await s.engine.stop(s.w.id)).state).toBe("STOPPING");
    expect(s.store.get<any>("workflow_dispatch_control", s.w.id)?.writer_state).toBe("unknown");
    s.store.put("stop_result", s.run.id, s.w.id, { status: "confirmed_not_started" });
    expect((await s.engine.stop(s.w.id)).state).toBe("STOPPED");
    const dispatch = new CliDispatchManager(s.store, s.runtime.processes);
    dispatch.removeControlReason(s.w.id, "workflow_pause");
    expect(dispatch.canDispatch(s.w.id)).toEqual({ allowed: true });
    expect(s.store.get<any>("workflow_dispatch_control", s.w.id)?.writer_state).toBe("idle");
  } finally { s.store.close(); }
});

it.each(["dispatch", "process", "run"] as const)("a receipt for one run cannot clear an unknown writer while another %s is active", async (kind) => {
  const s = fixture();
  try {
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "failed" });
    expect((await s.engine.stop(s.w.id)).state).toBe("STOPPING");
    s.store.put("stop_result", s.run.id, s.w.id, { status: "confirmed_not_started" });
    if (kind === "dispatch") {
      s.store.put("cli_dispatch_record", "other-dispatch", s.w.id, {
        id: "other-dispatch", dispatch_id: "other-dispatch", workflow_id: s.w.id,
        run_id: "other-run", state: "running",
      });
    } else if (kind === "process") {
      s.store.put("process_record", "other-process", s.w.id, {
        id: "other-process", workflow_id: s.w.id, status: "running", confirmed: false,
      });
    } else {
      s.store.put("run", "other-run", s.w.id, { ...s.run, id: "other-run", status: "running" });
    }
    await s.engine.stop(s.w.id);
    const dispatch = new CliDispatchManager(s.store, s.runtime.processes);
    dispatch.removeControlReason(s.w.id, "workflow_pause");
    expect(dispatch.canDispatch(s.w.id).allowed).toBe(false);
    expect(s.store.get<any>("workflow_dispatch_control", s.w.id)?.writer_state).toBe("unknown");
  } finally { s.store.close(); }
});

it("clearing a resolved unknown writer preserves independent dispatch restrictions and advances revision", async () => {
  const s = fixture();
  try {
    s.store.put("run", s.run.id, s.w.id, { ...s.run, status: "failed" });
    const dispatch = new CliDispatchManager(s.store, s.runtime.processes);
    dispatch.addControlReason(s.w.id, { reason: "user_disabled", message: "keep disabled" });
    await s.engine.stop(s.w.id);
    const before = dispatch.getDispatchControl(s.w.id);
    s.store.put("stop_result", s.run.id, s.w.id, { status: "confirmed_not_started" });
    await s.engine.stop(s.w.id);
    const after = dispatch.getDispatchControl(s.w.id);
    expect(after.writer_state).toBe("idle");
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.reasons.map((r) => r.reason)).toEqual(before.reasons.map((r) => r.reason));
    expect(after.reasons.find((r) => r.reason === "user_disabled"))
      .toEqual(before.reasons.find((r) => r.reason === "user_disabled"));
    dispatch.removeControlReason(s.w.id, "workflow_pause");
    expect(dispatch.canDispatch(s.w.id)).toEqual({ allowed: false, reason: "keep disabled" });
  } finally { s.store.close(); }
});
