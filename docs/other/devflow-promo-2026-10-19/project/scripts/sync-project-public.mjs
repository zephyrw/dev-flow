// Copy only this project's assets and referenced library files into one export job.
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const wb=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dest=resolve(process.argv[2]);const allowed=resolve(wb,'.render-public')+sep;
if(!dest.startsWith(allowed)||!/^\w+$/.test(dest.slice(allowed.length)))throw new Error('Invalid export asset destination');
const src=resolve(realpathSync(join(wb,'proj')),'../public');
const copy=(a,b)=>{const s=lstatSync(a);if(s.isSymbolicLink())throw new Error('Asset links are not followed: '+a);if(s.isDirectory()){mkdirSync(b,{recursive:true});for(const name of readdirSync(a))copy(join(a,name),join(b,name));}else{mkdirSync(dirname(b),{recursive:true});copyFileSync(a,b);}};
copy(src,dest);
const data=JSON.parse(readFileSync(process.argv[3],'utf8'));
const visit=value=>{
 if(typeof value==='string'&&/^(sfxlib|bgmlib|legacy-textures|uploads)\//.test(value)&&!value.includes('..')){
  const path=join(wb,'public',value);if(existsSync(path))copy(realpathSync(path),join(dest,value));
 }else if(value&&typeof value==='object')Object.values(value).forEach(visit);
};visit(data);console.log('Export assets ready.');
