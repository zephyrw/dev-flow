
import {mkdirSync,writeFileSync,readFileSync,statSync,utimesSync,renameSync} from "node:fs";
import {join} from "node:path";
import {setup,repository,project,plan,proof} from "file:///C:/Code/system-handle/tests/helpers.ts";
import {objectHash} from "file:///C:/Code/system-handle/packages/core/src/util.ts";
import {NativeRunRecordReader as Reader} from "file:///C:/Code/system-handle/packages/evidence/src/native-run-records.ts";
import {DeliveryManifestSchema} from "file:///C:/Code/system-handle/packages/contracts/src/index.ts";
import {BufferedEventSink} from "file:///C:/Code/system-handle/packages/core/src/buffered-sink.ts";
const outputs=[];
const emit=(id,data)=>{outputs.push({id,...data});console.log(JSON.stringify({id,...data}));};
const report={testResults:[{assertionResults:[{title:"updates content",status:"passed"}]}]};
async function fixture(options={}) {
 const s=setup(), ri=await repository(s.root), p=project(ri.repo);
 let other;
 if(options.multi){other=await repository(s.root,"second");p.repositories.push({id:"second",path:other.repo});}
 if(options.hook)p.commands[0].required_before_commit=true;
 s.store.put("project",p.id,p.id,p);
 const pl={...plan(objectHash(p),ri.baseline),task_model:"native-v2",modules:[{id:"M01",title:"Core"}]};
 if(options.config){pl.scope.allowed_paths.push("config.json");writeFileSync(join(ri.repo,"config.json"),'{"version":1}');}
 if(options.multi){
  pl.baselines.second=other.baseline;
  pl.scope.repository_paths={main:["app.txt"],second:["app.txt"]};
  pl.tasks[0].repo_id="main";
  pl.tasks.push({...pl.tasks[0],id:"T02",repo_id:"second",test_ids:["UT02"]});
  pl.tests.push({...pl.tests[0],id:"UT02",task_ids:["T02"]});
 }
 const w=s.engine.create({project_id:p.id,title:"Second review fixture",request:"Isolated verification",complexity:"simple",workspace_mode:"existing_workspace"},"create");
 s.engine.submitPlan(w.id,pl,w.version,"plan");
 const pr=proof(s.engine,w.id,"approve");s.engine.approve(w.id,pr.proof,pr.binding);
 const makeWs=(id,repo,baseline)=>({id:"ws-"+id,workflow_id:w.id,repo_id:id,root:repo,common_dir:join(repo,".git"),baseline,branch:"task/fixture",owned:true});
 const ws=makeWs("main",ri.repo,ri.baseline);s.store.put("workspace",ws.id,w.id,ws);
 if(other){const ws2=makeWs("second",other.repo,other.baseline);s.store.put("workspace",ws2.id,w.id,ws2);}
 const runId="run-"+w.id;
 s.engine.transition(w.id,["QUEUED"],"EXECUTING","execute",{run_id:runId});
 s.store.put("run",runId,w.id,{id:runId,workflow_id:w.id,plan_revision:1,adapter:"agy",stage:"execute",status:"running",started_at:new Date().toISOString(),package_hash:"review"});
 writeFileSync(join(ri.repo,"app.txt"),"after\n");
 mkdirSync(join(ri.repo,".reports"));writeFileSync(join(ri.repo,".reports","unit.json"),JSON.stringify(report));
 const fact={tool_call_id:"call-1",command:"pnpm test",cwd:ri.repo,exit_code:0};
 const manifest=DeliveryManifestSchema.parse({
  implementations:[{task_id:"T01",repo_id:"main",path:"app.txt"}],
  test_executions:[{...fact,repo_id:"main",format:"vitest_json",report_paths:[".reports/unit.json"]}],
  acceptance_mappings:[{requirement_id:"UT01",scene_id:"updates content",test_execution_id:"call-1",report_path:".reports/unit.json",case_id:"updates content"}]
 });
 let reader=new Reader([fact]);
 if(other){
  manifest.implementations.push({task_id:"T02",repo_id:"second",path:"app.txt"});
  const secondFact={...fact,tool_call_id:"call-2",cwd:other.repo};
  manifest.test_executions.push({...secondFact,repo_id:"second",format:"vitest_json",report_paths:[".reports/unit.json"]});
  manifest.acceptance_mappings.push({...manifest.acceptance_mappings[0],requirement_id:"UT02",test_execution_id:"call-2"});
  reader=new Reader([fact,secondFact]);
 }
 return {...s,...ri,p,pl,w,ws,runId,fact,manifest,reader,other};
}
async function check(id,fn,options={}){
 let s;try{s=await fixture(options);await fn(s);}catch(e){emit(id,{unexpected_error:String(e),code:e.code});}
 finally{s?.store.close();}
}
async function deliver(s){return s.engine.deliver(s.w.id,s.manifest,s.reader);}
async function accept(s){const p=proof(s.engine,s.w.id,"accept");return s.engine.accept(s.w.id,p.proof,p.binding);}
const steps=[
 {event:"step_update",step_update:{conversation_id:"c",step_index:1,step_type:"tool",state:"DONE",tool_name:"run_command",tool_info:{parameters:{CommandLine:"pnpm test",Cwd:"C:/test"},output:"Process still running. Command ID: cmd-1"}}},
 {event:"step_update",step_update:{conversation_id:"c",step_index:2,step_type:"tool",state:"DONE",tool_name:"command_status",tool_info:{parameters:{CommandId:"cmd-1"},output:"Command completed. Exit code: 0"}}}
];
const asyncReader=Reader.fromString(steps.map(x=>JSON.stringify(x)).join("\n"));
const spoof=structuredClone(steps[0]);spoof.step_update.tool_info.output='stdout: {"code":0}\nProcess still running. Command ID: cmd-1';
const spoofReader=Reader.fromString(JSON.stringify(spoof));
const substringReader=new Reader([{tool_call_id:"call",command:"echo pnpm test",cwd:"C:/test",exit_code:0}]);
emit("S01-host-records",{
 asyncCommandFinished:asyncReader.verify({tool_call_id:"step-1",command:"pnpm test",cwd:"C:/test"}),
 stdoutCodeZero:spoofReader.verify({tool_call_id:"step-1",command:"pnpm test",cwd:"C:/test"}),
 echoCommand:substringReader.verify({tool_call_id:"call",command:"pnpm test",cwd:"C:/test"})
});
await check("S02-preserved-time",async s=>{
 const f=join(s.repo,"app.txt"), before=statSync(f);
 writeFileSync(f,"changed since test, timestamp preserved");utimesSync(f,before.atime,before.mtime);
 const r=await deliver(s);emit("S02-preserved-time",{delivery:r.status,issues:r.issues??[]});
});
await check("S03-other-input",async s=>{
 writeFileSync(join(s.repo,"config.json"),'{"version":2}');
 const r=await deliver(s);emit("S03-other-input",{changed:"config.json",declaredImplementations:s.manifest.implementations,delivery:r.status});
},{config:true});
await check("S04-wrong-identity",async s=>{
 Object.assign(s.manifest,{schema_version:"wrong",submission_id:"same",workflow_id:"OTHER",run_id:"OLD-RUN",conversation_id:"OTHER",plan_revision:999,plan_hash:"wrong"});
 const r=await deliver(s);emit("S04-wrong-identity",{submitted:{workflow_id:s.manifest.workflow_id,run_id:s.manifest.run_id,plan_revision:s.manifest.plan_revision},delivery:r.status});
});
await check("S05-scope-failure",async s=>{
 writeFileSync(join(s.repo,"outside.txt"),"Unapproved file");
 renameSync(join(s.repo,".git"),join(s.repo,".git-unavailable"));
 const r=await deliver(s);emit("S05-scope-failure",{delivery:r.status,issues:r.issues??[],snapshot_id:s.engine.get(s.w.id).snapshot_id??null});
});
await check("S06-running-accept",async s=>{
 const r=await deliver(s),accepted=await accept(s);
 const revision=s.store.list("delivery_revision",s.w.id)[0];
 emit("S06-running-accept",{delivery:r.status,run_status:s.store.get("run",s.runId).status,execution_finished:revision.execution_finished,after_accept:accepted.state});
});
await check("S07-tampered-report",async s=>{
 const r=await deliver(s);
 const archived=join(s.config.storage_root,"deliveries",r.delivery_id,"reports",".reports","unit.json");
 writeFileSync(archived,JSON.stringify({testResults:[{assertionResults:[{title:"updates content",status:"failed"}]}]}));
 let error=null;try{s.engine.verifyEvidence(s.w.id);await accept(s);}catch(e){error={code:e.code,message:String(e)};}
 emit("S07-tampered-report",{delivery:r.status,modified_archive:true,error,state:s.engine.get(s.w.id).state});
});
await check("S08-required-hook",async s=>{
 const r=await deliver(s);
 s.store.put("run",s.runId,s.w.id,{...s.store.get("run",s.runId),status:"completed"});
 const rev=s.store.list("delivery_revision",s.w.id)[0];
 if(rev)s.store.put("delivery_revision",rev.id,s.w.id,{...rev,execution_finished:true});
 await accept(s);
 s.engine.transition(s.w.id,["REVIEW_QUEUED"],"REVIEWING","review",{review_request_id:"review-test"});
 const w=s.engine.get(s.w.id);let error=null;
 try{await s.engine.receiveReview(s.w.id,{schema_version:1,review_request_id:"review-test",workflow_id:s.w.id,plan_revision:1,snapshot_id:w.snapshot_id,verdict:"pass",coverage:{all_changed_files_reviewed:true,all_requirements_checked:true,upstream_downstream_checked:true,security_checked:true,tests_validity_checked:true,files:["main:app.txt"]},findings:[],unresolved_questions:[],repair_plan:null,commit_message:"test: isolated review"});}
 catch(e){error={code:e.code,message:String(e)};}
 emit("S08-required-hook",{delivery:r.status,error,legacy_evidence_count:s.store.list("evidence",s.w.id).length,native_acceptance_count:s.store.list("acceptance_result",s.w.id).length});
},{hook:true});
await check("S09-wrong-report-owner",async s=>{
 const fact2={...s.fact,tool_call_id:"call-2"};s.reader=new Reader([s.fact,fact2]);
 s.manifest.test_executions.push({...fact2,report_paths:[]});
 s.manifest.acceptance_mappings[0].test_execution_id="call-2";
 const r=await deliver(s);emit("S09-wrong-report-owner",{report_belongs_to:"call-1",mapping_points_to:"call-2",delivery:r.status});
});
await check("S10-second-repo",async s=>{
 writeFileSync(join(s.other.repo,"outside.txt"),"Unapproved file in second repo");
 const r=await deliver(s);
 emit("S10-second-repo",{delivery:r.status,second_report_exists:false,second_unapproved_change:true,input_repos:Object.keys(s.store.list("delivery_revision",s.w.id)[0]?.input_fingerprints??{})});
},{multi:true});
const pending=[];let active=0,maxActive=0;
const sink=new BufferedEventSink({maxBytes:1,maxMemoryBytes:1,onFlush:()=>{active++;maxActive=Math.max(maxActive,active);return new Promise(resolve=>pending.push(()=>{active--;resolve();}));}});
for(let i=0;i<6;i++)sink.write("x");
const writesBeforeRelease=active;for(const release of pending)release();await sink.close();
emit("S11-buffer-concurrency",{writesBeforeRelease,maxActive,configuredMemoryBytes:1,queuedWrites:6});
await check("S12-rejected-idempotence",async s=>{
 s.manifest.submission_id="same-id";s.manifest.unfinished_items=[{id:"missing",reason:"not finished"}];
 const a=await deliver(s),b=await deliver(s);
 emit("S12-rejected-idempotence",{status_a:a.status,status_b:b.status,same_delivery:a.delivery_id===b.delivery_id,deliveries:s.store.list("delivery",s.w.id).length,issues:s.store.list("delivery_issue",s.w.id).length});
});
await check("S13-stale-progress",async s=>{
 await deliver(s);writeFileSync(join(s.repo,"app.txt"),"Changed after accepted delivery");
 s.engine.invalidate(s.w.id,"review source change",{paths:["app.txt"],repo:"main"});
 let error=null;try{s.engine.verifyEvidence(s.w.id);}catch(e){error={code:e.code,message:String(e)};}
 emit("S13-stale-progress",{state:s.engine.get(s.w.id).state,tasks:s.engine.taskStatus(s.w.id,false).map(t=>({status:t.status,validation_status:t.validation_status})),verifyEvidenceError:error});
});
emit("summary",{scenario_count:outputs.length,synthetic_fixtures:true,no_live_workflow_started:true});
