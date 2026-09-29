// Native candidate acceptance. Invoked only after source quality and packaging succeed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

const directory = resolve(process.argv[2] ?? "candidate");
const key = `${process.platform}-${process.arch}`;
assert(["win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"].includes(key));
const manifestPath = join(directory, `release-${key}.json`);
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const checksum = (file) => {
  const [sha, name] = readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/);
  assert.equal(name, file.split(/[\\/]/).at(-1));
  assert.equal(digest(file), sha);
};
checksum(manifestPath);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.equal(manifest.tag, process.env.RELEASE_TAG);
assert.equal(manifest.git_revision, process.env.RELEASE_GIT_SHA);
const component = manifest.components[key];
assert(component);
const archive = join(directory, component.name);
checksum(archive);
const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim().split(/\r?\n/);
assert(entries.every((entry) => /^devflow\//.test(entry) && !/(^\/|(^|\/)\.\.?(\/|$)|[:\\])/.test(entry)), "Unsafe archive entry");
const entryTypes = execFileSync("tar", ["-tvzf", archive], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim().split(/\r?\n/);
assert(entryTypes.every((line) => /^[d-]/.test(line)), "Candidate contains links or special files");
const root = mkdtempSync(join(tmpdir(), "devflow-candidate-"));
const source = join(root, "bundle", "devflow");
mkdirSync(join(root, "bundle"));
execFileSync("tar", ["-xzf", archive, "-C", join(root, "bundle")], { windowsHide: true });
function scan(dir) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    const stat = lstatSync(file);
    assert(!stat.isSymbolicLink(), "Candidate contains a link");
    assert(!/^(?:\.env(?:\..*)?|auth\.json|accounts?\.(?:db|sqlite)|credentials?(?:\..*)?)$/i.test(entry), "Candidate contains private state");
    if (stat.isDirectory()) scan(file);
    else if (/\.(?:js|mjs|cjs|json|yaml|yml|md|txt|pem|key|sh|ps1)$/.test(entry)) {
      const content = readFileSync(file, "utf8");
      assert(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content), "Candidate contains private key material");
      assert(!/\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{30,}\b/.test(content), "Candidate contains credential material");
    }
  }
}
scan(source);
const identityModule = await import(pathToFileURL(join(source, "dist/packages/installer/src/release-identity.js")));
const expectedRelease = { manifestPath, archivePath: archive, tag: manifest.tag, url: component.url };
identityModule.verifyReleaseIdentity(source, expectedRelease);
const node = join(source, "runtime", process.platform === "win32" ? "node.exe" : "node");
const home = join(root, "home");
const install = join(root, "install");
mkdirSync(home);
const server = createServer();
await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
const port = server.address().port;
await new Promise((yes) => server.close(yes));
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local") };
const { DiagnosticStreamRedactor } = await import(pathToFileURL(join(source, "dist/packages/presentation/src/secret-redactor.js")));
  const safeLog = (text) => {
    const redactor = new DiagnosticStreamRedactor();
    let safe = "";
    for (let offset = 0; offset < text.length; offset += 16384) safe += redactor.push(text.slice(offset, offset + 16384));
    return safe + redactor.push("", true);
  };
const runInstaller = (options) => {
  const script = 'const m=await import(process.argv[1]);process.exitCode=await m.runInstaller(JSON.parse(process.argv[2]));';
  const result = spawnSync(node, ["--input-type=module", "-e", script,
    pathToFileURL(join(source, "dist/packages/installer/src/main.js")).href,
    JSON.stringify({ sourceDir: source, installRoot: install, clientHome: home, targetTools: ["codex"], port, expectedRelease, ...options })],
  { env, encoding: "utf8", windowsHide: true, timeout: 240000, maxBuffer: 16 * 1024 * 1024 });
  process.stdout.write(safeLog(result.stdout ?? ""));
  process.stderr.write(safeLog(result.stderr ?? ""));
  assert(!result.error, "Installer subprocess failed");
  return result.status;
};
// Run native ownership checks in a short-lived process so Windows can release addon files before cleanup.
async function stopOwnedController() {
  const result = spawnSync(node, [resolve("scripts/release/stop-candidate-controller.mjs"), source, install],
    { env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.equal(result.status, 0, safeLog(result.stderr || "Candidate controller stop failed"));
}

try {
  // Identity and interrupted-download failures must not create any install state.
  const rejected = join(root, "rejected");
  assert.equal(runInstaller({ installRoot: rejected, expectedRelease: { ...expectedRelease, tag: "v999.0.0" } }), 20);
  assert(!existsSync(rejected));
  const brokenArchive = join(root, component.name);
  writeFileSync(brokenArchive, readFileSync(archive).subarray(0, 128));
  assert.equal(runInstaller({ installRoot: rejected, expectedRelease: { ...expectedRelease, archivePath: brokenArchive } }), 20);
  assert(!existsSync(rejected));
  // Real source-mode predecessor, derived in isolation; candidate identity stays unchanged.
  const predecessor = join(root, "predecessor");
  cpSync(source, predecessor, { recursive: true });
  rmSync(join(predecessor, "release-identity.json"));
  const pkg = JSON.parse(readFileSync(join(predecessor, "package.json"), "utf8"));
  pkg.version = `${manifest.version.split("-")[0]}-candidate-predecessor`;
  writeFileSync(join(predecessor, "package.json"), JSON.stringify(pkg));
  assert([0, 10].includes(runInstaller({ sourceDir: predecessor, expectedRelease: undefined })));
  await stopOwnedController();
  const userFile = join(install, "state", "user-content.txt");
  writeFileSync(userFile, "preserved user content");
  assert([0, 10].includes(runInstaller({})));
  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.equal(health.service, "devflow");
  assert.equal(resolve(health.runtime_root), join(install, "versions", manifest.version));
  assert((await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes('id="root"'));
  await stopOwnedController();
  assert.equal(readFileSync(userFile, "utf8"), "preserved user content");
  const config = readFileSync(join(install, "devflow.yaml"), "utf8");
  const pointer = readFileSync(join(install, "current.json"), "utf8");
  const database = digest(join(install, "state", "devflow.sqlite"));
  // Real client-path I/O failure after configuration phase triggers pre-migration rollback.
  const blockedHome = join(root, "blocked-home");
  writeFileSync(blockedHome, "not a directory");
  assert.equal(runInstaller({ clientHome: blockedHome }), 30);
  assert.equal(readFileSync(join(install, "devflow.yaml"), "utf8"), config);
  assert.equal(readFileSync(join(install, "current.json"), "utf8"), pointer);
  assert.equal(digest(join(install, "state", "devflow.sqlite")), database);
  assert.equal(readFileSync(userFile, "utf8"), "preserved user content");
  assert([0, 10].includes(runInstaller({})));
  await stopOwnedController();
} finally {
  await stopOwnedController();
  assert(resolve(root).startsWith(resolve(tmpdir()) + sep));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
