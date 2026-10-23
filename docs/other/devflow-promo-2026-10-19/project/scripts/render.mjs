import {createRequire} from 'node:module';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(project,'..');process.chdir(project);
const require=createRequire(import.meta.url);
const cli=createRequire(require.resolve('@remotion/cli/package.json'));
const {bundle}=cli('@remotion/bundler');
const {renderStill,renderMedia,selectComposition,openBrowser}=cli('@remotion/renderer');
const browserExecutable=process.env.DEVFLOW_CAPTURE_BROWSER||'C:/Users/yckj4798/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
console.log('Bundling DevFlow film…');
const serveUrl=await bundle({entryPoint:resolve(project,'src/index.tsx'),outDir:resolve(out,'.tmp/bundle'),publicDir:resolve(project,'public'),webpackOverride:c=>({...c,cache:false})});
const chromiumOptions={gl:'angle'};
const browser=await openBrowser('chrome',{browserExecutable,chromiumOptions});
try{
 const common={serveUrl,browserExecutable,puppeteerInstance:browser,chromiumOptions,logLevel:'warn'};
 const composition=await selectComposition({...common,id:'DevFlowPromo'});
 await writeFile(resolve(project,'export-timeline.json'),JSON.stringify(composition.props.timeline,null,2));
 console.log(`Composition ${composition.width}x${composition.height}, ${composition.durationInFrames}f`);
 if(process.argv.includes('--video')){
  let last=-1;
  await renderMedia({...common,composition,codec:'h264',outputLocation:resolve(out,'.tmp/picture-master.mp4'),crf:17,pixelFormat:'yuv420p',muted:true,concurrency:4,imageFormat:'jpeg',jpegQuality:95,timeoutInMilliseconds:120000,onProgress:p=>{const n=Math.floor(p.progress*20);if(n>last){last=n;console.log(`Render ${Math.round(p.progress*100)}% · ${p.renderedFrames} frames`);}}});
 }else{
  const arg=process.argv.find(a=>a.startsWith('--frames='));
  const manifest=JSON.parse(await readFile(resolve(project,'article-frames.json'),'utf8'));
  const frames=arg?arg.split('=')[1].split(',').map(Number):manifest.map(r=>r.frame);
  const qa=process.argv.includes('--qa'),directory=resolve(out,qa?'.tmp/stills':'article-frames');
  await mkdir(directory,{recursive:true});
  for(const frame of frames){const filename=qa?`f${String(frame).padStart(4,'0')}.png`:manifest.find(r=>r.frame===frame)?.file||`v3-f${String(frame).padStart(4,'0')}.png`;await renderStill({...common,composition,frame,output:resolve(directory,filename),imageFormat:'png',scale:process.argv.includes('--4k')?2:1});console.log('Still',frame);}
 }
}finally{await browser.close({silent:true});}
