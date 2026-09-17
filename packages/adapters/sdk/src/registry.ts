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

/**
 * 统一在系统 PATH、受管目录与显式路径中查找可执行文件
 */
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
  const isWindows = process.platform === "win32";
  const nameWithExt =
    isWindows && !binaryName.endsWith(".exe") && !binaryName.endsWith(".cmd")
      ? [
          `${binaryName}.exe`,
          `${binaryName}.cmd`,
          `${binaryName}.ps1`,
          binaryName,
        ]
      : [binaryName];

  for (const dir of fallbackDirs) {
    for (const name of nameWithExt) {
      const full = `${dir}/${name}`;
      if (existsSync(full)) return full;
    }
  }

  // 从 PATH 查找
  const pathEnv = process.env.PATH ?? "";
  const pathDirs = pathEnv.split(isWindows ? ";" : ":");
  for (const p of pathDirs) {
    for (const name of nameWithExt) {
      const full = `${p.trim()}/${name}`;
      if (existsSync(full)) return full;
    }
  }

  return undefined;
}
