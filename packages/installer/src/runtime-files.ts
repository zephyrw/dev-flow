/**
 * Reader for the shared runtime/compliance file manifest (C stream product).
 * Single source for build verification, install copy lists, and tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RuntimeFileCategory =
  | "app"
  | "runtime"
  | "native"
  | "compliance"
  | "skills";

export interface PlatformCondition {
  os?: string | string[];
  arch?: string | string[];
  platforms?: string[];
}

export interface RuntimeFileEntry {
  path: string;
  kind?: "file" | "directory";
  category: RuntimeFileCategory;
  required: boolean | PlatformCondition;
  any_of?: string[];
}

export interface RuntimeFilesManifest {
  schema_version?: number;
  description?: string;
  entries: RuntimeFileEntry[];
}

const CATEGORIES = new Set<RuntimeFileCategory>([
  "app",
  "runtime",
  "native",
  "compliance",
  "skills",
]);

export function parseRuntimeFilesManifest(raw: unknown): RuntimeFilesManifest {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).entries)
      ? (raw as any).entries
      : null;
  if (!list) {
    throw new Error("安装包不完整：runtime-files.json 形状无效");
  }
  const entries: RuntimeFileEntry[] = [];
  for (const item of list as any[]) {
    if (!item || typeof item !== "object") {
      throw new Error("安装包不完整：runtime-files.json 条目无效");
    }
    const path = item.path;
    const category = item.category;
    const required = item.required;
    const kind = item.kind === "directory" ? "directory" : "file";
    const any_of = Array.isArray(item.any_of) ? item.any_of : undefined;
    if (typeof path !== "string" || !path || path.includes("\0")) {
      throw new Error("安装包不完整：runtime-files.json 路径无效");
    }
    if (!CATEGORIES.has(category)) {
      throw new Error("安装包不完整：runtime-files.json 分类无效：" + path);
    }
    const validRequired =
      typeof required === "boolean" ||
      (required &&
        typeof required === "object" &&
        (Array.isArray(required.platforms) ||
          required.os !== undefined ||
          required.arch !== undefined));
    if (!validRequired) {
      throw new Error("安装包不完整：runtime-files.json required 无效：" + path);
    }
    entries.push({ path, kind, category, required, any_of });
  }
  if (!entries.length) {
    throw new Error("安装包不完整：runtime-files.json 为空");
  }
  return { entries };
}

export function readRuntimeFilesManifest(
  packageRoot: string,
  platform = process.platform,
  arch = process.arch,
): RuntimeFilesManifest {
  const file = join(packageRoot, "runtime-files.json");
  if (!existsSync(file)) {
    throw new Error("安装包不完整：缺少 runtime-files.json 运行与合规文件清单");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("安装包不完整：runtime-files.json 无法解析");
  }
  const manifest = parseRuntimeFilesManifest(parsed);
  return {
    entries: manifest.entries.filter((entry) =>
      entryAppliesTo(entry, platform, arch),
    ),
  };
}

export function entryAppliesTo(
  entry: RuntimeFileEntry,
  platform = process.platform,
  arch = process.arch,
): boolean {
  if (entry.required === true || entry.required === false) return true;
  const req = entry.required as PlatformCondition;
  if (Array.isArray(req.platforms)) {
    if (
      req.platforms.includes(platform) ||
      req.platforms.includes(`${platform}-${arch}`)
    ) {
      return true;
    }
  }
  if (req.os !== undefined) {
    const osList = Array.isArray(req.os) ? req.os : [req.os];
    if (!osList.includes(platform)) return false;
    if (req.arch !== undefined) {
      const archList = Array.isArray(req.arch) ? req.arch : [req.arch];
      if (!archList.includes(arch)) return false;
    }
    return true;
  }
  return false;
}

export function requiredEntries(
  manifest: RuntimeFilesManifest,
  platform = process.platform,
  arch = process.arch,
): RuntimeFileEntry[] {
  return manifest.entries.filter((entry) => {
    if (!entryAppliesTo(entry, platform, arch)) return false;
    if (entry.required === false) return false;
    if (entry.required === true) return true;
    const req = entry.required as PlatformCondition;
    if (Array.isArray(req.platforms)) {
      return (
        req.platforms.includes(platform) ||
        req.platforms.includes(`${platform}-${arch}`)
      );
    }
    if (req.os !== undefined) {
      const osList = Array.isArray(req.os) ? req.os : [req.os];
      if (!osList.includes(platform)) return false;
      if (req.arch !== undefined) {
        const archList = Array.isArray(req.arch) ? req.arch : [req.arch];
        return archList.includes(arch);
      }
      return true;
    }
    return false;
  });
}

/** Resolve the actual candidate path on disk (respecting any_of fallback). */
export function resolveEntryPath(sourceDir: string, entry: RuntimeFileEntry): string {
  if (entry.any_of && entry.any_of.length > 0) {
    for (const cand of entry.any_of) {
      if (existsSync(join(sourceDir, cand))) return cand;
    }
  }
  return entry.path;
}

/** Paths the installer must copy into the immutable version directory. */
export function copyListFromManifest(
  manifest: RuntimeFilesManifest,
): string[] {
  const tops = new Set<string>();
  for (const entry of manifest.entries) {
    const top = entry.path.split("/")[0] ?? entry.path;
    tops.add(top);
    // Always carry explicit compliance metadata even when nested.
    if (entry.category === "compliance") tops.add(entry.path);
  }
  // Ensure critical root files are explicitly copied
  tops.add("package.json");
  tops.add("pnpm-lock.yaml");
  tops.add("pnpm-workspace.yaml");
  tops.add("build-info.json");
  tops.add("runtime-files.json");
  return [...tops];
}

export const COMPLIANCE_BASENAMES = [
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "sbom.json",
  "build-info.json",
  "compatibility.json",
  "runtime-files.json",
] as const;
