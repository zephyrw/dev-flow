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

export interface RuntimeFileEntry {
  path: string;
  category: RuntimeFileCategory;
  required: boolean | { platforms: string[] };
}

export interface RuntimeFilesManifest {
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
        Array.isArray(required.platforms) &&
        required.platforms.every((p: unknown) => typeof p === "string"));
    if (!validRequired) {
      throw new Error("安装包不完整：runtime-files.json required 无效：" + path);
    }
    entries.push({ path, category, required });
  }
  if (!entries.length) {
    throw new Error("安装包不完整：runtime-files.json 为空");
  }
  return { entries };
}

export function readRuntimeFilesManifest(
  packageRoot: string,
  platform = process.platform,
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
      entryAppliesTo(entry, platform),
    ),
  };
}

export function entryAppliesTo(
  entry: RuntimeFileEntry,
  platform = process.platform,
): boolean {
  if (entry.required === true) return true;
  if (entry.required === false) return true;
  return entry.required.platforms.includes(platform);
}

export function requiredEntries(
  manifest: RuntimeFilesManifest,
  platform = process.platform,
): RuntimeFileEntry[] {
  return manifest.entries.filter(
    (entry) =>
      entryAppliesTo(entry, platform) &&
      entry.required !== false &&
      (entry.required === true ||
        (typeof entry.required === "object" &&
          entry.required.platforms.includes(platform))),
  );
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
