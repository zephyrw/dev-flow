import { it, expect } from "vitest";
import { setup, project, plan } from "../helpers.js";
import { FlowError, type Run, type Workflow } from "../../packages/contracts/src/index.js";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repository } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";

it("returns input errors to the same execution stage, then asks for help if that continuation cannot run", () => {
  const s = setup(), time = new Date().toISOString();
  const w: Workflow = { id: "input-recovery", project_id: "p1", title: "input", request: "input",
    complexity: "simple", workspace_mode: "existing_workspace", state: "EXECUTING", stage: "acceptance_guidance",
    quality_policy_version: 2, version: 1, plan_revision: 1, plan_hash: "plan",
    environment_revision: 0, feedback: [], created_at: time, updated_at: time, run_id: "source" };
  const run: Run = { id: "source", workflow_id: w.id, plan_revision: 1, adapter: "agy", purpose: "functional_fix",
    stage: "acceptance_guidance", protocol: "lightweight", status: "failed", started_at: time, package_hash: "pkg",
    conversation_id: "same-session", dispatch_context: { purpose: "functional_fix", guidance_mode: "human_acceptance" } };
  try {
    s.store.put("project", "p1", "p1", project(s.root));
    s.store.put("workflow", w.id, "p1", w);
    s.store.put("plan", `${w.id}-1`, w.id, { revision: 1, hash: "plan", plan: plan("p", "a".repeat(40)) });
    s.store.put("run", run.id, w.id, run);
    s.store.put("repair_state", w.id, w.id, { executor_failures: 0 });
    const error = new FlowError("MODEL_REQUEST_INVALID", "request failed", 422, {
      diagnostic: "INVALID_ARGUMENT (code 400)", input_problems: ["本地的 C:/work/a.png 图片损坏，请检查保存格式。"] });
    s.engine.returnInputFailureToModel(w.id, run.id, error);
    expect(s.engine.get(w.id)).toMatchObject({ state: "QUEUED", stage: "acceptance_guidance" });
    expect(s.store.get<any>("pending_model_retry", w.id)).toMatchObject({ retry_run_id: run.id,
      input_feedback: expect.stringContaining("C:/work/a.png") });
    expect(s.store.get("repair_state", w.id)).toEqual({ executor_failures: 0 });
    s.store.put("run", "next", w.id, { ...run, id: "next" });
    s.store.put("workflow", w.id, "p1", { ...w, run_id: "next" });
    s.store.put("model_input_feedback", "next", w.id, { message: "prior input error" });
    s.engine.returnInputFailureToModel(w.id, "next", error);
    expect(s.engine.get(w.id).state).toBe("WAITING_INPUT");
    expect(s.store.list<any>("user_interaction", w.id).at(-1)?.request.message).toContain("C:/work/a.png");
    expect(s.store.get("execution_completion", "next")).toBeUndefined();
    s.store.put("workflow", w.id, "p1", { ...w, state: "STOPPED" });
    s.engine.returnInputFailureToModel(w.id, run.id, error);
    expect(s.engine.get(w.id).state).toBe("STOPPED");
  } finally { s.store.close(); }
});

it("reads the failed native image input and delivers its diagnostic to the resumed model through the real CLI transport", async () => {
  const s = setup(), repo = await repository(s.root), p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create({ project_id: p.id, title: "image input", request: "image input", complexity: "simple", workspace_mode: "existing_workspace" }, "image-fixture");
  await s.engine.git.prepare(p, w.id, "existing_workspace", { main: repo.baseline });
  s.store.put("plan", `${w.id}-1`, w.id, { revision: 1, hash: "plan", plan: plan("p", repo.baseline) });
  const cli = join(s.root, "image-cli.mjs"), image = join(repo.repo, "broken.png"), prompt = join(s.root, "prompt.txt");
  writeFileSync(image, Buffer.from('{"image":"iVBORw0KGgo="}', "base64"));
  const session = crypto.randomUUID();
  writeFileSync(cli, `import fs from 'node:fs';
    if(process.argv.includes('--version') || process.argv.includes('--help')) console.log('agy 1.2.13 --print --conversation --mode');
    else {
      const resumed=fs.existsSync(${JSON.stringify(prompt)});
      fs.writeFileSync(${JSON.stringify(prompt)}, JSON.stringify(process.argv));
      console.log(JSON.stringify({event:'init',conversation_id:${JSON.stringify(session)},init:{model:'fixture-model',cwd:${JSON.stringify(repo.repo)}}}));
      console.log(JSON.stringify({event:'step_update',step_update:{conversation_id:${JSON.stringify(session)},step_index:resumed?20:10,step_type:'user_input',state:'DONE'}}));
      if(!resumed) console.log(JSON.stringify({event:'step_update',step_update:{step_index:11,step_type:'tool',state:'DONE',tool_name:'arbitrary_image_reader',tool_info:{parameters:{file:${JSON.stringify(image)}}}}}));
      console.log(JSON.stringify({event:'result',result:{conversation_id:${JSON.stringify(session)},status:resumed?'SUCCESS':'ERROR',response:resumed?JSON.stringify({status:'completed',summary:'input repaired'}):'',...(resumed?{}:{error:'INVALID_ARGUMENT (code 400): Request contains an invalid argument.'})}}));
    }`);
  const run: Run = { id: "image-source", workflow_id: w.id, plan_revision: 1, adapter: "agy", purpose: "functional_fix",
    stage: "acceptance_guidance", protocol: "lightweight", status: "running", started_at: new Date().toISOString(), package_hash: "pkg",
    profile: { id: "agy-fixture", revision: 1, adapterId: "agy", executableRef: process.execPath,
      modelSelection: "explicit", modelId: "fixture-model", options: { prefixArgs: [cli] } } };
  const processes = new ProcessManager(), runtime = new ProfileRuntime(s.engine, processes);
  try {
    const current = { ...w, state: "EXECUTING" as const, stage: run.stage, plan_revision: 1, plan_hash: "plan", run_id: run.id };
    s.store.put("workflow", w.id, p.id, current); s.store.put("run", run.id, w.id, run);
    const error = await (runtime as any).invoke(current, run, { instructions: "inspect image" }, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FlowError);
    expect(error.code).toBe("MODEL_REQUEST_INVALID");
    expect(error.details.input_problems).toEqual([`本地的 ${image} 图片损坏，请检查保存格式。`]);
    const next = { ...run, id: "image-retry" };
    s.store.put("run", next.id, w.id, next);
    s.store.put("workflow", w.id, p.id, { ...current, run_id: next.id });
    s.store.put("model_input_feedback", next.id, w.id, { message: error.details.input_problems[0] });
    const result = await (runtime as any).invoke({ ...current, run_id: next.id }, next, { instructions: "inspect image" }, {});
    const argv = JSON.parse(readFileSync(prompt, "utf8"));
    expect(argv[argv.indexOf('-p') + 1]).toContain(image);
    expect(argv[argv.indexOf('--conversation') + 1]).toBe(session);
    expect(result.status).toBe("completed");
    expect(readFileSync(image).subarray(0, 4).toString('hex')).not.toBe('89504e47');
  } finally { await processes.close(); s.store.close(); }
}, 30000);
