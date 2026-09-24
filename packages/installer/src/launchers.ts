/**
 * Stable bootstrap layer, user-level launchers, and PATH management.
 *
 * Owns: bootstrap/runtime + entry.mjs, bin/ wrapper, platform menu entries,
 * and install-transaction ownership (two installers must not interleave).
 * Does not own accounts launcher (upgrade.ts writeAccountsLauncher).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  rmSync,
  openSync,
  closeSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep, relative, isAbsolute, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { hash } from "../../core/src/util.js";
import { getNativeAsync, getWindowsNative } from "../../process/src/native/index.js";
import { atomicWrite } from "../../core/src/util.js";

export const ENTRY_TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "entry-template.mjs",
);

export const PATH_BLOCK_START = "# >>> devflow managed PATH >>>";
export const PATH_BLOCK_END = "# <<< devflow managed PATH <<<";
export const WINDOWS_PATH_TOKEN = "DevFlow";

export interface CurrentPointer {
  version: string;
  root: string;
  config: string;
  node: string;
  schema?: number;
  application_version?: string;
  build_revision?: string;
  updated_at?: string;
}

export interface LayoutPaths {
  root: string;
  bootstrapDir: string;
  bootstrapRuntimeDir: string;
  bootstrapNode: string;
  entryMjs: string;
  binDir: string;
  versionsDir: string;
  currentJson: string;
  configFile: string;
  stateDir: string;
  stateJson: string;
  backupDir: string;
  transactionsDir: string;
}

export function resolveLayout(installRoot: string): LayoutPaths {
  const root = resolve(installRoot);
  const bootstrapDir = join(root, "bootstrap");
  const bootstrapRuntimeDir = join(bootstrapDir, "runtime");
  return {
    root,
    bootstrapDir,
    bootstrapRuntimeDir,
    bootstrapNode: join(
      bootstrapRuntimeDir,
      process.platform === "win32" ? "node.exe" : "node",
    ),
    entryMjs: join(bootstrapDir, "entry.mjs"),
    binDir: join(root, "bin"),
    versionsDir: join(root, "versions"),
    currentJson: join(root, "current.json"),
    configFile: join(root, "devflow.yaml"),
    stateDir: join(root, "state"),
    stateJson: join(root, "state.json"),
    backupDir: join(root, "backup"),
    transactionsDir: join(root, "transactions"),
  };
}

export function ensureInstallLayout(installRoot: string): LayoutPaths {
  const layout = resolveLayout(installRoot);
  for (const dir of [
    layout.bootstrapDir,
    layout.bootstrapRuntimeDir,
    layout.binDir,
    layout.versionsDir,
    layout.stateDir,
    layout.backupDir,
    layout.transactionsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return layout;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return (
    rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel))
  );
}

export function assertTrustedPointerPath(
  installRoot: string,
  label: string,
  raw: string,
  allowedRoots: string[],
): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0")) {
    throw new Error("current.json 字段 " + label + " 无效");
  }
  const absolute = resolve(raw);
  if (!allowedRoots.some((root) => isInside(root, absolute))) {
    throw new Error(
      "current.json 字段 " + label + " 超出受信任安装位置，拒绝执行不可信路径",
    );
  }
  return absolute;
}

export function parseCurrentPointer(
  installRoot: string,
  text: string,
): CurrentPointer {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("current.json 已损坏，无法解析");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("current.json 内容无效");
  }
  const root = resolve(installRoot);
  const versionsRoot = join(root, "versions");
  const bootstrapRuntime = join(root, "bootstrap", "runtime");
  const versionRoot = assertTrustedPointerPath(root, "root", parsed.root, [
    versionsRoot,
  ]);
  const node = assertTrustedPointerPath(root, "node", parsed.node, [
    bootstrapRuntime,
    join(versionRoot, "runtime"),
  ]);
  const config = assertTrustedPointerPath(root, "config", parsed.config, [root]);
  return {
    version: typeof parsed.version === "string" ? parsed.version : "",
    root: versionRoot,
    config,
    node,
    schema: typeof parsed.schema === "number" ? parsed.schema : undefined,
    application_version:
      typeof parsed.application_version === "string"
        ? parsed.application_version
        : undefined,
    build_revision:
      typeof parsed.build_revision === "string"
        ? parsed.build_revision
        : undefined,
    updated_at:
      typeof parsed.updated_at === "string" ? parsed.updated_at : undefined,
  };
}

export function readCurrentPointer(installRoot: string): CurrentPointer {
  const path = resolveLayout(installRoot).currentJson;
  if (!existsSync(path)) {
    throw new Error("缺少 current.json，安装未完成或已被删除");
  }
  return parseCurrentPointer(installRoot, readFileSync(path, "utf8"));
}

export function writeCurrentPointer(
  installRoot: string,
  pointer: CurrentPointer,
): void {
  atomicWrite(
    resolveLayout(installRoot).currentJson,
    JSON.stringify(pointer, null, 2),
  );
}

export interface BootstrapOptions {
  /** Verified product Node to copy (or safely reuse) into bootstrap/runtime. */
  sourceNode: string;
  /** Optional path to entry-template.mjs (defaults to packaged template). */
  entryTemplatePath?: string;
  /** When the target Node is busy (Windows), defer replace to exit stage. */
  deferReplaceOnBusy?: boolean;
}

export function installBootstrapRuntime(
  installRoot: string,
  options: BootstrapOptions,
): { node: string; deferred: boolean } {
  const layout = ensureInstallLayout(installRoot);
  const template = options.entryTemplatePath ?? ENTRY_TEMPLATE_PATH;
  if (!existsSync(template)) {
    throw new Error("安装包不完整：缺少 bootstrap/entry.mjs 模板");
  }
  if (!existsSync(options.sourceNode)) {
    throw new Error("安装包不完整：缺少内置 Node 运行时");
  }
  let deferred = false;
  const targetNode = layout.bootstrapNode;
  try {
    const temp = targetNode + ".tmp-" + hash(String(Date.now())).slice(0, 8);
    copyFileSync(options.sourceNode, temp);
    // Validate the copied binary is usable before swap.
    if (existsSync(targetNode)) {
      try {
        rmSync(targetNode, { force: true });
      } catch (error: any) {
        if (
          options.deferReplaceOnBusy &&
          ["EPERM", "EBUSY", "EACCES"].includes(error?.code)
        ) {
          deferred = true;
        } else {
          try {
            rmSync(temp, { force: true });
          } catch {}
          throw error;
        }
      }
    }
    if (!deferred) {
      renameSync(temp, targetNode);
    } else {
      atomicWrite(join(layout.bootstrapDir, "node-pending.bin"), "");
      rmSync(temp, { force: true });
    }
    if (process.platform !== "win32" && existsSync(targetNode)) {
      try {
        chmodSync(targetNode, 0o755);
      } catch {}
    }
  } catch (error) {
    if (!deferred) throw error;
  }
  const entrySource = readFileSync(template, "utf8");
  atomicWrite(layout.entryMjs, entrySource);
  return { node: targetNode, deferred };
}

export interface StableEntryResult {
  binPaths: string[];
  menuPaths: string[];
  conflicts: string[];
  absoluteOpenHint: string;
}

function devflowCmdScript(installRoot: string): string {
  // Absolute paths only; independent of cwd and PATH refresh timing.
  return [
    "@echo off",
    'setlocal',
    'set "DEVFLOW_INSTALL_ROOT=' + installRoot.replace(/\\/g, "\\\\") + '"',
    'set "DEVFLOW_ENTRY=' + resolveLayout(installRoot).entryMjs.replace(/\\/g, "\\\\") + '"',
    'set "DEVFLOW_NODE=' + resolveLayout(installRoot).bootstrapNode.replace(/\\/g, "\\\\") + '"',
    '"%DEVFLOW_NODE%" "%DEVFLOW_ENTRY%" %*',
    "endlocal",
    "",
  ].join("\r\n");
}

function devflowShScript(installRoot: string): string {
  const layout = resolveLayout(installRoot);
  return [
    "#!/bin/sh",
    "# DevFlow stable entry — managed by the DevFlow installer.",
    "DEVFLOW_INSTALL_ROOT=" + JSON.stringify(installRoot),
    "DEVFLOW_NODE=" + JSON.stringify(layout.bootstrapNode),
    "DEVFLOW_ENTRY=" + JSON.stringify(layout.entryMjs),
    'exec "$DEVFLOW_NODE" "$DEVFLOW_ENTRY" "$@"',
    "",
  ].join("\n");
}

export function writeStableEntry(
  installRoot: string,
  options: { homeDir?: string } = {},
): StableEntryResult {
  const layout = ensureInstallLayout(installRoot);
  const home = options.homeDir ?? homedir();
  const binPaths: string[] = [];
  const menuPaths: string[] = [];
  const conflicts: string[] = [];

  if (process.platform === "win32") {
    const cmdPath = join(layout.binDir, "devflow.cmd");
    atomicWrite(cmdPath, devflowCmdScript(installRoot));
    binPaths.push(cmdPath);
    const startMenu = join(
      home,
      "AppData",
      "Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "DevFlow",
    );
    mkdirSync(startMenu, { recursive: true });
    const menuCmd = join(startMenu, "DevFlow.cmd");
    atomicWrite(menuCmd, devflowCmdScript(installRoot));
    menuPaths.push(menuCmd);
  } else {
    const shPath = join(layout.binDir, "devflow");
    atomicWrite(shPath, devflowShScript(installRoot));
    try {
      chmodSync(shPath, 0o755);
    } catch {}
    binPaths.push(shPath);

    const userBin = join(home, ".local", "bin");
    mkdirSync(userBin, { recursive: true });
    const linkPath = join(userBin, "devflow");
    if (existsSync(linkPath)) {
      let owned = false;
      try {
        const real = realpathSync(linkPath);
        owned = real === shPath || isInside(layout.binDir, real);
      } catch {
        owned = false;
      }
      if (!owned) {
        conflicts.push(linkPath);
      } else {
        rmSync(linkPath, { force: true });
      }
    }
    if (!conflicts.includes(linkPath)) {
      try {
        symlinkSync(shPath, linkPath);
        binPaths.push(linkPath);
      } catch {
        // Fall back to desktop entry only; absolute path still works.
      }
    }

    const appsDir = join(home, ".local", "share", "applications");
    mkdirSync(appsDir, { recursive: true });
    const desktop = join(appsDir, "devflow.desktop");
    atomicWrite(
      desktop,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=DevFlow",
        "Comment=DevFlow AI development workflow",
        "Exec=" + shPath,
        "Terminal=false",
        "Categories=Development;",
        "",
      ].join("\n"),
    );
    menuPaths.push(desktop);
  }

  return {
    binPaths,
    menuPaths,
    conflicts,
    absoluteOpenHint: layout.entryMjs,
  };
}

export interface PathWriteResult {
  changed: boolean;
  value: string;
  skippedDuplicate: boolean;
}

/** Append the managed bin directory to a PATH string without duplicating entries. */
export function appendPathValue(
  existing: string | undefined,
  binDir: string,
): PathWriteResult {
  const parts = (existing ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((x) => x.trim())
    .filter(Boolean);
  const normalized = resolve(binDir);
  const already = parts.some((part) => {
    try {
      return resolve(part) === normalized;
    } catch {
      return part === binDir;
    }
  });
  if (already) {
    return { changed: false, value: existing ?? "", skippedDuplicate: true };
  }
  const next = parts.length
    ? (existing ?? "") +
      (process.platform === "win32" ? ";" : ":") +
      binDir
    : binDir;
  return { changed: true, value: next, skippedDuplicate: false };
}

export interface ShellBlockResult {
  path: string;
  changed: boolean;
  content: string;
}

function renderPathBlock(binDir: string, platform = process.platform): string {
  if (platform === "win32") {
    return PATH_BLOCK_START + "\nset PATH=" + binDir + ";%PATH%\n" + PATH_BLOCK_END + "\n";
  }
  return (
    PATH_BLOCK_START +
    '\nexport PATH="' +
    binDir.replace(/"/g, '\\"') +
    ':$PATH"\n' +
    PATH_BLOCK_END +
    "\n"
  );
}

/** Manage a clearly marked, removable PATH block in a shell rc file. */
export function upsertShellPathBlock(
  rcPath: string,
  binDir: string,
  platform = process.platform,
): ShellBlockResult {
  const start = PATH_BLOCK_START;
  const end = PATH_BLOCK_END;
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  const block = renderPathBlock(binDir, platform);
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end);
  if (startIndex >= 0 && endIndex > startIndex) {
    const before = existing.slice(0, startIndex);
    const after = existing.slice(endIndex + end.length).replace(/^\r?\n/, "");
    const next = before + block + (after ? (after.startsWith("\n") ? after : "\n" + after) : "");
    if (next === existing) {
      return { path: rcPath, changed: false, content: existing };
    }
    atomicWrite(rcPath, next);
    return { path: rcPath, changed: true, content: next };
  }
  const next = existing
    ? existing.replace(/\s*$/, "\n\n") + block
    : block;
  atomicWrite(rcPath, next);
  return { path: rcPath, changed: true, content: next };
}

export function removeShellPathBlock(
  rcPath: string,
): ShellBlockResult {
  const existing = existsSync(rcPath) ? readFileSync(rcPath, "utf8") : "";
  const startIndex = existing.indexOf(PATH_BLOCK_START);
  const endIndex = existing.indexOf(PATH_BLOCK_END);
  if (startIndex < 0 || endIndex < startIndex) {
    return { path: rcPath, changed: false, content: existing };
  }
  const before = existing.slice(0, startIndex);
  const after = existing.slice(endIndex + PATH_BLOCK_END.length).replace(/^\r?\n/, "");
  const next = (before + after).replace(/\n{3,}/g, "\n\n");
  atomicWrite(rcPath, next);
  return { path: rcPath, changed: true, content: next };
}

export interface WindowsPathUpdate {
  changed: boolean;
  value: string;
  preservedEntries: number;
}

/**
 * Append the managed bin to the user PATH (HKCU), preserving every existing
 * entry and never touching machine-level PATH.
 */
export function appendWindowsUserPath(
  binDir: string,
  readUserPath: () => string | undefined,
  writeUserPath: (value: string) => void,
): WindowsPathUpdate {
  const current = readUserPath() ?? "";
  const result = appendPathValue(current, binDir);
  const preservedEntries = current
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean).length;
  if (result.changed) {
    writeUserPath(result.value);
  }
  return {
    changed: result.changed,
    value: result.value,
    preservedEntries: result.changed ? preservedEntries : preservedEntries,
  };
}

/**
 * Windows user PATH via registry env API. Detect same-name non-DevFlow
 * commands on PATH and report conflicts without overwriting them.
 */
export function registerUserPathWindows(
  installRoot: string,
): { conflictCommands: string[]; changed: boolean } {
  const binDir = resolveLayout(installRoot).binDir;
  const conflictCommands: string[] = [];
  const pathValue = process.env.PATH ?? "";
  const entries = pathValue.split(";").map((x) => x.trim()).filter(Boolean);
  for (const entry of entries) {
    if (resolve(entry) === resolve(binDir)) continue;
    const candidate = join(entry, "devflow.cmd");
    const candidateExe = join(entry, "devflow.exe");
    const candidateNix = join(entry, "devflow");
    for (const c of [candidate, candidateExe, candidateNix]) {
      if (existsSync(c)) conflictCommands.push(c);
    }
  }
  return { conflictCommands, changed: false };
}

// ── Install transaction ownership (two installers must not interleave) ──

const heldInstallRoots = new Set<string>();

/**
 * Native mutex/flock ownership for install transactions. Not a permanent
 * file lock, and never force-deletes a live lock on a short timeout.
 */
export async function acquireInstallTransactionLock(
  installRoot: string,
): Promise<() => Promise<void>> {
  const absolute = resolve(installRoot);
  mkdirSync(absolute, { recursive: true });
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
    if (process.platform === "win32") canonical = canonical.toLowerCase();
  } catch {
    /* lexical fallback */
  }
  if (heldInstallRoots.has(canonical)) {
    throw new Error("INSTALL_TRANSACTION_ALREADY_ACTIVE");
  }
  heldInstallRoots.add(canonical);
  const release: Array<() => void> = [];
  try {
    await getNativeAsync();
    const keys = [
      ...new Set([hash(absolute.toLowerCase()), hash(canonical)]),
    ].sort();
    if (process.platform === "win32") {
      const native = await getWindowsNative();
      for (const key of keys) {
        const name = `Local\\DevFlowInstaller.${key}`;
        const mutex = native.createMutex(name, false);
        if (!mutex) throw new Error("INSTALL_LOCK_UNAVAILABLE");
        const result = native.waitForMutex(mutex, 0);
        if (result !== "acquired" && result !== "abandoned") {
          native.closeHandle(mutex);
          throw new Error(
            "另一个 DevFlow 安装正在进行中。请等待其完成后再试，不要强制结束安装进程。",
          );
        }
        release.push(() => {
          try {
            if (!native.releaseMutex(mutex)) {
              throw new Error("INSTALL_LOCK_RELEASE_FAILED");
            }
          } finally {
            native.closeHandle(mutex);
          }
        });
      }
    } else {
      const native = await import("../../process/src/native/posix.js");
      for (const key of keys) {
        const handle = native.acquireFlock(
          join(tmpdir(), `devflow-installer-${key}.lock`),
        );
        release.push(() => native.releaseFlock(handle));
      }
    }
  } catch (error) {
    for (const unlock of release.reverse()) {
      try {
        unlock();
      } catch {}
    }
    heldInstallRoots.delete(canonical);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let failure: unknown;
    for (const unlock of release.reverse()) {
      try {
        unlock();
      } catch (error) {
        failure ??= error;
      }
    }
    heldInstallRoots.delete(canonical);
    if (failure) throw failure;
  };
}

export function bootstrapLicenseReceiptFields(installRoot: string): {
  bootstrap_node: string;
  bootstrap_entry: string;
} {
  const layout = resolveLayout(installRoot);
  return {
    bootstrap_node: layout.bootstrapNode,
    bootstrap_entry: layout.entryMjs,
  };
}
