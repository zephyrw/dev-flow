import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setup } from "../../../../tests/helpers.js";
import { buildServer } from "../../../../apps/api/src/server.js";
import { QualityCoordinator } from "../../../../packages/core/src/quality-coordinator.js";
import { CodexNativeAdapter } from "../../../../packages/adapters/codex/src/adapter.js";
import { runInstaller } from "../../../../packages/installer/src/main.js";
import { objectHash } from "../../../../packages/core/src/util.js";

const s=setup(), app=await buildServer(s.engine);
const headers={host:"localhost:14810",origin:"http://localhost:14810","content-type":"application/json"};
const results: any[]=[];
const finding=(id: string, data: any) => results.push({id,...data});
try {
  let calls=0;
  s.engine.runtime={async execute(){calls++;},async review(){calls++;return {};},async stop(){},async close(){},async check(){throw Error("unused");}};
  const create=await app.inject({method:"POST",url:"/api/workflows",headers,payload:{
    request_id:"audit-create",workspace_root:s.root,request_text:"Verify production scheduling",
    workspace_mode:"existing_workspace",planner_profile_id:"claude",executor_profile_id:"codex",
  }});
  const w=create.json().workflow;
  if(!w) throw Error(create.body);
  for(const job of s.store.jobs()){
    if(job.kind==="dispatch" || job.kind==="dispatch_run"){
      const wf=s.engine.get(job.workflow_id);
      if(["QUEUED","REVIEW_QUEUED","PLANNING","PLANNER_TAKEOVER"].includes(wf.state) && !s.store.get("queue",wf.id))
        s.engine.scheduler.enqueue(wf.id,wf.project_id);
      s.store.jobStatus(job.id,"delivered");
    }
  }
  await s.engine.dispatch();
  finding("V01",{defect:calls===0 && s.engine.get(w.id).state==="PLANNING",
    http_status:create.statusCode,model_calls:calls,state:s.engine.get(w.id).state,
    queue_present:!!s.store.get("queue",w.id),pending_outbox:s.store.jobs().length,
    run:s.store.list("run",w.id),spec:s.store.list("execution_spec",w.id)});
  s.store.put("workflow",w.id,w.project_id,{...s.engine.get(w.id),state:"HUMAN_PENDING",stage:"manual_acceptance"});
  const confirm=await app.inject({method:"POST",url:`/api/workflows/${w.id}/confirm-function`,headers,payload:{}});
  finding("V02",{defect:confirm.statusCode===200 && !s.store.get("acceptance",w.id),
    status:confirm.statusCode,state:s.engine.get(w.id).state,acceptance_record:!!s.store.get("acceptance",w.id),
    current_snapshot: s.engine.get(w.id).snapshot_id ?? null,pending_outbox:s.store.jobs().length});
  s.store.put("workflow",w.id,w.project_id,{...s.engine.get(w.id),state:"PLANNING",stage:"planning"});
  const cleanup=await app.inject({method:"POST",url:`/api/workflows/${w.id}/cleanup/retry`,headers,payload:{}});
  finding("V03",{defect:cleanup.statusCode===200 && s.engine.get(w.id).state==="COMPLETED",
    status:cleanup.statusCode,state:s.engine.get(w.id).state,receipt:cleanup.json(),commits:s.store.list("commit",w.id)});
  s.store.put("workflow",w.id,w.project_id,{...s.engine.get(w.id),state:"VERIFYING",stage:"execute"});
  const quality=new QualityCoordinator(s.store).evaluateReviewResult(w.id,{workflow_id:w.id,phase:"before_human",verdict:"passed"} as any);
  finding("V04",{defect:quality.action==="pass",result:quality,
    plan_revision:s.engine.get(w.id).plan_revision,delivery_count:s.store.list("delivery_revision",w.id).length});
  const facts=await new CodexNativeAdapter().readExecutionFacts({workflowId:"no-such-workflow",runId:"no-such-run"});
  finding("V05",{defect:facts.facts.length>0,facts});
  const isolatedHome=mkdtempSync(join(tmpdir(),"devflow-audit-install-"));
  const old={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,CODEX_HOME:process.env.CODEX_HOME};
  try {
    process.env.HOME=isolatedHome;process.env.USERPROFILE=isolatedHome;process.env.CODEX_HOME=join(isolatedHome,".codex");
    const installRoot=join(isolatedHome,"target");
    const exit=await runInstaller({sourceDir:join(isolatedHome,"nonexistent-source"),targetTools:["codex"],installRoot});
    const files=existsSync(installRoot)?readdirSync(installRoot,{recursive:true}).map(String):[];
    finding("V06",{defect:exit===0 && files.every(p=>p==="state.json"),exit,files,
      state:JSON.parse(readFileSync(join(installRoot,"state.json"),"utf8"))});
  } finally {
    for(const [k,v] of Object.entries(old)) if(v===undefined) delete process.env[k]; else process.env[k]=v;
  }
} finally {s.engine.runtime=undefined;await app.close();s.store.close();}
const paths=["apps/api/src/main.ts","apps/api/src/server.ts","packages/core/src/engine.ts","packages/core/src/create-workflow.ts","packages/core/src/quality-coordinator.ts","packages/adapters/sdk/src/base-adapter.ts","packages/installer/src/main.ts"];
const result={created_at:new Date().toISOString(),scope:"isolated real API/store/dispatcher; no live models or user repositories",results,
  source_hashes:Object.fromEntries(paths.map(p=>[p,objectHash(readFileSync(p,"utf8"))]))};
const output=resolve("docs/test/evidence/devflow-selfcheck-review-20260916/runtime-review.json");
mkdirSync(resolve(output,".."),{recursive:true});
writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({defects:results.filter(r=>r.defect).map(r=>r.id),output},null,2));
process.exitCode=results.some(r=>r.defect)?1:0;
