import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// Only synthetic temp files and owned children; never accesses real credentials.
const root = process.argv[2];
if (!root) throw new Error('Pass the reviewed worktree absolute path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-review-node-'));
const results = [];
const dist = path.join(root, 'dist');
const sourceFiles = ['packages/process/src/controller-lock', 'packages/process/src/agy-account-processes',
  'packages/process/src/manager', 'packages/contracts/src/config-migration', 'packages/contracts/src/config',
  'packages/agy-accounts/src/credential-store', 'packages/agy-accounts/src/credential-worker'];
const ts = (await import(pathToFileURL(path.join(root, 'node_modules/typescript/lib/typescript.js')))).default;
for (const f of sourceFiles) {
  const emitted = ts.transpileModule(fs.readFileSync(path.join(root, f + '.ts'), 'utf8'), {
    fileName: f + '.mts', compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
  }).outputText;
  const actual = fs.readFileSync(path.join(dist, f + '.js'), 'utf8');
  if (emitted.trim().replaceAll('\r\n', '\n') !== actual.trim().replaceAll('\r\n', '\n'))
    throw new Error('Existing dist differs from source transpilation: ' + f);
}
results.push({ check: 'reviewed-modules-match-source', count: sourceFiles.length, ok: true });
const load = f => import(pathToFileURL(path.join(dist, f + '.js')));
const { acquireControllerLock } = await load('packages/process/src/controller-lock');
try { const release = await acquireControllerLock(scratch); await release(); results.push({ check: 'controller-start', unexpected: 'succeeded' }); }
catch (error) { results.push({ check: 'controller-start', error: error.message }); }
const { AgyAccountProcessHost } = await load('packages/process/src/agy-account-processes');
const host = new AgyAccountProcessHost({ store: { list: () => [{ id: 'synthetic_live', pid: process.pid }] }, agyExecutable: process.execPath });
results.push({ check: 'live-process-stop-observation', processReallyAlive: true, returnedStopped: await host.confirmJobsStopped(['synthetic_live']) });
const { ProcessManager } = await load('packages/process/src/manager');
const lifecycle = [];
const manager = new ProcessManager((_spec, event) => lifecycle.push(event));
const child = manager.start({ id: 'synthetic_simple', executable: process.execPath,
  args: ['-e', 'process.stdout.write("synthetic-only")'], cwd: scratch, env: {}, timeout_ms: 10000 });
await child.completion;
results.push({ check: 'manager-lifecycle', events: lifecycle, hasPersistedPid: lifecycle.some(e => Number.isSafeInteger(e.pid)), hasPersistedIdentity: lifecycle.some(e => e.identity) });
await manager.close();
const { dryRunMigration, applyMigration, fileHash, loadConfigCompat } = await load('packages/contracts/src/config-migration');
const { loadConfig } = await load('packages/contracts/src/config');
const config = path.join(scratch, 'synthetic.yaml');
fs.writeFileSync(config, '# preserve this synthetic comment\nschema_version: 1\nhost:\n  executable: dist/host/devflow-host.exe\n  required: true\n');
const migration = applyMigration(config, dryRunMigration(config).input_hash);
let actualLoader;
try { loadConfig(config); actualLoader = 'accepted'; }
catch(error) { actualLoader = error.issues?.map(i => ({path:i.path, code:i.code})) ?? error.message; }
results.push({ check: 'migrate-then-load', migrationSucceeded: migration.success, actualLoader, commentPreserved: fs.readFileSync(config,'utf8').includes('# preserve') });
const custom = path.join(scratch, 'custom.yaml');
fs.writeFileSync(custom, 'schema_version: 1\nhost:\n  executable: C:/synthetic/custom-host.exe\n');
const customDry = dryRunMigration(custom);
const customApply = applyMigration(custom, fileHash(fs.readFileSync(custom, 'utf8')));
results.push({ check: 'custom-host-apply', dryRunAllowed: customDry.can_apply, applySucceeded: customApply.success });
const account = path.join(scratch, 'accounts.yaml');
fs.writeFileSync(account, 'schema_version: 1\nagy_accounts:\n  enabled: true\n  workflow_auto_switch: false\n');
try { loadConfigCompat(account); results.push({ check: 'account-settings-preserved', accepted: true }); }
catch(error) { results.push({ check: 'account-settings-preserved', error: error.issues?.map(i=>({path:i.path,code:i.code,keys:i.keys})) ?? error.message }); }
const { writeVaultEnvelope, readVaultEnvelope, allocateRevision } = await load('packages/agy-accounts/src/credential-store');
const paths = { baseDir: scratch, activeFile: path.join(scratch,'synthetic.bin'), backupFile: path.join(scratch,'synthetic.backup.bin'),
  revisionFile: path.join(scratch,'synthetic.revision'), backupRevisionFile: path.join(scratch,'synthetic.backup.revision') };
const envelope = { Version:2, RealmID:'synthetic', AccountID:'synthetic', Revision:1,
  Credential:{ Exists:true, Flags:0, Username:'synthetic', Comment:'', Persist:2, TargetAlias:'', Attributes:{}, Secret:'' } };
writeVaultEnvelope(paths, envelope, b => Buffer.from(b).map(x=>x ^ 0x5a));
results.push({ check: 'vault-encrypted-roundtrip', result: readVaultEnvelope(paths) });
fs.writeFileSync(paths.revisionFile, 'corrupt-synthetic');
results.push({ check: 'corrupt-revision', allocated: allocateRevision(paths) });
const worker = spawnSync(process.execPath, [path.join(dist, 'packages/agy-accounts/src/credential-worker.js')], {
  input: JSON.stringify({id:'review',action:'capabilities',args:{}})+'\n', encoding:'utf8', windowsHide:true, timeout:5000,
  env: Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^NODE_/i.test(k))),
});
results.push({ check:'worker-capabilities-only', status:worker.status, signal:worker.signal,
  stdout:worker.stdout?.trim(), stderr:worker.stderr?.split('\n').slice(0,7).join('\n') });
console.log(JSON.stringify({ platform:process.platform,node:process.version,scratch,results },null,2));
