import {mkdtempSync,mkdirSync,writeFileSync,existsSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {setup,plan} from '../../../../tests/helpers.ts';
import {CreateWorkflowService} from '../../../../packages/core/src/create-workflow.ts';
import {QualityCoordinator} from '../../../../packages/core/src/quality-coordinator.ts';
import {FunctionalIssueService} from '../../../../packages/core/src/functional-issues.ts';
import {AsideSessionService} from '../../../../packages/asides/src/service.ts';
import {CurrentDeliveryReader} from '../../../../packages/evidence/src/current-delivery.ts';
import {WorkspaceReferenceService as Ref} from '../../../../packages/workspace/src/references.ts';
import {CodexNativeAdapter} from '../../../../packages/adapters/codex/src/adapter.ts';
import {ClientInstaller} from '../../../../packages/clients/src/installer.ts';
import {buildServer} from '../../../../apps/api/src/server.ts';
import {validatePlan} from '../../../../packages/plans/src/validate.ts';
import {NativePlanSchema} from '../../../../packages/contracts/src/native-plan.ts';
import {GitDeliveryCoordinator} from '../../../../packages/git/src/delivery-coordinator.ts';
const results=[];
function record(id,defect,observed){results.push({id,defect_reproduced:!!defect,observed});}
const s=setup();const root=s.root;const repo=join(root,'repo');mkdirSync(repo);
const outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'marker.txt'),'SYNTHETIC_REVIEW_MARKER');
const app=await buildServer(s.engine);const headers={host:'localhost:14810',origin:'http://localhost:14810','content-type':'application/json'};
try {
 const input={request_id:'audit-create',workspace_root:repo,request_text:'Review synthetic requirement',workspace_mode:'new_worktree',planner_profile_id:'profile-codex',executor_profile_id:'profile-claude-code'};
 const created=await app.inject({method:'POST',url:'/api/workflows',headers,payload:input});
 const wf=created.json().workflow;const detail=await app.inject({method:'GET',url:`/api/workflows/${wf.id}`,headers});
 record('R01',created.statusCode===200&&detail.statusCode>=400,{create:created.statusCode,detail:detail.statusCode,error:detail.json().error});
 record('R02',s.store.jobs().length===0&&s.store.list('outbox',wf.id).length===1,{state:wf.state,sqlOutbox:s.store.jobs().length,entityOutbox:s.store.list('outbox',wf.id).length});
 const ws=s.store.list('workspace',wf.id)[0];record('R03',resolve(ws.root)===resolve(repo)&&ws.owned,{workspace_mode:wf.workspace_mode,rootEqualsSource:resolve(ws.root)===resolve(repo),owned:ws.owned});
 const spec=s.store.list('execution_spec',wf.id)[0];record('R04',spec.plannerProfile.adapterId==='agy'&&spec.executorProfile.adapterId==='agy',{requested:['codex','claude-code'],actual:[spec.plannerProfile.adapterId,spec.executorProfile.adapterId],mode:spec.mode});
 const dup=await app.inject({method:'POST',url:'/api/workflows',headers,payload:{...input,request_text:'Entirely different requirement'}});
 record('R05',dup.statusCode===200&&dup.json().workflow?.id===wf.id,{http:dup.statusCode,is_existing:dup.json()?.is_existing,request:dup.json().workflow?.request});
 const quality=new QualityCoordinator(s.store);const review={workflow_id:'unrelated-workflow',run_id:'same-run',phase:'before_human',cycle:1,verdict:'changes_required',findings:[],repair_plan:[],function_impact:'none',plan_revision:99,feedback_cursor:0,reviewed_at:new Date().toISOString()};
 const actions=[1,2,3].map(()=>quality.evaluateReviewResult(wf.id,review));
 record('R06',actions[2].rejectionCount===3,{sameResultActions:actions.map(r=>r.action),rejections:actions.map(r=>r.rejectionCount),workflowPhase:s.engine.get(wf.id).state});
 const issue=await app.inject({method:'POST',url:`/api/workflows/${wf.id}/issues`,headers,payload:{description:'Synthetic unfixed issue'}});
 const confirm=await app.inject({method:'POST',url:`/api/workflows/${wf.id}/issues/${issue.json().issue_id}/confirm`,headers,payload:{passed:'false'}});
 record('R07',confirm.statusCode===200&&confirm.json().status==='confirmed',{withoutFix:true,passedInput:'false',result:confirm.json().status});
 const aside=new AsideSessionService(s.store);const q1=aside.submitQuestion(wf.id,'one'),q2=aside.submitQuestion(wf.id,'two'),q3=aside.submitQuestion(wf.id,'three');aside.cancelSession(wf.id,q2.id);
 const active=s.store.list('aside_session',wf.id).filter(q=>q.status==='active').length;
 const another=aside.submitQuestion('another-workflow','other');record('R08',active===2&&another.status==='active',{activeInSameWorkflow:active,secondWorkflow:another.status,outboxJobs:s.store.jobs().length});
 aside.promoteToFormalFeedback(wf.id,q1.id,'same');aside.promoteToFormalFeedback(wf.id,q1.id,'same');record('R09',s.store.list('feedback_message',wf.id).length===2,{duplicateFormalMessages:s.store.list('feedback_message',wf.id).length});
 writeFileSync(join(repo,'visible.txt'),'visible');const candidates=Ref.searchReferences(repo,'visible');
 record('R10',candidates.items[0]?.relative_path===undefined,{item:candidates.items[0],expectedKeys:['ref_id','repo_id','relative_path','kind']});
 const preview=Ref.readTextPreview(repo,'../outside/marker.txt');symlinkSync(outside,join(repo,'external-link'),'junction');const linked=Ref.resolveReference(repo,'main','external-link/marker.txt');
 record('R11',preview.text==='SYNTHETIC_REVIEW_MARKER'&&linked.availability==='available',{traversalRead:preview.text,linkedAvailability:linked.availability});
 const adapter=new CodexNativeAdapter();const profile={id:'profile',revision:1,adapterId:'codex',executableRef:process.execPath,modelSelection:'native-config',options:{}};const capability=await adapter.probe({toolProfile:profile});
 record('R12',capability.available&&capability.capabilities.structuredToolFacts,{available:capability.available,fingerprintMismatch:capability.unsupportedReason,claimed:capability.capabilities});
 const ctx={workflowId:wf.id,runId:'audit-run',stage:'quality_review',epoch:1,workspaceRoots:{main:repo},allowedPaths:[],toolProfile:profile,handoffDocPath:join(repo,'HANDOFF.md'),purpose:'quality_review'};
 const resumed=await adapter.resume({...ctx,previousConversationId:'EXACT_OLD_SESSION'});const decoded=[...adapter.decode({stream:'stdout',data:'{"type":"tool_',timestamp:'1'}),...adapter.decode({stream:'stdout',data:'call","id":"x"}\n',timestamp:'2'})];
 record('R13',!resumed.args.includes('EXACT_OLD_SESSION')&&decoded.every(e=>e.type==='message'),{resumeArgs:resumed.args,readonlyFlagPresent:resumed.args.includes('read-only'),splitEventTypes:decoded.map(e=>e.type),facts:await adapter.readExecutionFacts({workflowId:wf.id,runId:'audit-run'})});
 const child=spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore',windowsHide:true});await new Promise(r=>child.once('spawn',r));
 const stop=await adapter.stop({jobId:'audit-only',pid:child.pid});record('R14',stop.stopped&&child.exitCode===null,{stopReported:stop.stopped,childStillRunning:child.exitCode===null});if(child.exitCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}
 const p={...plan('cfg','a'.repeat(40)),task_model:'native-v2'};const w={...wf,plan_revision:1,plan_hash:'ph',snapshot_id:'snap'};s.store.put('workflow',wf.id,w.project_id,w);s.store.put('plan',`${wf.id}-1`,wf.id,{plan:p});const reader=new CurrentDeliveryReader(s.store);
 record('R15',reader.inspectCurrentDelivery(wf.id).reason==='非 native-v2 工作流',{engineReadsPlan:s.engine.plan(wf.id).plan.task_model,readerReason:reader.inspectCurrentDelivery(wf.id).reason});
 s.store.put('plan',wf.id,wf.id,{plan:p});s.store.put('delivery_revision','audit-revision',wf.id,{id:'audit-revision',workflow_id:wf.id,plan_revision:1,plan_hash:'ph',snapshot_id:'snap',delivery_id:'audit-delivery',execution_finished:true,run_id:'missing-run',input_fingerprints:{main:'no-match'}});
 s.store.put('delivery','audit-delivery',wf.id,{id:'audit-delivery',status:'passed',report_hashes:{[join(root,'missing-report.json')]:'wrong'},manifest:{implementations:[]}});s.store.put('acceptance_result','audit-case',wf.id,{id:'audit-case',delivery_id:'audit-delivery',status:'passed'});
 s.store.put('workspace',ws.id,wf.id,{...ws,root:join(root,'missing-workspace')});const inspection=reader.inspectCurrentDelivery(wf.id);
 record('R16',inspection.valid,{missingWorkspace:true,missingRun:true,missingReport:true,valid:inspection.valid});
 const oldHome=process.env.HOME,oldUser=process.env.USERPROFILE;const fakeHome=join(root,'fake-home');process.env.HOME=fakeHome;process.env.USERPROFILE=fakeHome;
 try{const installation=new ClientInstaller(resolve('packages/skills')).installSkillsForClient('codex');record('R17',installation.mcpConfigured&&!existsSync(join(fakeHome,'.codex','config.toml'))&&!existsSync(join(fakeHome,'.codex','skills','devflow-plan','references','plan-contract.md')),{reportedMcp:installation.mcpConfigured,configExists:existsSync(join(fakeHome,'.codex','config.toml')),referenceCopied:existsSync(join(fakeHome,'.codex','skills','devflow-plan','references','plan-contract.md')),restoredBrowserSkill:installation.skillsInstalled.some(x=>x.skillName==='devflow-browser-accept')});}finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;if(oldUser===undefined)delete process.env.USERPROFILE;else process.env.USERPROFILE=oldUser;}
 const native={task_model:'native-v2',design_ref:{content_hash:'hash',summary:'design'},modules:[{id:'M',title:'m'}],work_items:[{id:'W',title:'work',paths:['app.txt']}],acceptance_items:[{id:'A',work_item_ids:['W'],layer:'unit',scenario:'test',expected_outcome:'pass'}],scope:{allowed_paths:['app.txt']},baselines:{main:'a'.repeat(40)},project_config_hash:'cfg'};
 const compact=NativePlanSchema.parse(native);let rejected=false;try{validatePlan(compact)}catch{rejected=true}record('R18',rejected,{nativeSchemaAccepted:true,productionValidatorRejected:rejected});
 // A real temporary repository demonstrates pre-existing staged changes leaking
 // into GitDeliveryCoordinator's unrestricted git commit. Override only its
 // already-reviewed delivery lookup; no real user repository is modified.
 const gitRoot=join(root,'git-case');mkdirSync(gitRoot);const git=(args)=>execFileSync('git',args,{cwd:gitRoot,encoding:'utf8',windowsHide:true}).trim();
 git(['init','-b','audit']);git(['config','user.name','DevFlow Review']);git(['config','user.email','review@example.invalid']);writeFileSync(join(gitRoot,'task.txt'),'before');writeFileSync(join(gitRoot,'user.txt'),'before');git(['add','.']);git(['commit','-m','baseline']);
 writeFileSync(join(gitRoot,'user.txt'),'UNRELATED_STAGED');git(['add','user.txt']);writeFileSync(join(gitRoot,'task.txt'),'task after');const gw={...w,id:'wf-git-audit',workspace_mode:'existing_workspace'};s.store.put('workflow',gw.id,gw.project_id,gw);s.store.put('workspace','ws-git',gw.id,{id:'ws-git',workflow_id:gw.id,repo_id:'main',root:gitRoot,common_dir:join(gitRoot,'.git'),branch:'audit',owned:false});
 const gd=new GitDeliveryCoordinator(s.store,root);gd.currentDeliveryReader={requireValidDelivery:()=>({delivery:{manifest:{implementations:[{repo_id:'main',path:'task.txt'}]}}})};const receipt=await gd.executeDelivery(gw.id);const committed=git(['diff-tree','--no-commit-id','--name-only','-r','HEAD']).split('\n');record('R19',committed.includes('user.txt'),{committedFiles:committed,candidateIsSha:/^[a-f0-9]{40,64}$/.test(receipt.integrations[0].candidate_commit)});
 const absentCleanup=await gd.cleanupWorkspaces('wf-clean-audit',[{id:'none',workflow_id:'wf-clean-audit',repo_id:'main',root:join(root,'already-removed'),common_dir:join(gitRoot,'.git'),branch:'temp',owned:true}]);record('R20',!absentCleanup.worktree_removed&&!absentCleanup.branch_deleted,{cleanup:absentCleanup,stateRecorded:s.store.get('workflow','wf-clean-audit')?.state??null});
}finally{await app.close();s.store.close();}
const report={audited_at:new Date().toISOString(),isolation_root:root,results,reproduced:results.filter(r=>r.defect_reproduced).length};
writeFileSync(new URL('./reproductions.json',import.meta.url),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));