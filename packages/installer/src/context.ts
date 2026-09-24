/**
 * Unified InstallationContext for DevFlow (DFP-R05).
 *
 * Strict separation of:
 * - installRoot: current.json, bootstrap layer, versions, transactions, bin
 * - versionRoot: version payload (package.json, dist/, runtime/, node_modules/)
 * - configPath: DEVFLOW_CONFIG or <installRoot>/devflow.yaml
 * - storageRoot: parsed from configuration (default <installRoot>/state)
 * - workspaceRoot: project workspace directory
 * - nodePath: runtime node binary
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { resolveLayout } from "./launchers.js";

export interface InstallationContext {
  installRoot: string;
  versionRoot: string;
  configPath: string;
  storageRoot: string;
  workspaceRoot: string;
  nodePath: string;
}

export function defaultInstallRoot(): string {
  if (process.platform === "win32") {
    return join(homedir(), "AppData", "Local", "Programs", "DevFlow");
  }
  return join(homedir(), ".local", "share", "devflow");
}

export function resolveInstallationContext(options?: {
  installRoot?: string;
  versionRoot?: string;
  configPath?: string;
}): InstallationContext {
  // 1. Resolve versionRoot: where package.json, dist/ and runtime live
  let versionRoot = options?.versionRoot ?? process.env.DEVFLOW_VERSION_ROOT;
  if (!versionRoot) {
    try {
      const selfDir = dirname(fileURLToPath(import.meta.url));
      // Try resolving package root from dist/packages/installer/src or packages/installer/src
      const candidateRoots = [
        resolve(selfDir, "../../../.."),
        resolve(selfDir, "../../.."),
        resolve(selfDir, "../.."),
        process.cwd(),
      ];
      for (const root of candidateRoots) {
        if (existsSync(join(root, "package.json"))) {
          versionRoot = root;
          break;
        }
      }
    } catch {
      versionRoot = process.cwd();
    }
    if (!versionRoot) versionRoot = process.cwd();
  }
  versionRoot = resolve(versionRoot);

  // 2. Resolve installRoot: where current.json, bootstrap/, versions/, bin/ live
  let installRoot = options?.installRoot ?? process.env.DEVFLOW_INSTALL_ROOT;
  if (!installRoot) {
    // Check if versionRoot is versions/<version> of installRoot
    const candidateInstallRoot = resolve(versionRoot, "../..");
    if (
      existsSync(join(candidateInstallRoot, "current.json")) ||
      existsSync(join(candidateInstallRoot, "bootstrap"))
    ) {
      installRoot = candidateInstallRoot;
    } else {
      installRoot = versionRoot; // Source/development mode fallback
    }
  }
  installRoot = resolve(installRoot);

  // 3. Resolve configPath
  let configPath = options?.configPath ?? process.env.DEVFLOW_CONFIG;
  if (!configPath) {
    const layout = resolveLayout(installRoot);
    if (existsSync(layout.configFile)) {
      configPath = layout.configFile;
    } else if (existsSync(join(versionRoot, "devflow.yaml"))) {
      configPath = join(versionRoot, "devflow.yaml");
    } else {
      configPath = layout.configFile;
    }
  }
  configPath = resolve(configPath);

  // 4. Resolve storageRoot from config or default to installRoot/state
  let storageRoot = join(installRoot, "state");
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf8");
      const match = content.match(/^storage_root:\s*["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) {
        storageRoot = resolve(dirname(configPath), match[1].trim());
      }
    } catch {
      /* ignore */
    }
  }

  // 5. Resolve nodePath
  let nodePath = process.execPath;
  const layout = resolveLayout(installRoot);
  if (existsSync(layout.bootstrapNode)) {
    nodePath = layout.bootstrapNode;
  } else {
    const versionNode = join(
      versionRoot,
      "runtime",
      process.platform === "win32" ? "node.exe" : "node",
    );
    if (existsSync(versionNode)) {
      nodePath = versionNode;
    }
  }

  const workspaceRoot = process.cwd();

  return {
    installRoot,
    versionRoot,
    configPath,
    storageRoot,
    workspaceRoot,
    nodePath,
  };
}
