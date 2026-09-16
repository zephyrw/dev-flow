
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup, repository, project, plan, proof } from "file:///C:/Code/system-handle/tests/helpers.ts";
import { objectHash } from "file:///C:/Code/system-handle/packages/core/src/util.ts";
import { NativeRunRecordReader } from "file:///C:/Code/system-handle/packages/evidence/src/native-run-records.ts";
import { WorkspaceFingerprintService } from "file:///C:/Code/system-handle/packages/workspace/src/fingerprint.ts";
import { HandoffBuilder } from "file:///C:/Code/system-handle/packages/adapters/agy/src/handoff.ts";
import { DeliveryManifestSchema } from "file:///C:/Code/system-handle/packages/contracts/src/index.ts";
const results = [];
function out(id, data) { results.push({ id, ...data }); console.log(JSON.stringify({ id, ...data })); }
const isolatedRoot = mkdtempSync(join(tmpdir(), "devflow-review-20260916-"));
const ri = await repository(isolatedRoot);
const hostCall = {tool_call_id:"test-call",command:"pnpm test",cwd:ri.repo,exit_code:0};
const vitestReport = {testResults:[{assertionResults:[{title:"updates content",status:"passed"}]}]};
async function fixture(options={}) {
  const s = setup();
  const p = project(ri.repo);
  s.store.put("project",p.id,p.id,p);
  const pl = {...plan(objectHash(p),ri.baseline),task_model:"native-v2",modules:[{id:"M01",title:"Core"}]};
  if(options.playwright) { pl.tests[0].layer = "e2e"; pl.exemptions = pl.exemptions.filter(e=>e.layer!=="e2e"); pl.exemptions.push({layer:"unit",reason:"Report adapter review fixture only exercises browser result import"}); }
  const w = s.engine.create({project_id:p.id,title:"Review repro",request:"Review repro only",complexity:"simple",workspace_mode:"existing_workspace"},"create");
  s.engine.submitPlan(w.id,pl,w.version,"plan");
  const pr=proof(s.engine,w.id,"approve");
  s.engine.approve(w.id,pr.proof,pr.binding);
  s.store.put("workspace","ws",w.id,{id:"ws",workflow_id:w.id,repo_id:"main",root:ri.repo,common_dir:join(ri.repo,".git"),baseline:ri.baseline,branch:"task/fixture",owned:true});
  const runId="run-"+w.id;
  s.engine.transition(w.id,["QUEUED"],"EXECUTING","execute",{run_id:runId});
  s.store.put("run",runId,w.id,{id:runId,workflow_id:w.id,plan_revision:1,adapter:"agy",stage:"execute",status:"running",started_at:new Date().toISOString(),package_hash:"test"});
  mkdirSync(join(ri.repo,".reports"),{recursive:true});
  writeFileSync(join(ri.repo,"app.txt"),"after\n");
  const reportPath=options.playwright?".reports/e2e.json":".reports/unit.json";
  writeFileSync(join(ri.repo,reportPath),JSON.stringify(options.playwright?{suites:[{specs:[{title:"updates content",tests:[{results:[{status:"passed"}]}]}]}]}:vitestReport));
  const manifest=DeliveryManifestSchema.parse({
    implementations:[{task_id:"T01",path:"app.txt"}],
    test_executions:[{...hostCall,report_paths:[reportPath]}],
    acceptance_mappings:[{requirement_id:"UT01",scene_id:"updates content",test_execution_id:"test-call",report_path:reportPath,case_id:"updates content"}]
  });
  return {...s,w,pl,manifest,reader:new NativeRunRecordReader([hostCall]),runId};
}
async function runCase(id, action) {
  const s = await fixture(id==="R7-report-format"?{playwright:true}:{});
  try { await action(s); } catch(e) { out(id,{unexpected_error:String(e),code:e.code}); }
  finally { s.store.close(); }
}
const actualShape={event:"step_update",step_update:{conversation_id:"c",step_index:2,step_type:"tool",state:"DONE",tool_name:"run_command",tool_info:{name:"run_command",parameters:{CommandLine:"pnpm test",Cwd:ri.repo},output:"Exit code: 0"}}};
out("R1-agy-shape",{facts:NativeRunRecordReader.fromString(JSON.stringify(actualShape)).getAllFacts().length});
const unknownReader=NativeRunRecordReader.fromString([
 {type:"tool_call",id:"unknown-exit",name:"run_command",args:{command:"pnpm test",cwd:ri.repo}},
 {type:"tool_result",tool_call_id:"unknown-exit",output:"Process still running"}
].map(JSON.stringify).join("\n"));
out("R2-missing-exit",{fact:unknownReader.getFact("unknown-exit"),verification:unknownReader.verify({tool_call_id:"unknown-exit",command:"pnpm test"})});
const mismatchReader=new NativeRunRecordReader([{tool_call_id:"unrelated",command:"echo hello",cwd:tmpdir(),exit_code:0}]);
out("R3-command-mismatch",{verification:mismatchReader.verify({tool_call_id:"unrelated",command:"pnpm test"})});
await runCase("R4-final-lifecycle",async s=>{
 const result=await s.engine.deliver(s.w.id,s.manifest,s.reader);
 const ws=s.engine.get(s.w.id);
 let acceptError;
 try { const p=proof(s.engine,s.w.id,"accept"); await s.engine.accept(s.w.id,p.proof,p.binding); }
 catch(e) { acceptError={code:e.code,message:String(e)}; }
 out("R4-final-lifecycle",{delivery:result.status,state:ws.state,snapshot_id:ws.snapshot_id??null,run_status:s.store.get("run",s.runId).status,tasks:s.engine.taskStatus(s.w.id,false),acceptError});
});
await runCase("R5-stale-report",async s=>{
 const before=WorkspaceFingerprintService.compute(ri.repo);
 writeFileSync(join(ri.repo,"app.txt"),"changed after tests without retest\n");
 const changed=WorkspaceFingerprintService.verifyFingerprint(ri.repo,{files:before.files});
 const result=await s.engine.deliver(s.w.id,s.manifest,s.reader);
 out("R5-stale-report",{changedSinceReport:changed,delivery:result.status,issues:result.issues??[]});
});
await runCase("R6-wrong-mapping-and-conflict",async s=>{
 s.manifest.implementations=[];
 s.manifest.acceptance_mappings[0].requirement_id="NONEXISTENT-REQUIREMENT";
 s.manifest.acceptance_mappings[0].test_execution_id="NONEXISTENT-CALL";
 s.manifest.plan_conflicts=[{id:"conflict-1",description:"Required architecture is not implemented"}];
 const result=await s.engine.deliver(s.w.id,s.manifest,s.reader);
 out("R6-wrong-mapping-and-conflict",{delivery:result.status,acceptance:result.acceptance_results,issues:result.issues??[]});
});
await runCase("R7-report-format",async s=>{
 const result=await s.engine.deliver(s.w.id,s.manifest,s.reader);
 out("R7-report-format",{delivery:result.status,issueCodes:result.issues?.map(x=>x.code)});
});
const fd=mkdtempSync(join(tmpdir(),"devflow-review-fingerprint-"));
mkdirSync(join(fd,".mvn")); writeFileSync(join(fd,".mvn","jvm.config"),"-Xmx128m");
writeFileSync(join(fd,"vitest.config.json"),'{"test":1}');
const fp1=WorkspaceFingerprintService.compute(fd);
writeFileSync(join(fd,".mvn","jvm.config"),"-Xmx4096m");
writeFileSync(join(fd,"vitest.config.json"),'{"test":2}');
const fp2=WorkspaceFingerprintService.compute(fd);
out("R8-input-exclusions",{files:fp1.files,changed:fp1.fingerprint!==fp2.fingerprint});
await runCase("R9-outside-scope",async s=>{
 writeFileSync(join(ri.repo,"unapproved.txt"),"Outside app.txt approved scope");
 const result=await s.engine.deliver(s.w.id,s.manifest,s.reader);
 out("R9-outside-scope",{approvedPaths:s.pl.scope.allowed_paths,extraPath:"unapproved.txt",delivery:result.status});
});
await runCase("R10-resume-plan",async s=>{
 const dir=join(isolatedRoot,"handoff");mkdirSync(dir);
 const full=HandoffBuilder.buildFullHandoff({workflow:s.engine.get(s.w.id),plan:s.pl,runId:s.runId,packageHash:"v1"});
 HandoffBuilder.writeHandoffFiles(dir,full,"# revision 1 old design");
 const revised={...s.pl,markdown:"# revision 2 corrected design"};
 const resume=HandoffBuilder.buildResumeHandoff({workflow:{...s.engine.get(s.w.id),plan_revision:2},plan:revised,runId:s.runId,conversationId:"c",packageHash:"v2"});
 HandoffBuilder.writeHandoffFiles(dir,resume);
 out("R10-resume-plan",{plan_revision:resume.plan_revision,design:readFileSync(join(dir,"HANDOFF.md"),"utf8"),workspaces_in_full:Object.hasOwn(full,"workspaces"),resume_has_design_file:Object.hasOwn(resume,"design_file")});
});
const logDirs=join("C:/Code/system-handle/.devflow/containers");
const logStats=[];
if(existsSync(logDirs)) {
 const candidates=readdirSync(logDirs,{withFileTypes:true}).filter(e=>e.isDirectory()).slice(0,20);
 for(const d of candidates) {
  const p=join(logDirs,d.name);
  for(const f of readdirSync(p).filter(n=>n.endsWith(".jsonl")).slice(0,1)) {
   const path=join(p,f); if(logStats.length>=3 || statSync(path).size>4*1024*1024) continue; const raw=readFileSync(path,"utf8");
   let events={}; let commands=0;
   for(const l of raw.split("\n")) {try{const e=JSON.parse(l);const k=e.event??e.type??"other";events[k]=(events[k]??0)+1;if(e.step_update?.step_type==="tool")commands++;}catch{}}
   logStats.push({file:f,events,toolSteps:commands,parsedFacts:NativeRunRecordReader.fromString(raw).getAllFacts().length});
  }
 }
}
out("R11-existing-agy-logs",{logs:logStats});
console.log(JSON.stringify({complete:true,isolatedRoot,resultCount:results.length}));
