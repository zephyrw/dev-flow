import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import type {
  NativeAgentAdapter,
  CapabilityReport,
  ProbeRequest,
} from "./interface.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export class AdapterRegistry {
  private adapters = new Map<SupportedAdapterId, NativeAgentAdapter>();

  register(id: SupportedAdapterId, adapter: NativeAgentAdapter): void {
    this.adapters.set(id, adapter);
  }

  get(id: SupportedAdapterId): NativeAgentAdapter | undefined {
    return this.adapters.get(id);
  }

  mustGet(id: SupportedAdapterId): NativeAgentAdapter {
    const adapter = this.get(id);
    if (!adapter) {
      throw new Error(`未注册的适配器: ${id}`);
    }
    return adapter;
  }

  getAll(): Map<SupportedAdapterId, NativeAgentAdapter> {
    return new Map(this.adapters);
  }

  async probeAll(): Promise<Record<SupportedAdapterId, CapabilityReport>> {
    const results: Partial<Record<SupportedAdapterId, CapabilityReport>> = {};
    for (const [id, adapter] of this.adapters.entries()) {
      results[id] = await adapter.probe({
        toolProfile: {
          id: `profile-${id}`,
          revision: 1,
          adapterId: id,
          modelSelection: "native-config",
          options: {},
        },
      });
    }
    return results as Record<SupportedAdapterId, CapabilityReport>;
  }
}

export const QODER_BINARY_CANDIDATES = ["qodercli", "qoder"] as const;
export const QODER_PRODUCT_IDENTITY = "qodercli|\\bqoder\\b";

export function binaryNamesForLookup(binaryName: string): string[] {
  if (binaryName === "qoder" || binaryName === "qodercli") {
    return [...QODER_BINARY_CANDIDATES];
  }
  return [binaryName];
}

export function isQoderProductIdentity(versionAndHelp: string): boolean {
  return new RegExp(QODER_PRODUCT_IDENTITY, "i").test(versionAndHelp);
}

function namesWithPlatformExt(binaryName: string): string[] {
  const isWindows = process.platform === "win32";
  if (
    isWindows &&
    !binaryName.endsWith(".exe") &&
    !binaryName.endsWith(".cmd")
  ) {
    return [
      `${binaryName}.exe`,
      `${binaryName}.cmd`,
      `${binaryName}.ps1`,
      binaryName,
    ];
  }
  return [binaryName];
}

function findExecutableByName(
  binaryName: string,
  fallbackDirs: string[],
): string | undefined {
  const names = namesWithPlatformExt(binaryName);
  for (const dir of fallbackDirs) {
    for (const name of names) {
      const full = `${dir}/${name}`;
      if (existsSync(full)) return full;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  const pathDirs = pathEnv.split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    for (const name of names) {
      const full = `${dir.trim()}/${name}`;
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

/**
 * 统一在系统 PATH、受管目录与显式路径中查找可执行文件
 */
export const ADAPTER_BINARY_NAMES: Record<SupportedAdapterId, string> = {
  codex: "codex",
  agy: "agy",
  "grok-build": "grok",
  "claude-code": "claude",
  "kimi-code": "kimi",
  qoder: "qodercli",
  opencode: "opencode",
  "cursor-agent": "agent",
  "mimo-code": "mimo",
};

export type AdapterExecutableResolver = (
  adapterId: SupportedAdapterId,
  customPath?: string,
) => string | undefined;

let executableResolver: AdapterExecutableResolver | undefined;

/** Bootstrap-time dependency injection for embedding hosts and isolated fixtures.
 * An installed resolver is authoritative, including a not-found result.
 */
export function setAdapterExecutableResolver(
  resolver: AdapterExecutableResolver,
): () => void {
  const previous = executableResolver;
  executableResolver = resolver;
  return () => {
    if (executableResolver === resolver) executableResolver = previous;
  };
}

export function defaultAdapterFallbackDirs(): string[] {
  return [
    ...(process.env.LOCALAPPDATA
      ? [
          process.env.LOCALAPPDATA + "/agy/bin",
          process.env.LOCALAPPDATA + "/cursor-agent",
        ]
      : []),
    ...(process.env.APPDATA ? [process.env.APPDATA + "/npm"] : []),
    ...(process.env.HOME ? [process.env.HOME + "/.local/bin"] : []),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
}

export function resolveAdapterExecutable(
  adapterId: SupportedAdapterId,
  customPath?: string,
): string | undefined {
  if (executableResolver) return executableResolver(adapterId, customPath);
  return resolveToolExecutable(
    ADAPTER_BINARY_NAMES[adapterId],
    customPath,
    defaultAdapterFallbackDirs(),
  );
}

export function resolveToolExecutable(
  binaryName: string,
  customPath?: string,
  fallbackDirs: string[] = [],
): string | undefined {
  if (customPath) {
    if (existsSync(customPath)) return customPath;
    if (/[\\/\\\\:]/.test(customPath)) return undefined;
    binaryName = customPath;
  }
  for (const name of binaryNamesForLookup(binaryName)) {
    const found = findExecutableByName(name, fallbackDirs);
    if (found) return found;
  }
  return undefined;
}
