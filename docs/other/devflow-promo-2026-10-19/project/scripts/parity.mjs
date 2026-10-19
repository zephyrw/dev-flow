// Windows adaptation of the skill's parity check: use the existing browser and public assets.
import {createRequire} from 'node:module';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(project,'..');
const wb=resolve(process.env.VIDEO_SHOTCRAFT_HOME||'C:/Users/yckj4798/.codex/skills/video-shotcraft','workbench');
const projectRequire=createRequire(import.meta.url);
const req=createRequire(projectRequire.resolve('@remotion/cli/package.json'));
const {bundle}=req('@remotion/bundler'),{renderStill,selectComposition,openBrowser}=req('@remotion/renderer');
const browserExecutable=process.env.DEVFLOW_CAPTURE_BROWSER||'C:/Users/yckj4798/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const serveUrl=await bundle({entryPoint:resolve(wb,'src/remotion/index.ts'),outDir:resolve(out,'.tmp/parity-bundle'),publicDir:resolve(project,'public'),webpackOverride:c=>({...c,cache:false,resolve:{...c.resolve,modules:[resolve(wb,'node_modules'),'node_modules'],symlinks:true,alias:{...c.resolve?.alias,'@proj':resolve(wb,'proj'),'@demos':resolve(wb,'demosrc'),'react':realpathSync(resolve(wb,'node_modules/react')),'react-dom':realpathSync(resolve(wb,'node_modules/react-dom')),'remotion':realpathSync(resolve(wb,'node_modules/remotion'))}}})});
const browser=await openBrowser('chrome',{browserExecutable,chromiumOptions:{gl:'angle'}});
const common={serveUrl,browserExecutable,puppeteerInstance:browser,chromiumOptions:{gl:'angle'},logLevel:'warn'};
const manifest=JSON.parse(await readFile(resolve(project,'article-frames.json'),'utf8'));
const arg=process.argv.find(a=>a.startsWith('--frames='));
const frames=arg?arg.split('=')[1].split(',').map(Number):manifest.map(r=>r.frame);const results=[];await mkdir(resolve(out,'.tmp/parity'),{recursive:true});
try{
 const comps={};for(const id of ['ProjImported','ProjOriginal']) comps[id]=await selectComposition({...common,id});
 for(const frame of frames){
  const files=[];
  for(const id of Object.keys(comps)){const output=resolve(out,'.tmp/parity',`${id}-${frame}.png`);files.push(output);await renderStill({...common,composition:comps[id],frame,output,imageFormat:'png'});if(id==='ProjOriginal'&&process.argv.includes('--article'))await copyFile(output,resolve(out,'article-frames',manifest.find(r=>r.frame===frame)?.file||`v3-f${String(frame).padStart(4,'0')}.png`));}
  const py=spawnSync(process.env.PYTHON||'C:/Users/yckj4798/AppData/Local/Programs/Python/Python312/python.exe',['-c','from PIL import Image; import numpy as np,sys,json; a=np.asarray(Image.open(sys.argv[1]).convert("RGB")).astype(int);b=np.asarray(Image.open(sys.argv[2]).convert("RGB")).astype(int);d=np.max(abs(a-b),axis=2);print(json.dumps({"changed_pixels":int(np.sum(d>2)),"total_pixels":int(d.size),"max_channel_difference":int(d.max())}))',...files],{encoding:'utf8'});
  if(py.status!==0)throw new Error(py.stderr||'Image comparison failed');const result={frame,...JSON.parse(py.stdout)};results.push(result);console.log(JSON.stringify(result));
 }
 await writeFile(resolve(out,'workbench-parity.json'),JSON.stringify(results,null,2));
 if(results.some(r=>r.changed_pixels/r.total_pixels>=.001))process.exitCode=1;
}finally{await browser.close({silent:true});}
