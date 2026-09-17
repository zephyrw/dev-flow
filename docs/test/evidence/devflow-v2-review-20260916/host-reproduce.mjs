import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const exe=resolve('.cache/devflow-v2-review-host.exe');
const cases=[];
async function run(spec,args=[]){return new Promise((ok,fail)=>{const start=Date.now();const p=spawn(exe,args,{windowsHide:true,stdio:'pipe'});let stdout='',stderr='';const timeout=setTimeout(()=>{p.kill();fail(new Error('Audit host exceeded 5s'));},5000);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',fail);p.once('close',code=>{clearTimeout(timeout);ok({code,elapsed_ms:Date.now()-start,events:stdout.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)),stderr})});if(spec)p.stdin.write(JSON.stringify(spec)+'\n');else p.stdin.end();});}
const base={id:'audit-only',executable:process.execPath,args:['-e','process.stdout.write("ok")'],cwd:process.cwd(),env:{},timeout_ms:1000};
const zero=await run(base,['run']);cases.push({id:'H01',defect_reproduced:zero.events.some(e=>e.type==='exit'&&!Object.hasOwn(e,'code')),observed:zero});
const timed=await run({...base,args:['-e','setTimeout(()=>process.exit(0),500)'],timeout_ms:20});cases.push({id:'H02',defect_reproduced:timed.elapsed_ms>300,observed:timed});
const lock=await run(undefined,['controller-lock','audit-isolated-lock']);cases.push({id:'H03',defect_reproduced:!lock.events.some(e=>e.locked===true),observed:lock});
writeFileSync(new URL('./host-reproductions.json',import.meta.url),JSON.stringify({cases},null,2));console.log(JSON.stringify(cases,null,2));