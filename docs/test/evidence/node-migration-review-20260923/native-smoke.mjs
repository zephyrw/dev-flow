import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
// Binds credential functions but never calls credential read/write/delete or DPAPI.
// Job ownership is tested only against a child created by this script.
const root = process.argv[2];
if (!root || process.platform !== 'win32') throw new Error('Windows worktree required');
const ts = (await import(pathToFileURL(path.join(root,'node_modules/typescript/lib/typescript.js')))).default;
const modules = ['packages/process/src/native/windows', 'packages/agy-accounts/src/credential-windows'];
for (const f of modules) {
  const source = ts.transpileModule(fs.readFileSync(path.join(root,f+'.ts'),'utf8'), {
    fileName:f+'.mts', compilerOptions:{ target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext },
  }).outputText.trim().replaceAll('\r\n','\n');
  if (source !== fs.readFileSync(path.join(root,'dist',f+'.js'),'utf8').trim().replaceAll('\r\n','\n'))
    throw new Error('dist/source mismatch: '+f);
}
const { createWindowsNative } = await import(pathToFileURL(path.join(root,'dist',modules[0]+'.js')));
const { createCredentialWindows } = await import(pathToFileURL(path.join(root,'dist',modules[1]+'.js')));
const results = [];
try { createCredentialWindows(); results.push({check:'credential-bindings-only',ok:true}); }
catch(error) { results.push({check:'credential-bindings-only',error:error.message}); }
const native = createWindowsNative();
const child = spawn(process.execPath,['-e','setTimeout(()=>{},5000)'], {stdio:'ignore',windowsHide:true});
const closed = once(child,'close');
let job;
try {
  await once(child,'spawn');
  job = native.createJob('Local\\DevFlowReview.'+randomUUID());
  results.push({check:'assign-owned-child-through-production-wrapper',jobCreated:!!job,
    childAlive:child.exitCode===null,assigned:job ? native.assignProcessToJob(job,child.pid) : null});
} finally {
  if (child.exitCode===null) child.kill();
  await closed;
  if (job) native.closeHandle(job);
}
console.log(JSON.stringify({platform:process.platform,node:process.version,results},null,2));
