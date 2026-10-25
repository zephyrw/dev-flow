// Runs on clean CI hosts after publication. All downloads are anonymous.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';

const tag = process.env.RELEASE_TAG;
assert(/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(tag ?? ''), 'Explicit release tag required');
const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'devflow-public-install-'));
const install = join(root, 'install'), home = join(root, 'home');
mkdirSync(home);
const key = `${process.platform}-${process.arch}`;
assert(['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'].includes(key));
const base = `https://github.com/zephyrw/dev-flow/releases/download/${tag}`;
const download = async name => {
  const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(120000) });
  assert(response.ok, `${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};
const verified = async name => {
  const bytes = await download(name), line = (await download(`${name}.sha256`)).toString('utf8').trim().split(/\s+/);
  assert.equal(line[1], name); assert.equal(createHash('sha256').update(bytes).digest('hex'), line[0]); return bytes;
};
const manifest = JSON.parse((await verified(`release-${key}.json`)).toString('utf8'));
assert.equal(manifest.tag, tag); assert.equal(manifest.git_revision, process.env.RELEASE_GIT_SHA);
const scriptName = process.platform === 'win32' ? 'install.ps1' : 'install.sh';
const script = join(root, scriptName); writeFileSync(script, await download(scriptName));
const server = createServer();
await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
const port = server.address().port; await new Promise(yes => server.close(yes));
// Child-only homes prevent installer probes from modifying a real user's clients.
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home,'.codex'), APPDATA: join(home,'roaming'), LOCALAPPDATA: join(home,'local'), XDG_CONFIG_HOME: join(home,'.config'), XDG_DATA_HOME: join(home,'.local/share') };
delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
// Windows PowerShell must discover its own built-in modules, not inherit a PowerShell 7 module path.
if (process.platform === 'win32') delete env.PSModulePath;
const runtimeRoot = join(install, 'versions', manifest.version);
const node = join(runtimeRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
let stopped = false;
try {
  const command = process.platform === 'win32' ? 'powershell.exe' : 'sh';
  const args = process.platform === 'win32'
    ? ['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Version',tag,'-InstallDir',install,'-Tools','codex','-NoOpen','-Port',String(port)]
    : [script,'--version',tag,'--install-dir',install,'--tool','codex','--no-open','--port',String(port)];
  const result = spawnSync(command, args, { env, encoding:'utf8', windowsHide:true, timeout:300000, maxBuffer:4*1024*1024 });
  if (result.status !== 0) console.error(result.stdout, result.stderr);
  assert.equal(result.status, 0, result.error?.message ?? 'Public bootstrap failed');
  assert(existsSync(node));
  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert(healthResponse.ok); const health = await healthResponse.json();
  assert.equal(health.service,'devflow'); assert.equal(resolve(health.runtime_root),runtimeRoot);
  assert((await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes('id="root"'));
  const stop = spawnSync(node,[resolve('scripts/release/stop-candidate-controller.mjs'),runtimeRoot,install],{env,encoding:'utf8',windowsHide:true,timeout:110000});
  assert.equal(stop.status,0,stop.stderr); stopped=true;
  console.log(JSON.stringify({ tag, git_revision:manifest.git_revision, platform:key, anonymous_download:true, bootstrap_install:true, bundled_runtime:true, health:true, page:true, confirmed_stop:true }));
} finally {
  if (!stopped && existsSync(node)) {
    const stop=spawnSync(node,[resolve('scripts/release/stop-candidate-controller.mjs'),runtimeRoot,install],{env,encoding:'utf8',windowsHide:true,timeout:110000});
    stopped=stop.status===0;
  }
  // Preserve uncertain live state; never traverse links during cleanup.
  const noLinks = directory => readdirSync(directory).every(name => { const path=join(directory,name), stat=lstatSync(path); return !stat.isSymbolicLink() && (!stat.isDirectory() || noLinks(path)); });
  if ((stopped || !existsSync(install)) && resolve(root).startsWith(realpathSync.native(tmpdir())+sep) && noLinks(root)) rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
