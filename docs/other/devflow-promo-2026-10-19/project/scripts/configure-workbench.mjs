// Windows + pnpm compatibility for this installed video-shotcraft workbench.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));
const wb=resolve(process.env.VIDEO_SHOTCRAFT_HOME||'C:/Users/yckj4798/.codex/skills/video-shotcraft','workbench');
const packages=Object.keys(JSON.parse(readFileSync(resolve(wb,'package.json'),'utf8')).dependencies);
const edit=(file,fn)=>{const path=resolve(wb,file);const old=readFileSync(path,'utf8');const next=fn(old);if(next!==old)writeFileSync(path,next);};
edit('scripts/gen-index.mjs',s=>s.replace('relative(demosDir, p).replace(',String.raw`relative(demosDir, p).replaceAll("\\", "/").replace(`));
edit('vite.config.ts',s=>{
 s=s.replace('existsSync, mkdirSync','existsSync, realpathSync, mkdirSync').replace('preserveSymlinks: true','preserveSymlinks: false');
 // Zustand only belongs to the workbench; a prefix alias would bypass the
 // package's ESM exports for zustand/react and zustand/vanilla.
 const aliases=packages.filter(name=>name!=='zustand').map(name=>`${JSON.stringify(name)}: realpathSync(path.join(root,${JSON.stringify('node_modules/'+name)}))`).join(', ');
 s=s.replace(/alias: \{ "@proj": path\.join\(root, proj\),[^\n]+\},/,'alias: { "@proj": path.join(root, proj), "@demos": path.join(root, "demosrc"), '+aliases+' },');
 s=s.replace('const renderPublic = path.join(root, ".render-public");','const renderPublic = path.join(root, ".render-public", id);');
 s=s.replace('"rsync",\n              ["-aL", "--delete", "--exclude=cardpreviews", "public/", `${renderPublic}/`],','process.execPath,\n              [path.join(root, "scripts", "sync-project-public.mjs"), renderPublic, propsFile],');
 s=s.replace('const bin = path.join(root, "node_modules", ".bin", "remotion");','const bin = path.join(root, "node_modules", "@remotion", "cli", "remotion-cli.js");');
 s=s.replace('                bin,\n                [\n                  "render",','                process.execPath,\n                [bin,\n                  "render",');
 if(!s.includes('--browser-executable='))s=s.replace('                  `--public-dir=${renderPublic}`,','                  `--public-dir=${renderPublic}`,\n                  "--browser-executable=C:/Users/yckj4798/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe",');
 s=s.replace('              { cwd: root },','              { cwd: root, windowsHide: true },');
 s=s.replace('                { cwd: root },','                { cwd: root, windowsHide: true },');
 if(!s.includes('rmSync(renderPublic,'))s=s.replace('                dropProps(); // Remotion CLI','                rmSync(renderPublic, { recursive: true, force: true }); // Exact per-job copy; sync helper never copies links.\n                dropProps(); // Remotion CLI');
 return s;
});
edit('remotion.config.ts',s=>{
 s=s.replace('import { existsSync }','import { existsSync, realpathSync }').replace('symlinks: false,','symlinks: true,');
 if(!s.includes('modules: ['))s=s.replace('    symlinks: true,','    symlinks: true,\n    modules: [path.resolve(process.cwd(),"node_modules"), "node_modules"],');
 if(!s.includes('"react": realpathSync'))s=s.replace('      "@proj": proj,','      "@proj": proj,\n      "react": realpathSync(path.resolve(process.cwd(),"node_modules/react")),\n      "react-dom": realpathSync(path.resolve(process.cwd(),"node_modules/react-dom")),\n      "remotion": realpathSync(path.resolve(process.cwd(),"node_modules/remotion")),');
 return s;
});
writeFileSync(resolve(wb,'scripts/sync-project-public.mjs'),readFileSync(resolve(here,'sync-project-public.mjs')));
if(!existsSync(resolve(wb,'node_modules/@remotion/cli/remotion-cli.js')))throw new Error('Remotion CLI missing');
const env={...process.env,NODE_OPTIONS:`--import=${pathToFileURL(resolve(here,'windows-links.mjs')).href}`};
const result=spawnSync(process.execPath,[resolve(wb,'scripts/gen-index.mjs')],{cwd:wb,env,stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status||1);
console.log('Workbench configured for Windows and pnpm.');
