import {mkdir, writeFile,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const projectDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(projectDir,'..');
const repo=resolve(projectDir,'../../../..');
const {chromium}=createRequire(resolve(repo,'package.json'))('@playwright/test');
console.log('capture: playwright loaded');
const browserExecutable=process.env.DEVFLOW_CAPTURE_BROWSER || 'C:/Users/yckj4798/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const browser=await chromium.launch({headless:true,executablePath:browserExecutable,timeout:20000});
console.log('capture: browser ready');
const context=await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:process.argv.includes('--account-hi')?4:2,locale:'zh-CN',timezoneId:'Asia/Shanghai'});
const page=await context.newPage();
const errors=[]; const requests=[];
page.on('pageerror',e=>errors.push(e.message));
await mkdir(resolve(out,'.tmp/styleframes'),{recursive:true});
if(process.argv.includes('--styleframes')){
 await page.goto(pathToFileURL(resolve(projectDir,'styleframes.html')).href);
 console.log('capture: styleframes loaded');
 await page.evaluate(()=>document.fonts.ready);
 for(const name of ['brand','roles','quotas']) await page.locator('#'+name).screenshot({path:resolve(out,'.tmp/styleframes',name+'.png')});
 console.log(JSON.stringify({styleframes:3,errors})); await browser.close(); process.exit();
}
const stamp='2026-10-19T04:00:00.000Z';
const revision2=process.argv.includes('--workflow-v2');
await page.clock.install({time:new Date(stamp)});
const planner={id:'demo-planner',revision:1,adapterId:'codex',executableRef:'codex',modelSelection:'explicit',modelId:'gpt-6-astra',reasoning:{mode:'explicit',value:'high'},options:{}};
const executor={...planner,id:'demo-executor',adapterId:'agy',executableRef:'agy',modelId:'gemini-3.8-flash-high'};
const proj={id:'demo-crm',name:'客户管理 · 演示项目',repositories:[{id:'main',path:'/demo/customer-app'}],commands:[],services:[],browser_scenes:[],data:{mode:'directory'}};
let phase=revision2?'research':'plan'; let accountState='normal';
const wf=()=>({id:'demo-owner-filter',project_id:proj.id,title:revision2?'开发任务 · 工作流演示':'为客户列表增加负责人筛选',state:phase==='research'?'PLANNING':phase==='plan'?'PLAN_PENDING':phase==='review'||phase==='final-review'?'REVIEWING':phase==='accept'?'HUMAN_PENDING':phase==='commit'?'COMMITTING':'EXECUTING',stage:phase==='review'||phase==='final-review'?'review':'execute',version:1,plan_revision:1,environment_revision:1,feedback:[],created_at:stamp,updated_at:stamp});
const planText=`# 客户列表负责人筛选\n\n## 背景与目标\n\n销售团队需要快速查看自己负责的客户。目前客户列表只能按名称搜索，跨负责人查找耗时。本次增加负责人筛选，让用户选定负责人后只查看相应客户，并保留现有的关键字与状态筛选。\n\n## 总体思路\n\n复用现有客户列表与负责人数据，保持界面布局简洁。前端传递选中的负责人，后端按当前用户权限过滤。切换筛选时回到第一页，清空筛选后恢复全部可见客户。\n\n## 开发安排\n\n### 1. 明确查询边界\n\n负责人筛选与关键字、客户状态同时生效。只能查看有权限的客户；负责人为空时不增加额外限制。\n\n### 2. 完成前后端联动\n\n列表顶部增加负责人选择器；查询参数使用 ownerId。切换或清空负责人时重置分页。加载期间显示状态，失败时保留筛选条件并提供重试。\n\n### 3. 检查与自测\n\n完成类型检查、生产构建和相关测试。覆盖选择、清空、组合筛选、分页重置、无权限及空结果场景。\n\n## 验收标准\n\n- 选择负责人后仅展示该负责人名下的可见客户。\n- 切换负责人后回到第一页；清空后恢复全部可见客户。\n- 关键字和状态筛选继续有效。\n- 由你在真实界面验收功能，再进入最终交付。\n\n> 演示场景：文案与结果均为虚构数据。`;
const taskTitles=['负责人查询与权限过滤','筛选器与分页联动','组合筛选与异常场景自测'];
const tasks=taskTitles.map((title,i)=>({id:'T0'+(i+1),title,module_id:'customers',repo_id:'main',paths:['src/customers'],development_status:i<2?'completed':'in_progress',implementation_status:i<2?'completed':'in_progress',validation_status:i<2?'passed':'not_run'}));
const review={verdict:'changes_required',plan_revision:1,summary:'主流程已完成。发现一处分页边界问题，交回执行模型修复并自测。',findings:[{id:'R01',severity:'P2',path:'src/customers/CustomerList.tsx',trigger:'在第 3 页切换负责人',evidence:'负责人变化后仍沿用旧页码，可能出现空列表。',consequence:'用户可能误以为该负责人没有客户。',reason:'负责人变更时重置 page 为 1，并补充切换与清空筛选的回归测试。'}],unresolved_questions:[],repair_document:'## 整改要求\n\n沿用本任务和已批准计划，修复负责人变化时的分页重置。\n\n由 Gemini 3.8 Flash 完成代码修改与相关自测；功能由你验收。\n\n> 演示复核结论，不代表真实任务运行结果。'};
const detail=()=>({workflow:wf(),project:proj,tasks:phase==='plan'?tasks.map(t=>({...t,development_status:'pending',implementation_status:'pending',validation_status:'not_run'})):tasks,plan:{authority_ready:true,plan:{task_model:'native-v2',markdown:planText,modules:[{id:'customers',title:'客户列表'}],tasks,tests:[]}},runs:[],events:[],evidence:[],runtime:null,attention:null,workspaces:[],history_cursor:0,planner_profile:planner,executor_profile:executor,review:phase==='review'?review:null,test_progress:{total:6,passed:phase==='plan'?0:4,failed:0,cases:[]},environment:null});
const realm=()=>({realm_id:'demo',revision:1,control_generation:1,auth_epoch:1,active_account_id:accountState==='after'?'demo-b':'demo-a',service_state:'running',desired_enabled:true,phase:'idle'});
const accounts=()=>['a','b','c'].map((id,i)=>({id:'demo-'+id,realm_id:'demo',revision:1,alias:['开发账号 01','开发账号 02','开发账号 03'][i],identity:{email:`developer-${i+1}@example.com`,verified_at:stamp},state:accountState!=='normal'&&i===0?'waiting_quota':'ready',enrolled_at:stamp,enrollment_completed_at:stamp,auth:{has_refresh_credential:true,metadata_status:'verified',refresh_expiry_source:'not_provided'}}));
const snapshots=()=>['a','b','c'].flatMap((id,i)=>['Gemini Models','Claude and GPT models'].map((pool,j)=>({id:`q-${id}-${j}`,realm_id:'demo',account_id:'demo-'+id,auth_epoch:1,pool_id:pool,model_ids:[j?'gpt-6-astra':'gemini-3.8-flash-high'],source:'official_cli_usage',cli_version:'5.5',parser_revision:1,capability_verified:true,observed_at:stamp,windows:[{kind:'weekly',duration_minutes:10080,remaining_fraction:[[.62,.48],[.82,.75],[.55,.67]][i][j],reset_at:'2026-10-23T04:00:00.000Z',observed_at:stamp,status:'observed'},{kind:'five_hour',duration_minutes:300,remaining_fraction:accountState!=='normal'&&i===0&&j===0?0:[[.74,.68],[.96,.89],[.80,.72]][i][j],reset_at:'2026-10-19T08:00:00.000Z',observed_at:stamp,status:'observed'}]})));
const accountView=()=>({accounts:accounts(),snapshots:snapshots(),realm:realm(),settings:{revision:1},automation:{enabled:true,service_state:'running',can_toggle:true},capability:{supported:true},selection_context:{model_id:null,category:'mixed',categories:['gemini','other'],source:'active_category',required_pool_ids:['Gemini Models','Claude and GPT models']}});
const operation=()=>accountState==='switching'?[{operation_id:'demo-auto-switch',revision:1,kind:'switch',phase:'selecting',quota_trigger:{account_id:'demo-a',auth_epoch:1,pool_id:'Gemini Models',window:'five_hour',observed_at:stamp,event_seq:1,source:'official_cli_usage'},selected_quota:{weekly:.82,five_hour:.96}}]:[];
const spec={id:'demo-spec',workflow_id:'demo-owner-filter',revision:1,plannerProfile:planner,executorProfile:executor,roleOverrides:{reviewer:{mode:'inherit'},review_fixer:{mode:'inherit'},functional_fixer:{mode:'inherit'}},mode:'dual_tool',template_id:'native-development',template_revision:1,created_at:stamp};
function response(path){
 if(path.endsWith('/repair-batches'))return[];
 if(path.endsWith('/agy-account-policy'))return{revision:1,auto_switch:true,allowed_account_ids:[],recreation_policy:'ask',night_pool:{enabled:false,account_ids:[]}};
 if(path.startsWith('/api/model-access/'))return{status:'verified',message:'演示状态'};
 if(path==='/api/health')return{ok:true,mode:'workbench'};
 if(path==='/api/projects')return[proj];
 if(path==='/api/workflows')return[wf()];
 if(path.endsWith('/user-interactions/current'))return{interaction:null};
 if(path.startsWith('/api/agy-accounts'))return path.endsWith('/service')?{...realm(),automation:{enabled:true,service_state:'running',can_toggle:true},operations:operation()}:accountView();
 if(/\/(asides|functional-issues|functional-issue-views|diff|feedback|guidance)$/.test(path))return[];
 if(path.endsWith('/history'))return{events:[],cursor:0,has_more:false,runs:[]};
 if(path.endsWith('/execution-spec'))return{spec,spec_revision:1,workflow_version:1,policy_version:2,can_edit:true};
 if(path.includes('model-defaults'))return{defaults:{revision:1,plannerProfile:planner,executorProfile:executor,roleOverrides:spec.roleOverrides}};
 if(path.includes('/model-tools')){
 const adapter=path.includes('agy')?'agy':'codex';const model=adapter==='agy'?'gemini-3.8-flash-high':'gpt-6-astra';
 const entry={key:model,entryId:adapter+'/'+model,adapterId:adapter,nativeId:model,label:adapter==='agy'?'Gemini 3.8 Flash':'GPT-6 Astra',selectionKind:'fixed',hidden:false,discoveredAt:stamp,capabilityRevision:'demo',availability:'available',source:'native',effort:{kind:'enum',values:['high'],defaultValue:'high'}};
 return path.endsWith('/model-tools')?[{id:'codex',label:'Codex',available:true},{id:'agy',label:'Agy',available:true}]:{entries:[entry],catalog:{entries:[entry]}};
 }
 const d=detail();
 if(revision2){
  d.business_progress={index:({research:0,plan:1,execute:2,test:3,review:4,accept:5,'final-review':6,commit:7})[phase],activity:phase==='review'?'quality_before_human':phase==='final-review'?'quality_after_human':phase==='commit'?'planner_commit':phase==='test'?'testing':phase==='accept'?'human_acceptance':phase};
  d.human_accepted=phase==='final-review'||phase==='commit';
  d.plan.plan.markdown='# 开发计划\n\n## 目标与范围\n\n调研现有代码与需求，明确本任务的实施边界、交付内容和验收标准。确认方案后，由执行模型按批准计划开发。\n\n## 实施安排\n\n### 1. 开发实施\n\n完成本任务相关代码与必要的联动，持续记录进度；不扩大批准范围。\n\n### 2. 自动测试\n\n由执行模型分别完成类型检查、生产构建与受影响测试，修复相关问题并重测。\n\n### 3. 质量审查与人工验收\n\n验收前审查代码质量；通过后由用户实际操作验收。功能问题修复后回到人工验收。\n\n### 4. 最终复核与本地提交\n\n功能确认后复核最终代码；有问题先修复，再交执行模型测试。最后由规划模型实际执行本地 git commit，仅提交本任务改动。\n\n## 验收标准\n\n- 实现与批准计划的目标和范围一致。\n- 用户实际验证功能，明确确认结果。\n- 代码问题完成修复，必要检查由执行模型完成。\n\n> 虚构演示任务，仅用于介绍工作流。';
  d.plan.plan.modules=[{id:'customers',title:'本任务实现'}];
  d.tasks=d.tasks.map((t,i)=>({...t,title:['完成本任务代码实现','补齐相关联动与边界处理','运行类型检查、构建与相关测试'][i],development_status:['plan','research'].includes(phase)?'pending':phase==='execute'&&i===2?'in_progress':'completed',implementation_status:['plan','research'].includes(phase)?'pending':phase==='execute'&&i===2?'in_progress':'completed',validation_status:phase==='test'?'passed':t.validation_status}));
  d.plan.plan.tasks=d.tasks;
  d.test_progress={total:6,passed:['plan','research','execute'].includes(phase)?0:6,failed:0,cases:['输入边界处理','异常返回处理','接口参数联动','数据一致性','主流程操作','交互异常提示'].map((title,i)=>({id:'check-'+(i+1),title,layer:['unit','unit','integration','integration','e2e','e2e'][i],status:'passed',result:'passed',scenario:title,report_source:'executor_report',summary:title+' · 虚构演示',task_ids:['T03'],evidence_ids:[]}))};
  if(phase==='review'||phase==='final-review')d.review={...review,verdict:'passed',summary:phase==='review'?'验收前质量审查：已审查本任务代码质量、遗漏与边界处理。当前未发现必须修改项，可交用户实际验收。':'验收后代码复核：用户已确认功能，已复核最终代码质量。当前未发现必须修改项，可进入本地提交。',findings:[],repair_document:'> 演示复核结论，不代表真实任务执行结果。'};
  if(phase==='accept')d.acceptance_handoff={summary:'## 由你实际验收\n\n按批准计划中的场景实际操作，确认目标功能与异常处理符合要求。\n\n发现功能问题可反馈给执行模型，修复和测试后再由你验收。\n\n> 页面为虚构演示。'};
 }
 return d;
}
await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;requests.push({path,method:route.request().method(),fulfilledLocally:true});return route.fulfill({json:response(path)});});
await page.routeWebSocket('**/api/notifications',()=>{});
await page.routeWebSocket('**/api/events?*',()=>{});
await page.addInitScript(()=>{localStorage.setItem('devflow.first_run_completed','true');sessionStorage.setItem('devflow.tab.demo-owner-filter','plan');});
const textures=resolve(projectDir,'public/textures');await mkdir(textures,{recursive:true});
const layout={viewport:{width:1920,height:1080},deviceScaleFactor:2,data:'fictional',source:'real DevFlow frontend, all API and WebSocket requests intercepted',pages:{}};
async function capture(name,parts={}){
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(750);
 await page.evaluate(()=>{if(!document.querySelector('#promo-demo-label')){const e=document.createElement('div');e.id='promo-demo-label';e.textContent='演示数据 · 仅用于产品介绍';e.style.cssText='position:fixed;bottom:12px;left:18px;z-index:2147483647;padding:5px 9px;border-radius:5px;background:#0f172acc;color:white;font:12px Microsoft YaHei;pointer-events:none';document.body.append(e);}});
 await page.screenshot({path:resolve(textures,name+'.png'),fullPage:true});
 const record={pageH:await page.evaluate(()=>Math.max(innerHeight,document.documentElement.scrollHeight)),parts:{}};
 for(const [key,sel] of Object.entries(parts)){
 const el=page.locator(sel).first();if(await el.count()&&await el.isVisible()){const b=await el.boundingBox();record.parts[key]={x:b.x,y:b.y,w:b.width,h:b.height};await el.screenshot({path:resolve(textures,`${name}-${key}.png`)});}
 }
 layout.pages[name]=record;console.log(name,JSON.stringify(record));
}
if(process.argv.includes('--account-hi')){
 await page.goto('http://localhost:4810/accounts');await page.locator('.agy-account-row').first().waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(750);
 await page.locator('.agy-account-row').first().screenshot({path:resolve(textures,'04-accounts-first-account-hi.png')});
 const saved=JSON.parse(await readFile(resolve(textures,'layout.json'),'utf8'));saved.highResolutionAccount={file:'04-accounts-first-account-hi.png',deviceScaleFactor:4};await writeFile(resolve(textures,'layout.json'),JSON.stringify(saved,null,2));
 await writeFile(resolve(out,'.tmp/capture-hi-check.json'),JSON.stringify({errors,requestCount:requests.length,allBusinessRequestsIntercepted:requests.every(r=>r.fulfilledLocally)},null,2));
 console.log(JSON.stringify({highResolutionAccount:true,errors,requests:requests.length}));await browser.close();process.exit(errors.length?1:0);
}
if(revision2){
 await page.goto('http://localhost:4810/?workflow=demo-owner-filter');
 await page.getByRole('heading',{name:'开发计划',exact:true,level:1}).waitFor({timeout:20000});
 await capture('08-research',{'plan':'.plan-panel'});
 phase='plan';await page.reload();await page.getByRole('button',{name:/规划模型：/}).waitFor();
 await page.getByRole('button',{name:/规划模型：/}).click();
 await page.getByRole('dialog',{name:'工具与模型',exact:true}).waitFor();
 await capture('07-model-config',{'panel':'[role="dialog"]'});
 await page.getByRole('dialog',{name:'工具与模型',exact:true}).getByRole('tab',{name:'执行',exact:true}).click();
 await capture('07-model-executor',{'panel':'[role="dialog"]'});
 await page.getByRole('dialog',{name:'工具与模型',exact:true}).getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'批准当前计划',exact:true}).click();
 await page.getByRole('heading',{name:'批准执行计划',exact:true}).waitFor();
 await capture('09-approval',{'dialog':'[role="dialog"]'});
 for(const [state,name,tab] of [['execute','10-implement','任务进度'],['test','11-tests','测试进度'],['review','12-pre-review','代码复核'],['accept','13-acceptance','概览'],['final-review','14-final-review','代码复核'],['commit','15-commit','任务进度']]){
  phase=state;await page.reload();
  const button=page.getByRole('button',{name:tab,exact:true});await button.waitFor({timeout:20000});await button.click();
  if(state==='test')await page.locator('details.test-layer-module summary').first().click();
  if(state==='review'||state==='final-review')await page.locator('.review-results').waitFor();
  await capture(name,{'main':state==='review'||state==='final-review'?'.review-results':state==='accept'?'section.panel[aria-label="人工验收"]':'.workflow-main-column'});
 }
 await writeFile(resolve(textures,'layout-v2.json'),JSON.stringify(layout,null,2));
 await writeFile(resolve(out,'capture-v2-check.json'),JSON.stringify({errors,requestCount:requests.length,allBusinessRequestsIntercepted:requests.every(r=>r.fulfilledLocally),requests},null,2));
 console.log(JSON.stringify({revision:2,errors,pages:Object.keys(layout.pages)}));await browser.close();process.exit(errors.length?1:0);
}
await page.goto('http://localhost:4810/?workflow=demo-owner-filter');
await page.getByRole('heading',{name:'客户列表负责人筛选',exact:true}).waitFor({timeout:20000});
await capture('01-planning',{'plan':'.plan-panel','models':'.current-runtime','flow':'.workflow-header'});
phase='execute';await page.reload();await page.getByRole('button',{name:'任务进度',exact:true}).click();
await capture('02-execution',{'main':'.workflow-main-column','models':'.current-runtime'});
phase='review';await page.reload();await page.getByRole('button',{name:'代码复核',exact:true}).click();
await page.locator('.review-results').waitFor();await capture('03-review',{'review':'.review-results'});
await page.goto('http://localhost:4810/accounts');await page.locator('.agy-account-row').first().waitFor();
await capture('04-accounts',{'panel':'.agy-minimal-panel','first-account':'.agy-account-row','switch':'.agy-top-control-bar','gemini':'.agy-quota-group[data-category="gemini"]','other':'.agy-quota-group[data-category="other"]'});
accountState='switching';await page.reload();await page.locator('.agy-active-op-card').waitFor();
await capture('05-switching',{'panel':'.agy-minimal-panel','operation':'.agy-active-op-card'});
accountState='after';await page.reload();await page.locator('.agy-account-row').first().waitFor();
await capture('06-switched',{'panel':'.agy-minimal-panel'});
await writeFile(resolve(textures,'layout.json'),JSON.stringify(layout,null,2));
await writeFile(resolve(out,'.tmp/capture-check.json'),JSON.stringify({errors,requestCount:requests.length,allBusinessRequestsIntercepted:requests.every(r=>r.fulfilledLocally),requests},null,2));
console.log(JSON.stringify({errors,requestCount:requests.length,output:textures}));
await browser.close();if(errors.length)process.exitCode=1;
