import {createRequire} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(project,'..');
await mkdir(resolve(out,'.tmp'),{recursive:true});
const {chromium}=createRequire(resolve(project,'../../../..','package.json'))('@playwright/test');
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/yckj4798/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}});const errors=[],abortedMediaRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('requestfailed',r=>{const message=r.url()+': '+r.failure()?.errorText;if(r.failure()?.errorText==='net::ERR_ABORTED'&&r.url().includes('/audio/'))abortedMediaRequests.push(message);else errors.push(message);});
 await page.goto('http://localhost:5198/?import=project',{waitUntil:'domcontentloaded',timeout:60000});await page.waitForTimeout(8000);
 await page.screenshot({path:resolve(out,'.tmp/workbench.png'),fullPage:true});
 const body=await page.locator('body').innerText();
 const media=await page.request.get('http://localhost:5198/audio/house-vibez-edit.wav');if(!media.ok())errors.push('BGM failed to load: '+media.status());
 await writeFile(resolve(out,'workbench-check.json'),JSON.stringify({errors,abortedMediaRequests,mediaStatus:media.status(),filmImported:body.includes('DevFlow · 八步工作流'),body},null,2));
 const saved=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.includes('project')||k.includes('shotcraft'))));
 await writeFile(resolve(out,'.tmp/workbench-storage.json'),JSON.stringify(saved,null,2));
 if(saved['shotcraft-workbench-project-v1'])await writeFile(resolve(out,'project/DevFlow-shotcraft.json'),JSON.stringify(JSON.parse(saved['shotcraft-workbench-project-v1']),null,2));
 console.log(JSON.stringify({errors,body:body.slice(0,3500),storageKeys:Object.keys(saved)}));
 if(errors.length)process.exitCode=1;
}finally{await browser.close();}
