import React from 'react';
import {AbsoluteFill,Img,staticFile,useCurrentFrame} from 'remotion';
import {C,ease,Logo,p,Rise,Shell,Label,FONT} from './theme';
import {PageCam} from './lib/PageCam';
const tex=(s:string)=>staticFile('textures/'+s+'.png');
const imgStyle:React.CSSProperties={display:'block',width:'100%',height:'100%',objectFit:'cover'};
export const BRAND_DEFAULTS={lead:'让模型，',title:'各司其职。',subtitle:'轻量化模型调度工作流',accent:C.blue,fontSize:136};
export const Brand:React.FC<Partial<typeof BRAND_DEFAULTS>>=(props)=>{const v={...BRAND_DEFAULTS,...props};const f=useCurrentFrame();
 return <Shell demo={false}><div style={{position:'absolute',left:120,top:110}}><Logo/></div>
 <div style={{position:'absolute',left:120,top:280,fontSize:v.fontSize,fontWeight:750,letterSpacing:'-.055em',lineHeight:1.23}}>
 {[v.lead,v.title].map((t,i)=>{const chunks=i===0?[t.slice(0,1),t.slice(1)]:[t.slice(0,2),t.slice(2)];return <div key={i} style={{color:i?v.accent:C.ink}}>{chunks.map((s,j)=>{const q=p(f,10+i*20+j*4,i?30:22);return <span key={j} style={{display:'inline-block',opacity:q,transform:`translateY(${(1-q)*64}px)`,filter:`blur(${(1-q)*18}px)`}}>{s}</span>;})}</div>;})}</div>
 <div style={{position:'absolute',left:125,top:695,fontSize:60,fontWeight:600}}>{[v.subtitle.slice(0,3),v.subtitle.slice(3,7),v.subtitle.slice(7)].map((s,i)=>{const q=p(f,48+i*2.4,20);return <span key={i} style={{display:'inline-block',opacity:q,transform:`translateY(${(1-q)*26}px)`,filter:`blur(${(1-q)*9}px)`}}>{s}</span>;})}</div>
 <Rise start={62} style={{position:'absolute',left:128,top:800,fontSize:34,color:C.muted}}>模型可自定义 · 人工审批与验收</Rise>
 <svg width="640" height="600" viewBox="0 0 640 600" style={{position:'absolute',right:100,top:265,opacity:p(f,32,30)}}>
 <path d="M 115 120 L 480 285 L 115 455" fill="none" stroke={C.line} strokeWidth="3"/>
 <path d="M 115 120 L 480 285 L 115 455" fill="none" stroke={v.accent} strokeWidth="4" pathLength={1} strokeDasharray={1} strokeDashoffset={1-p(f,60,55)}/>
 {[[115,120],[480,285],[115,455]].map(([x,y],i)=><g key={i} opacity={p(f,44+i*14,22)}><circle cx={x} cy={y} r={48} fill="white" stroke={i===1?v.accent:C.line} strokeWidth="2"/><text x={x} y={y+12} textAnchor="middle" style={{fontSize:34,fontFamily:FONT,fontWeight:700,fill:i===1?v.accent:C.muted}}>{['01','02','03'][i]}</text></g>)}</svg></Shell>;
};
export const CASE_DEFAULTS={title:'一个需求，接力完成。',task:'给客户列表增加「负责人筛选」',accent:C.blue};
export const Case:React.FC<Partial<typeof CASE_DEFAULTS>>=(props)=>{const v={...CASE_DEFAULTS,...props};const f=useCurrentFrame();const q=p(f,4,26);
 return <Shell><Rise start={-24} style={{position:'absolute',left:120,top:82,fontSize:86,fontWeight:750,letterSpacing:'-.04em'}}>{v.title}</Rise><Rise start={10} style={{position:'absolute',left:125,top:209,fontSize:60,color:v.accent}}>{v.task}</Rise>
 <div style={{position:'absolute',left:120,top:317,width:1680,height:635,borderRadius:20,overflow:'hidden',boxShadow:'0 24px 70px #0f172a18',border:`1px solid ${C.line}`,opacity:q,transform:`translateY(${(1-q)*70}px)`}}>
 <div style={{width:1920,height:1080,transform:'scale(.875)',transformOrigin:'0 0'}}><PageCam src="textures/01-planning.png" pageH={1080} keys={[{frame:0,cx:960,cy:610,zoom:1,rotY:0},{frame:90,cx:1040,cy:470,zoom:1.14,rotY:0},{frame:235,cx:1040,cy:470,zoom:1.14,rotY:0}]}/></div></div>
 <div style={{position:'absolute',right:168,top:820,background:'white',border:`1px solid ${C.line}`,borderLeft:`5px solid ${v.accent}`,padding:'20px 30px',fontSize:60,boxShadow:'0 8px 28px #0f172a10',opacity:p(f,108,24)}}>先说清目标与验收标准</div></Shell>;
};
export const RELAY_DEFAULTS={title:'同一任务，按阶段选模型',planner:'GPT-6 Astra',executor:'Gemini 3.8 Flash',reviewer:'GPT-6 Astra',accent:C.blue};
const switches=[0,236,472], inAt=switches.map(x=>x+7);
export const Relay:React.FC<Partial<typeof RELAY_DEFAULTS>>=(props)=>{const v={...RELAY_DEFAULTS,...props};const f=useCurrentFrame();
 const scroll=p(f,236,18,ease.swift)+p(f,472,18,ease.swift);
 const roles=['规划','执行','代码复核'];const models=[v.planner,v.executor,v.reviewer];
 const notes=['规划与拆解','开发与自测','审查代码质量'];
 const pages=['01-planning','02-execution','03-review'];const last=[...switches].reverse().find(s=>f>=s)??0;const line=f<last+10?1-p(f,last,6,ease.exit):p(f,last+10,16,ease.snappy);
 const current=Math.min(2,inAt.filter(s=>f>=s).length-1);
 return <Shell><div style={{position:'absolute',left:100,top:78,fontSize:57,fontWeight:700}}>{v.title}</div><Label style={{position:'absolute',left:1220,top:220}}>客户列表 · 负责人筛选</Label>
 <div style={{position:'absolute',left:70,top:156,width:1050,height:760,overflow:'hidden',maskImage:'linear-gradient(transparent,#000 1%,#000 99%,transparent)'}}>
 {[-1,0,1,2,3].map(i=>{const dist=Math.min(1,Math.abs(i-scroll));const idx=Math.max(0,Math.min(2,i));return <div key={i} style={{position:'absolute',left:8,top:119+(i-scroll)*590,width:1030,height:530,borderRadius:18,overflow:'hidden',border:`1px solid ${C.line}`,boxShadow:'0 15px 45px #0f172a1a',transform:`scale(${1-dist*.06})`,filter:`blur(${dist*3}px)`,opacity:1-dist*.65}}><Img src={tex(pages[idx])} style={imgStyle}/></div>;})}</div>
 <div style={{position:'absolute',left:1130,top:539,width:66*line,height:2,background:v.accent}}/>
 <div style={{position:'absolute',left:1125,top:534,width:12,height:12,borderRadius:6,background:v.accent,opacity:line}}/>
 <div style={{position:'absolute',left:1220,top:328,fontSize:34,color:C.light,fontVariantNumeric:'tabular-nums'}}><span style={{color:v.accent}}>{String(Math.max(0,current)+1).padStart(2,'0')}</span> / 03</div>
 <div style={{position:'absolute',left:1210,top:386,width:650,height:308}}>
 <div style={{height:154,lineHeight:'154px',fontSize:68,fontWeight:600,color:C.muted,letterSpacing:'-.03em'}}>DevFlow</div>
 <div style={{position:'relative',height:154,overflow:'hidden'}}>{roles.map((word,i)=>{const po=i<2?p(f,switches[i+1],8,ease.exit):0;if(f<inAt[i]||po>=1)return null;return <div key={word} style={{position:'absolute',inset:0,display:'flex',fontSize:100,fontWeight:750,color:f>switches[i+1]-10?C.light:v.accent,transform:`translateY(${-po*154}px)`}}>{[...word].map((c,j)=>{const q=p(f,inAt[i]+j*1.2,16,ease.snappy);return <span key={j} style={{lineHeight:'154px',transform:`translateY(${(1-q)*154}px)`}}>{c}</span>;})}</div>;})}</div></div>
 {models.map((m,i)=>{const q=p(f,inAt[i]+6,14,ease.snappy)*(1-(i<2?p(f,switches[i+1],7,ease.exit):0));return <div key={i} style={{position:'absolute',left:1216,top:722,opacity:q,transform:`translateY(${(1-q)*14}px)`}}><div style={{fontSize:60,fontWeight:650,letterSpacing:'-.025em'}}>{m}</div><div style={{fontSize:60,color:C.muted,marginTop:12,maxWidth:680,lineHeight:1.2}}>{notes[i]}</div></div>;})}
 <div style={{position:'absolute',left:100,right:100,bottom:85,borderTop:`1px solid ${C.line}`,paddingTop:14,fontSize:60,color:C.muted}}>你批准计划 · 验收功能</div></Shell>;
};
export const ACCOUNT_DEFAULTS={title:'把账号，管起来。',subtitle:'多个账号，一处管理',accent:C.blue};
export const Accounts:React.FC<Partial<typeof ACCOUNT_DEFAULTS>>=(props)=>{const v={...ACCOUNT_DEFAULTS,...props};const f=useCurrentFrame();const q=p(f,8,28);
 return <Shell><Rise start={-24} style={{position:'absolute',left:120,top:170,fontSize:125,fontWeight:750,color:v.accent,letterSpacing:'-.04em'}}>Agy</Rise><Rise start={10} style={{position:'absolute',left:120,top:340,fontSize:74,fontWeight:700}}>{v.title}</Rise>
 <Rise start={30} style={{position:'absolute',left:125,top:515,fontSize:60,color:C.muted,lineHeight:1.7}}>{v.subtitle}<br/>身份与状态，清楚可见</Rise><Rise start={72} style={{position:'absolute',left:125,top:762,fontSize:34,color:v.accent}}>导入账号 · 查看状态 · 设置活动账号</Rise>
 <div style={{position:'absolute',left:910,top:150,width:880,opacity:q,transform:`translateX(${(1-q)*110}px) perspective(1600px) rotateY(${(1-q)*-8}deg)`,borderRadius:16,overflow:'hidden',boxShadow:'0 25px 70px #0f172a16'}}><Img src={tex('04-accounts-panel')} style={{width:'100%',display:'block'}}/></div></Shell>;
};
export const QUOTA_DEFAULTS={title:'双额度，一眼看清。',weekly:'62',hourly:'74',accent:C.blue};
export const Quotas:React.FC<Partial<typeof QUOTA_DEFAULTS>>=(props)=>{const v={...QUOTA_DEFAULTS,...props};const f=useCurrentFrame();
 return <Shell><Rise start={-24} style={{position:'absolute',left:120,top:90,fontSize:88,fontWeight:750}}>{v.title}</Rise>
 {[[v.weekly,'周额度'],[v.hourly,'5 小时额度']].map(([n,l],i)=>{const q=p(f,12+i*8,30);return <div key={i} style={{position:'absolute',left:150+i*860,top:285,width:740,opacity:q,transform:`translateY(${(1-q)*45}px)`}}><div style={{fontSize:42,color:C.muted}}>{l}</div><div style={{fontSize:142,lineHeight:1.2,fontWeight:720,color:v.accent,fontVariantNumeric:'tabular-nums',letterSpacing:'-.06em'}}>{n}<span style={{fontSize:76,marginLeft:9}}>%</span><span style={{fontSize:35,color:C.muted,letterSpacing:0,marginLeft:24,fontWeight:400}}>剩余</span></div></div>;})}
 <div style={{position:'absolute',left:958,top:300,height:200,width:2,background:C.line}}/>
 <Rise start={40} style={{position:'absolute',left:120,top:570,width:1680,borderRadius:18,overflow:'hidden',boxShadow:'0 15px 40px #0f172a10'}}><Img src={tex('04-accounts-first-account-hi')} style={{width:'100%',display:'block'}}/></Rise>
 <Rise start={62} style={{position:'absolute',left:125,top:932,fontSize:60,color:C.muted}}>Gemini 与 Claude/GPT · 两池分别查看</Rise></Shell>;
};
export const SWITCH_DEFAULTS={title:'额度耗尽，自动接力。',subtitle:'按模型需求，选择可用账号',accent:C.blue};
export const Switch:React.FC<Partial<typeof SWITCH_DEFAULTS>>=(props)=>{const v={...SWITCH_DEFAULTS,...props};const f=useCurrentFrame();const active=f<90?0:f<170?1:2;const change=p(f,148,16,ease.swift);
 return <Shell><Rise start={-24} style={{position:'absolute',left:100,top:78,fontSize:86,fontWeight:750}}>{v.title}</Rise><Rise start={10} style={{position:'absolute',left:106,top:208,fontSize:60,color:C.muted}}>{v.subtitle}</Rise>
 <div style={{position:'absolute',left:110,top:348,width:645}}>{[['01','当前账号用尽','Gemini · 5 小时额度 0%'],['02','自动选择可用账号','综合周额度与 5 小时额度'],['03','恢复原任务','保留任务上下文']].map(([n,t,d],i)=><div key={n} style={{padding:'10px 0 12px 28px',borderLeft:`4px solid ${active>=i?v.accent:C.line}`,opacity:active>=i?1:.36,marginBottom:16}}><div style={{display:'flex',gap:16,alignItems:'baseline'}}><span style={{fontSize:34,color:v.accent}}>{n}</span><span style={{fontSize:60,fontWeight:650,whiteSpace:'nowrap'}}>{t}</span></div><div style={{fontSize:36,color:C.muted,marginTop:12}}>{d}</div></div>)}</div>
 <div style={{position:'absolute',left:860,top:330,width:940,height:600,borderRadius:16,overflow:'hidden',boxShadow:'0 18px 55px #0f172a14',background:'white'}}>
 <Img src={tex('05-switching-panel')} style={{position:'absolute',width:'100%',top:0,left:0}}/>
 <div style={{position:'absolute',inset:0,clipPath:`inset(0 ${100*(1-change)}% 0 0)`,background:'white'}}><Img src={tex('06-switched-panel')} style={{width:'100%',display:'block'}}/></div></div>
 <div style={{position:'absolute',left:110,top:952,fontSize:34,color:C.muted}}>自动切换需开启，且有满足模型与双额度条件的可用账号。</div></Shell>;
};
export const OUTRO_DEFAULTS={title:'DevFlow',subtitle:'模型由你选择，DevFlow 负责衔接。',cta:'开始你的下一项任务。',url:'github.com/zephyrw/dev-flow',accent:C.blue};
export const Outro:React.FC<Partial<typeof OUTRO_DEFAULTS>>=(props)=>{const v={...OUTRO_DEFAULTS,...props};const f=useCurrentFrame();const parts=[{src:'08-research',x:-220,y:85,w:720,r:-7,dx:-450,dy:-280,at:-12},{src:'07-model-config-panel',x:1440,y:110,w:720,r:7,dx:450,dy:-250,at:4},{src:'06-switched-panel',x:-150,y:760,w:650,r:5,dx:-360,dy:360,at:-8},{src:'14-final-review-main',x:1440,y:865,w:610,r:-6,dx:450,dy:350,at:10},{src:'04-accounts-first-account-hi',x:650,y:65,w:650,r:0,dx:0,dy:-300,at:13}];
 return <Shell demo={false}><div style={{position:'absolute',inset:0,background:'radial-gradient(ellipse at 50% 40%,#dbeafe88 0%,transparent 60%)',opacity:p(f,42,16)}}/>{Array.from({length:10},(_,i)=><div key={i} style={{position:'absolute',left:280+(i*157)%1420,top:220+(i*119)%650-f*.18,width:3+i%3,height:3+i%3,borderRadius:'50%',background:'#60a5fa',opacity:.16*p(f,42+i*2,18)}}/>)}<div style={{position:'absolute',inset:0,transformOrigin:'50% 45%',transform:`perspective(1400px) rotateX(${(1-p(f,0,40))*4}deg) scale(${1.06-.06*p(f,0,40)+.035*p(f,36,200)})`}}>{parts.map((r,i)=>{const at=r.at;const q=p(f,at,12,ease.back);const land=f<at+9?0:f<at+12?p(f,at+9,3):1-p(f,at+12,4);const fade=1-.5*p(f,42,8);return <div key={i} style={{position:'absolute',left:r.x,top:r.y,width:r.w,borderRadius:15,overflow:'hidden',boxShadow:'0 16px 40px #0f172a20',opacity:p(f,at,4)*fade,transform:`translate(${(1-q)*r.dx}px,${(1-q)*r.dy}px) rotate(${r.r*(2-q)}deg) scale(${1.12-.12*q},${1.12-.12*q-.015*land})`,filter:`blur(${Math.min(14,Math.abs(1-q)*10)+.5*p(f,42,8)}px)`}}><Img src={tex(r.src)} style={{width:'100%',display:'block'}}/></div>;})}</div>
 <div style={{position:'absolute',left:0,right:0,top:352,display:'flex',justifyContent:'center',gap:35,alignItems:'center',opacity:p(f,38,8)}}><Logo size={140} word={false}/><div style={{fontSize:170,fontWeight:750,letterSpacing:'-.045em'}}>{[...v.title].map((x,i)=><span key={i} style={{display:'inline-block',opacity:p(f,42+i*1.8,8),transform:`translateY(${(1-p(f,42+i*1.8,8))*30}px)`}}>{x}</span>)}</div></div>
 <div style={{position:'absolute',left:530,top:585,height:3,width:860*p(f,58,12),background:v.accent}}/>
 <Rise start={68} style={{position:'absolute',top:650,left:0,right:0,textAlign:'center',fontSize:60,color:C.muted}}>{v.subtitle}</Rise>
 <Rise start={85} style={{position:'absolute',top:754,left:0,right:0,textAlign:'center',fontSize:60,fontWeight:650,color:v.accent}}>{v.cta}</Rise>
 <Rise start={98} style={{position:'absolute',top:920,left:0,right:0,textAlign:'center',fontSize:40,color:C.muted}}>{v.url}</Rise></Shell>;
};
