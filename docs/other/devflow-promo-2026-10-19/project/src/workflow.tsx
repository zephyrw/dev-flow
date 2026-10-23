import React from 'react';
import {Img,staticFile,useCurrentFrame} from 'remotion';
import {C,ease,p,Rise,Shell} from './theme';
import timing from './audio-timing.json';

const beat=(n:number)=>Math.round(n*timing.period*30);
export const STEPS=[
 {title:'调研计划',short:'调研计划',role:'规划模型',owner:'planner',tool:'Codex',beat:48,page:'08-research',lines:['调研代码，明确目标与范围','制定实施步骤与验收标准']},
 {title:'人工审批',short:'人工审批',role:'人工决策',owner:'human',tool:'由你决定',beat:60,page:'09-approval',lines:['确认计划与实施边界','批准后，再开始开发']},
 {title:'开发实施',short:'开发实施',role:'执行模型',owner:'executor',tool:'Agy',beat:68,page:'10-implement',lines:['按照已批准的计划开发','保留任务上下文与进度']},
 {title:'自动测试',short:'自动测试',role:'执行模型',owner:'executor',tool:'Agy',beat:80,page:'11-tests',lines:['完成类型检查、构建与测试','修复相关问题，再次测试']},
 {title:'验收前质量审查',short:'验收前\n质量审查',role:'复核模型',owner:'reviewer',tool:'Codex',beat:92,page:'12-pre-review',lines:['检查代码质量与遗漏','有问题，安排修复与自测']},
 {title:'人工验收',short:'人工验收',role:'人工决策',owner:'human',tool:'由你决定',beat:104,page:'13-acceptance',lines:['实际操作，验证功能','功能问题修复后，再验收']},
 {title:'验收后代码复核',short:'验收后\n代码复核',role:'复核模型',owner:'reviewer',tool:'Codex',beat:112,page:'14-final-review',lines:['功能确认后，复核最终代码','有问题先修复，再交执行测试']},
 {title:'本地提交',short:'本地提交',role:'规划模型',owner:'planner',tool:'Codex',beat:124,page:'15-commit',lines:['实际执行 git commit','仅提交本任务改动']},
] as const;
export const STEP_STARTS=STEPS.map(s=>beat(s.beat)-beat(48));
const CHAPTERS=[
 {title:'规划与审批',steps:[0,1]},
 {title:'开发与检查',steps:[2,3,4]},
 {title:'验收与提交',steps:[5,6,7]},
] as const;
const roleColor=(owner:typeof STEPS[number]['owner'],accent:string)=>({planner:accent,executor:'#087e95',reviewer:'#7550bd',human:'#047857'}[owner]);
const tex=(s:string)=>staticFile('textures/'+s+'.png');
export const CONFIG_DEFAULTS={title:'工具与模型，由你搭配。',planner:'GPT-6 Astra',executor:'Gemini 3.8 Flash',reviewer:'GPT-6 Astra',accent:C.blue};
export const ModelConfig:React.FC<Partial<typeof CONFIG_DEFAULTS>>=(props)=>{
 const v={...CONFIG_DEFAULTS,...props},f=useCurrentFrame();
 return <Shell><Rise start={-24} style={{position:'absolute',left:110,top:82,fontSize:84,fontWeight:750,letterSpacing:'-.035em'}}>{v.title}</Rise>
 <Rise start={8} style={{position:'absolute',left:116,top:212,fontSize:60,color:v.accent}}>按角色自定义；以下是本片示例</Rise>
 <div style={{position:'absolute',left:120,top:340,width:970}}>{[['规划',v.planner,'Codex'],['执行',v.executor,'Agy'],['复核',v.reviewer,'跟随规划，也可单独指定']].map(([role,model,note],i)=><Rise key={role} start={18+i*14} style={{marginBottom:25,padding:'15px 0 18px 27px',borderLeft:`4px solid ${v.accent}`}}><div style={{fontSize:36,color:C.muted,marginBottom:9}}>{role} · {note}</div><div style={{fontSize:68,fontWeight:650,letterSpacing:'-.03em'}}>{model}</div></Rise>)}</div>
 <Rise start={24} style={{position:'absolute',left:1180,top:380,width:620,borderRadius:16,overflow:'hidden',boxShadow:'0 20px 60px #0f172a1c',border:`1px solid ${C.line}`}}><Img src={tex(f<177?'07-model-config-panel':'07-model-executor-panel')} style={{width:'100%',display:'block'}}/></Rise>
 <Rise start={68} style={{position:'absolute',left:120,top:928,fontSize:60,color:C.muted}}>按任务选择，按角色分工。</Rise>
 </Shell>;
};

export const OVERVIEW_DEFAULTS={title:'同一任务，三段接力。',subtitle:'八步分工明确，关键节点由你确认。',accent:C.blue};
export const Overview:React.FC<Partial<typeof OVERVIEW_DEFAULTS>>=(props)=>{
 const v={...OVERVIEW_DEFAULTS,...props},f=useCurrentFrame();
 return <Shell demo={false}><Rise start={-24} style={{position:'absolute',left:110,top:68,fontSize:84,fontWeight:750,letterSpacing:'-.035em'}}>{v.title}</Rise>
 <Rise start={8} style={{position:'absolute',left:116,top:198,fontSize:60,color:C.muted}}>{v.subtitle}</Rise>
 {CHAPTERS.map((chapter,i)=>{
  const x=110+i*575,start=18+i*22,q=p(f,start,24),ys=i===0?[478,728]:[478,675,872];
  return <React.Fragment key={chapter.title}>
   <div data-overview-chapter={i+1} style={{position:'absolute',left:x,top:323,width:525,opacity:q,transform:`translateY(${(1-q)*18}px)`}}><div style={{fontSize:60,fontWeight:700,letterSpacing:'-.035em'}}>{chapter.title}</div><div style={{height:1,background:C.line,marginTop:24}}/></div>
   {i<2&&<svg width="54" height="42" viewBox="0 0 54 42" style={{position:'absolute',left:x+488,top:342,opacity:p(f,start+18,20)}}><path d="M3 21H45m-12-11 12 11-12 11" fill="none" stroke={C.light} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
   <div style={{position:'absolute',left:x+24,top:ys[0]+25,width:2,height:(ys.at(-1)!-ys[0]-25)*p(f,start+9,42),background:'#cbd5e1'}}/>
   {chapter.steps.map((idx,j)=>{const s=STEPS[idx],human=s.owner==='human',color=roleColor(s.owner,v.accent),t=p(f,start+7+j*13,24);return <div key={s.title} data-overview-step={idx+1} style={{position:'absolute',left:x,top:ys[j]-32,width:526,height:132,opacity:t,transform:`translateY(${(1-t)*20}px)`}}>
    {human&&<div style={{position:'absolute',left:-18,top:-14,right:-2,bottom:-2,borderRadius:18,background:'linear-gradient(90deg,#e3f4ec,#edf8f340)'}}/>}
    <div style={{position:'absolute',left:0,top:8,width:50,height:50,borderRadius:'50%',display:'grid',placeItems:'center',background:color,color:'#fff',fontSize:32,fontWeight:650,fontVariantNumeric:'tabular-nums'}}>{String(idx+1).padStart(2,'0')}</div>
    <div data-readable="narrative" style={{position:'absolute',left:78,top:0,fontSize:60,fontWeight:700,lineHeight:1.2,letterSpacing:'-.045em',whiteSpace:'nowrap'}}>{s.title}</div>
    <div data-readable="auxiliary" style={{position:'absolute',left:80,top:84,fontSize:36,fontWeight:600,color}}>{human?'由你确认':s.role}</div>
   </div>;})}
  </React.Fragment>;
 })}
 <Rise start={94} style={{position:'absolute',left:116,right:116,top:1004,borderTop:`1px solid ${C.line}`,paddingTop:16,fontSize:36,color:C.muted,display:'flex',justifyContent:'space-between'}}><span style={{color:v.accent}}>工具与模型可自定义</span><span>DevFlow 负责阶段衔接与状态展示</span></Rise></Shell>;
};

export const WORKFLOW_DEFAULTS={title:'模型接力，关键节点由你确认。',planner:'GPT-6 Astra',executor:'Gemini 3.8 Flash',reviewer:'GPT-6 Astra',accent:C.blue};
export const Workflow:React.FC<Partial<typeof WORKFLOW_DEFAULTS>>=(props)=>{
 const v={...WORKFLOW_DEFAULTS,...props},f=useCurrentFrame();
 const starts=STEP_STARTS,ins=starts.map(s=>s+7);
 const scroll=starts.slice(1).reduce((sum,s)=>sum+p(f,s,18,ease.swift),0);
 const current=Math.max(0,starts.filter(s=>f>=s+7).length-1);
 const currentChapter=current<2?0:current<5?1:2;
 const activeColor=roleColor(STEPS[current].owner,v.accent);
 const last=[...starts].reverse().find(s=>f>=s)??0;
 const line=f<last+10?1-p(f,last,6,ease.exit):p(f,last+10,16,ease.snappy);
 return <Shell><div style={{position:'absolute',left:100,top:74,fontSize:60,fontWeight:700}}>{v.title}</div>
 <div style={{position:'absolute',left:105,top:167,fontSize:36,color:C.muted}}>工具与模型可自定义 · 以下配置仅作演示</div>
 <div style={{position:'absolute',left:60,top:235,width:850,height:610,overflow:'hidden',maskImage:'linear-gradient(transparent,#000 2%,#000 98%,transparent)'}}>{Array.from({length:10},(_,j)=>j-1).map(i=>{const idx=Math.max(0,Math.min(7,i)),dist=Math.min(1,Math.abs(i-scroll));return <div key={i} style={{position:'absolute',left:12,top:75+(i-scroll)*500,width:820,height:460,overflow:'hidden',borderRadius:16,border:`1px solid ${C.line}`,background:'#fff',boxShadow:'0 15px 45px #0f172a1a',opacity:1-dist*.65,filter:`blur(${dist*3}px)`,transform:`scale(${1-dist*.06})`}}><Img src={tex(STEPS[idx].page)} style={{width:'100%',height:'100%',objectFit:'contain'}}/></div>;})}</div>
 <div style={{position:'absolute',left:910,top:539,width:66*line,height:2,background:activeColor}}/><div style={{position:'absolute',left:905,top:534,width:12,height:12,borderRadius:6,background:activeColor,opacity:line}}/>
 <div style={{position:'absolute',left:1020,top:272,fontSize:36,color:C.muted}}><span style={{color:activeColor,fontWeight:700}}>{String(current+1).padStart(2,'0')} / 08</span><span style={{marginLeft:35}}>{STEPS[current].role}{STEPS[current].owner!=='human'?' · 本片示例':''}</span></div>
 <div style={{position:'absolute',left:1010,top:386,width:830,height:308}}><div style={{height:154,lineHeight:'154px',fontSize:68,fontWeight:600,color:C.muted,letterSpacing:'-.03em'}}>DevFlow</div><div style={{position:'relative',height:154,overflow:'hidden'}}>{STEPS.map((s,i)=>{const po=i<7?p(f,starts[i+1],8,ease.exit):0;if(f<ins[i]||po>=1)return null;return <div key={s.title} style={{position:'absolute',inset:0,display:'flex',fontSize:82,fontWeight:750,color:roleColor(s.owner,v.accent),letterSpacing:'-.05em',transform:`translateY(${-po*154}px)`}}>{[...s.title].map((c,j)=>{const q=p(f,ins[i]+j*1.2,16,ease.snappy);return <span key={j} style={{lineHeight:'154px',transform:`translateY(${(1-q)*154}px)`}}>{c}</span>;})}</div>;})}</div></div>
 {STEPS.map((s,i)=>{const q=p(f,ins[i]+6,14,ease.snappy)*(1-(i<7?p(f,starts[i+1],7,ease.exit):0));const model=s.owner==='human'?'由你确认':v[s.owner];return <div key={s.title} style={{position:'absolute',left:1016,top:704,width:835,opacity:q,transform:`translateY(${(1-q)*14}px)`}}><div style={{fontSize:64,fontWeight:650,letterSpacing:'-.025em'}}>{model}<span style={{fontSize:36,color:C.muted,fontWeight:400,marginLeft:24}}>{s.owner!=='human'?s.tool:''}</span></div><div style={{fontSize:60,color:C.muted,marginTop:24,lineHeight:1.34,letterSpacing:'-.04em'}}>{s.lines.map(l=><div key={l} style={{whiteSpace:'nowrap'}}>{l}</div>)}</div></div>;})}
 <div style={{position:'absolute',left:100,top:904,display:'flex',gap:36}}>{CHAPTERS.map((chapter,i)=><div key={chapter.title} data-workflow-chapter={i+1} style={{width:235,color:i===currentChapter?v.accent:C.muted,fontSize:36,fontWeight:i===currentChapter?700:400}}><div style={{height:3,marginBottom:16,background:i===currentChapter?v.accent:C.line}}/>{chapter.title}</div>)}</div>
 <div style={{position:'absolute',left:100,top:990,fontSize:36,color:C.muted}}>同一任务，持续衔接</div>
 </Shell>;
};
