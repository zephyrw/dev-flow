
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
 if(options.hook)p.commands[0].required_before_commit=true; if(options.extraChecks)p.commands.push(...options.extraChecks);
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

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
{
 let active=0,maxActive=0,completed=0;
 const sink=new BufferedEventSink({maxBytes:1,maxMemoryBytes:2,onFlush:async()=>{
   active++;maxActive=Math.max(maxActive,active);await delay(80);active--;completed++;
 }});
 const start=performance.now();sink.write("a");sink.write("b");sink.write("c");await sink.close();
 const atClose={elapsed_ms:Math.round(performance.now()-start),completed,active,maxActive};
 await delay(120);
 emit("R01-slow-buffer",{expected:"close waits for all writes; maxActive=1",atClose,finalCompleted:completed});
}
{
 let callbackCalls=0;const externalQueue=[];
 const sink=new BufferedEventSink({maxBytes:1,onFlush:()=>{externalQueue.push(()=>callbackCalls++);return delay(80);}});
 sink.write("a");await sink.close();
 emit("R02-callback-interception",{expected:"unrelated queued callbacks remain uncalled",callbackCalls,queued:externalQueue.length});
 await delay(100);
}
await check("R03-old-report-copied",async s=>{
 const path=join(s.repo,".reports","unit.json"),original=readFileSync(path);
 await delay(30);writeFileSync(join(s.repo,"app.txt"),"new code never tested\n");
 await delay(30);writeFileSync(path,original);
 const r=await deliver(s);
 emit("R03-old-report-copied",{expected:"reject old test result for changed code",delivery:r.status,issues:r.issues??[],reportUnchanged:readFileSync(path).equals(original),hostFacts:s.reader.readRecords(s.runId)});
});
await check("R04-second-report-missing",async s=>{
 const r=await deliver(s);
 emit("R04-second-report-missing",{expected:"reject missing second repo report",delivery:r.status,issues:r.issues??[],secondReportExists:false,acceptances:s.store.list("acceptance_result",s.w.id).map(x=>({requirement_id:x.requirement_id,status:x.status}))});
},{multi:true});
await check("R05-second-report-failed",async s=>{
 mkdirSync(join(s.other.repo,".reports"));
 writeFileSync(join(s.other.repo,".reports","unit.json"),JSON.stringify({testResults:[{assertionResults:[{title:"updates content",status:"failed"}]}]}));
 const r=await deliver(s);
 emit("R05-second-report-failed",{expected:"reject failed second repo report",delivery:r.status,issues:r.issues??[],secondReportStatus:"failed",acceptances:s.store.list("acceptance_result",s.w.id).map(x=>({requirement_id:x.requirement_id,status:x.status}))});
},{multi:true});
async function finalReview(s){
 s.store.put("run",s.runId,s.w.id,{...s.store.get("run",s.runId),status:"completed"});
 for(const rev of s.store.list("delivery_revision",s.w.id))s.store.put("delivery_revision",rev.id,s.w.id,{...rev,execution_finished:true});
 await accept(s);
 s.engine.transition(s.w.id,["REVIEW_QUEUED"],"REVIEWING","review",{review_request_id:"review-test"});
 const w=s.engine.get(s.w.id);let error=null;
 try{await s.engine.receiveReview(s.w.id,{schema_version:1,review_request_id:"review-test",workflow_id:s.w.id,plan_revision:1,snapshot_id:w.snapshot_id,verdict:"pass",coverage:{all_changed_files_reviewed:true,all_requirements_checked:true,upstream_downstream_checked:true,security_checked:true,tests_validity_checked:true,files:["main:app.txt"]},findings:[],unresolved_questions:[],repair_plan:null,commit_message:"test: isolated round3 review"});}
 catch(e){error={code:e.code,message:String(e)};}
 return {error,state:s.engine.get(s.w.id).state};
}
await check("R06-unexecuted-build",async s=>{
 const r=await deliver(s),final=await finalReview(s);
 emit("R06-unexecuted-build",{expected:"HOOK_EVIDENCE_MISSING",delivery:r.status,...final,hostCommands:s.reader.readRecords(s.runId).map(x=>x.command),hasBuildReady:s.store.recentEvents(s.w.id,500).some(e=>e.type==="BuildReady")});
},{extraChecks:[{id:"build",executable:process.execPath,args:["-e","process.exit(1)"],parser:"none",required_before_commit:true}]});
await check("R07-unexecuted-extra-check",async s=>{
 const r=await deliver(s),final=await finalReview(s);
 emit("R07-unexecuted-extra-check",{expected:"HOOK_EVIDENCE_MISSING",delivery:r.status,...final,hostCommands:s.reader.readRecords(s.runId).map(x=>x.command),requiredCommand:"integration-required"});
},{extraChecks:[{id:"integration-required",executable:process.execPath,args:["-e","process.exit(1)"],parser:"vitest_json",report_path:".reports/extra.json",required_before_commit:true}]});

await check("R08-snapshot-branch-failure",async s=>{
 s.store.put("workspace",s.ws.id,s.w.id,{...s.ws,branch:"task/different-expected-branch"});
 const r=await deliver(s);
 let snapshotError=null;try{await s.engine.git.snapshot(s.w.id,1);}catch(e){snapshotError=e.code??String(e);}
 emit("R08-snapshot-branch-failure",{expected:"reject snapshot failure without marking tasks verified",delivery:r.status,issues:r.issues??[],snapshot_id:s.engine.get(s.w.id).snapshot_id??null,snapshotError,taskProofs:s.store.list("task_proof",s.w.id).map(x=>({verified:x.verified}))});
});
await check("R09-failed-run-accept",async s=>{
 s.store.put("run",s.runId,s.w.id,{...s.store.get("run",s.runId),status:"failed"});
 const r=await deliver(s);let error=null;try{await accept(s);}catch(e){error={code:e.code,message:String(e)};}
 emit("R09-failed-run-accept",{expected:"reject non-successful run completion",delivery:r.status,runStatus:s.store.get("run",s.runId).status,error,state:s.engine.get(s.w.id).state});
});
await check("R10-wrong-conversation",async s=>{
 s.manifest.conversation_id="different-conversation";
 s.reader=new Reader([{...s.fact,conversation_id:"actual-conversation"}]);
 const r=await deliver(s);
 emit("R10-wrong-conversation",{expected:"reject mismatched host conversation",delivery:r.status,issues:r.issues??[],claimed:s.manifest.conversation_id,actual:"actual-conversation"});
});
await check("R11-idempotent-retry",async s=>{
 s.manifest.submission_id="fixed-submission";
 const first=await deliver(s);let retryError=null;
 try{await deliver(s);}catch(e){retryError={code:e.code,message:String(e)};}
 emit("R11-idempotent-retry",{expected:"same accepted result after successful response was lost",first:first.status,retryError,state:s.engine.get(s.w.id).state});
});
await check("R12-invalidated-retry",async s=>{
 s.manifest.submission_id="fixed-submission";
 const first=await deliver(s);
 s.engine.invalidate(s.w.id,"changed code");
 s.engine.transition(s.w.id,["HUMAN_PENDING"],"EXECUTING","review-probe-resume");
 writeFileSync(join(s.repo,"app.txt"),"untested after invalidation\n");
 const again=await deliver(s);
 emit("R12-invalidated-retry",{expected:"reject invalidated evidence; do not return cached accepted",first:first.status,retry:again.status,message:again.message,state:s.engine.get(s.w.id).state,revisions:s.store.list("delivery_revision",s.w.id).map(x=>({invalidated:x.invalidated}))});
});
