import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,writeFile,access} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(project,'..');
const outputArg=process.argv.indexOf('--output-dir'),dest=outputArg>=0?resolve(process.argv[outputArg+1]):out;
const videoFile=resolve(dest,'DevFlow-music-1080p.mp4');
const {chromium}=createRequire(resolve(project,'../../../..','package.json'))('@playwright/test');
const browser=await chromium.launch({headless:true,executablePath:'C:/Users/yckj4798/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(resolve(out,'素材索引.html')).href);
 const records=JSON.parse(await readFile(resolve(out,'asset-index.json'),'utf8'));
 for(const r of records)await access(resolve(out,r.file));
 const brokenImages=await page.locator('img').evaluateAll(async imgs=>{await Promise.all(imgs.map(i=>{i.loading='eager';return Promise.race([i.decode().catch(()=>{}),new Promise(r=>setTimeout(r,15000))]);}));return imgs.filter(i=>!i.naturalWidth).map(i=>i.getAttribute('src'));});
 const report={errors,brokenImages,images:records.length,fileSha256:createHash('sha256').update(await readFile(videoFile)).digest('hex')};
 await page.locator('video').evaluate((v,url)=>{v.src=url;v.load();},pathToFileURL(videoFile).href);
 report.start=await page.locator('video').evaluate(async v=>{v.muted=true;await v.play();return{duration:v.duration,width:v.videoWidth,height:v.videoHeight,playbackRate:v.playbackRate};});
 console.log('Playing complete final MP4 at normal speed.');
 await page.waitForFunction(()=>document.querySelector('video').ended,null,{timeout:Math.ceil(report.start.duration*1000)+30000});
 report.finish=await page.locator('video').evaluate(v=>({ended:v.ended,time:v.currentTime,quality:v.getVideoPlaybackQuality().toJSON?.()||{totalVideoFrames:v.getVideoPlaybackQuality().totalVideoFrames,droppedVideoFrames:v.getVideoPlaybackQuality().droppedVideoFrames},error:v.error?.message||null}));
 await writeFile(resolve(dest,'playback-check.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(errors.length||brokenImages.length||report.finish.error||!report.finish.ended)process.exitCode=1;
}finally{await browser.close();}
