import { it, expect, vi } from "vitest";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { readableLogs } from "../../packages/presentation/src/activity.js";
import type { Run } from "../../packages/contracts/src/index.js";

it("legacy review streams named file operations before exit and still returns its structured report", async () => {
  const s = await fixture();
  const cli = join(s.root, "review-cli.cjs");
  const argsFile = join(s.root, "args.json");
  writeFileSync(cli, `
    const fs=require('node:fs');
    if(process.argv.includes('app-server')) process.exit(0);
    fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv));
    const emit=value=>console.log(JSON.stringify(value));
    emit({type:'thread.started',thread_id:'isolated-review'});
    emit({type:'item.started',item:{id:'read-1',type:'mcp_tool_call',tool:'devflow_review_read_file',arguments:{path:'src/review.ts'}}});
    setTimeout(()=>{
      emit({type:'item.completed',item:{id:'read-1',type:'mcp_tool_call',tool:'devflow_review_read_file',arguments:{path:'src/review.ts'}}});
      fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify({verdict:'fixture-only'}));
    },2000);
  `);
  const workflow = { ...s.engine.get(s.w.id), state: "REVIEWING" as const, stage: "quality_before_human", run_id: "review-stream", snapshot_id: "snapshot-stream", review_request_id: "request-stream" };
  const run = { id: workflow.run_id, workflow_id: workflow.id, adapter: "codex", purpose: "quality_review", status: "running", started_at: new Date().toISOString(), profile: { id: "profile-review", adapterId: "codex", modelSelection: "explicit", modelId: "fixture-model", executableRef: process.execPath, options: { prefixArgs: [cli] } } } as unknown as Run;
  s.store.put("workflow", workflow.id, workflow.project_id, workflow);
  s.store.put("workspace", "main", workflow.id, { id: "main", repo_id: "main", root: s.repo });
  s.store.put("run", run.id, workflow.id, run);
  s.store.put("snapshot", workflow.snapshot_id, workflow.id, { id: workflow.snapshot_id, repositories: [{repo_id:"main",files:[]}] });
  vi.spyOn(s.engine.git,"diff").mockResolvedValue([]);
  s.config.models.codex_executable=process.execPath;
  s.config.models.codex_prefix_args=[cli];
  const runtime=new LocalRuntime(s.engine);
  try {
    const completion=runtime.review(workflow,run);
    await expect.poll(()=>readableLogs(s.store.events(workflow.id,0,1000),workflow.id).find(row=>row.text==='src/review.ts')?.status,{timeout:15000}).toBe('active');
    expect(await completion).toEqual({verdict:'fixture-only'});
    expect(readableLogs(s.store.events(workflow.id,0,1000),workflow.id).find(row=>row.text==='src/review.ts')).toMatchObject({title:'读取文件',status:'done'});
    const args=JSON.parse(readFileSync(argsFile,'utf8'));
    expect(args).toContain('--json');
    expect(args).not.toContain('--ephemeral');
  } finally { await runtime.close(); await cleanup(s); }
});
