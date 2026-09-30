import { expect, it, vi } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { Run } from "../../packages/contracts/src/index.js";

it("dispatches model changes into one native root and cross-tool A-B-A with context handoffs", async () => {
  const s = setup(); const repo = await repository(s.root); const p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({ project_id: p.id, title: "Session switch", request: "Keep task context",
    complexity: "simple", workspace_mode: "existing_workspace" }, "switch-create");
  await s.engine.git.prepare(p, created.id, "existing_workspace", { main: repo.baseline });
  s.store.put("plan", `${created.id}-1`, created.id, { revision: 1, hash: "plan", plan: plan("project", repo.baseline) });
  const w = { ...created, plan_revision: 1, plan_hash: "plan", binding_strategy: "unified" as const };
  const processes = new ProcessManager(); const calls = vi.spyOn(processes, "start");
  const runtime = new ProfileRuntime(s.engine, processes);
  let n = 0;
  const make = (adapter: "codex" | "agy", model: string, source?: Run): Run => ({
    id: "switch-" + ++n, workflow_id: w.id, plan_revision: 1, adapter, purpose: "implement", stage: "execute",
    protocol: "lightweight", status: "running", started_at: new Date().toISOString(), package_hash: "fixture",
    profile: { id: "profile-" + adapter, revision: 1, adapterId: adapter, executableRef: process.execPath,
      modelSelection: "explicit", modelId: model, options: { prefixArgs: [resolve("tests/fixtures/session-switch-cli.mjs"), adapter] } },
    ...(source ? { continuation: { kind: "runtime_resume", source_run_id: source.id, purpose: "execute", role: "executor" } } : {}),
  });
  const invoke = async (run: Run, materials = vi.fn(() => ({ instructions: "Continue current task", request: "Keep task context" }))) => {
    s.store.put("run", run.id, w.id, run); s.store.put("workflow", w.id, p.id, { ...w, state: "EXECUTING", run_id: run.id });
    const output = await (runtime as any).invoke(s.engine.get(w.id), run, materials, {});
    return { output, run: s.store.must<Run>("run", run.id), materials };
  };
  try {
    const a = await invoke(make("codex", "gpt-6-astra"));
    const neverRead = vi.fn(() => { throw new Error("Model-only continuation must not regenerate context"); });
    const sol = await invoke(make("codex", "gpt-6.1-sol", a.run), neverRead);
    expect(sol.run.conversation_id).toBe(a.run.conversation_id);
    expect(sol.output).toMatchObject({ captured_model: "gpt-6.1-sol", captured_text: "继续", previous_turns: 1 });
    expect(neverRead).not.toHaveBeenCalled();
    const b = await invoke(make("agy", "gemini-fixture", sol.run));
    expect(b.run.conversation_id).not.toBe(a.run.conversation_id);
    const bHandoff = JSON.parse(readFileSync(join(s.config.storage_root, "native-runs", b.run.id, "HANDOFF.json"), "utf8"));
    expect(bHandoff.cross_tool_handoff).toMatchObject({ source_adapter: "codex", target_adapter: "agy", source_run_id: sol.run.id });
    expect(existsSync(bHandoff.cross_tool_handoff.history_file)).toBe(true);
    const back = await invoke(make("codex", "gpt-6-astra", b.run));
    expect(back.run.conversation_id).toBe(a.run.conversation_id);
    expect(back.output.previous_turns).toBe(2);
    const backHandoff = JSON.parse(readFileSync(join(s.config.storage_root, "native-runs", back.run.id, "HANDOFF.json"), "utf8"));
    expect(backHandoff.cross_tool_handoff.progress.map((r: any) => r.run_id)).toContain(b.run.id);
    const again = await invoke(make("codex", "gpt-6.1-sol", back.run), neverRead);
    expect(again.run.conversation_id).toBe(a.run.conversation_id);
    expect(s.store.get("session_input", back.run.id)).toMatchObject({ kind: "cross_tool_handoff", state: "delivered" });
    const firstAGYSession = b.run.conversation_id!;
    unlinkSync(join(repo.repo, `.fixture-session-${firstAGYSession}.json`));
    const recreated = await invoke(make("agy", "gemini-fixture", again.run));
    expect(recreated.run.conversation_id).not.toBe(firstAGYSession);
    expect(s.store.get("session_recreate_run", recreated.run.id)).toMatchObject({ native_session_id: firstAGYSession });
    const launches = calls.mock.calls.map(([spec]) => spec.args);
    expect(launches.some(args => args.includes("resume") && args.includes(a.run.conversation_id!))).toBe(true);
    expect(launches.filter(args => args.includes("--conversation") && args.includes(firstAGYSession))).toHaveLength(1);
  } finally { await processes.close(); s.store.close(); }
}, 120000);
