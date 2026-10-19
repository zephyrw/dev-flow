// Scope the installed skill's directory links to Windows junctions; no admin/dev-mode needed.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {dirname,resolve} from 'node:path';
const old=fs.symlinkSync;
const wb=resolve(process.env.VIDEO_SHOTCRAFT_HOME||'C:/Users/yckj4798/.codex/skills/video-shotcraft','workbench').toLowerCase();
if(process.platform==='win32'){
 const spawn=childProcess.spawn,spawnSync=childProcess.spawnSync;
 childProcess.spawn=function(command,args,options){return spawn(command,args,{windowsHide:true,...options});};
 childProcess.spawnSync=function(command,args,options){return spawnSync(command,args,{windowsHide:true,...options});};
 fs.symlinkSync=function(target,path,type){
  if(resolve(path).toLowerCase().startsWith(wb+'\\')&&type===undefined){return old(resolve(dirname(path),target),path,'junction');}
  return old(target,path,type);
 };
 syncBuiltinESMExports();
}
