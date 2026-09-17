import {
  readdirSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import type { WorkspaceReference } from "../../contracts/src/feedback.js";
import { id } from "../../core/src/util.js";

interface CacheEntry {
  paths: Array<{
    relative_path: string;
    kind: "file" | "directory";
    ref_id: string;
    repo_id: string;
  }>;
  cachedAt: number;
  sizeBytes: number;
}

const MAX_PROJECT_CACHE_BYTES = 8 * 1024 * 1024; // 8MiB
const MAX_GLOBAL_CACHE_BYTES = 32 * 1024 * 1024; // 32MiB
const CACHE_TTL_MS = 60 * 1000; // 60秒过期
const MAX_PREVIEW_BYTES = 256 * 1024; // 256KiB

class ReferencePathCache {
  private cache = new Map<string, CacheEntry>();
  private totalBytes = 0;

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      this.delete(key);
      return undefined;
    }
    return entry;
  }

  set(
    key: string,
    paths: Array<{
      relative_path: string;
      kind: "file" | "directory";
      ref_id: string;
      repo_id: string;
    }>,
  ) {
    let size = 0;
    for (const p of paths) {
      size += p.relative_path.length * 2 + 32;
    }
    if (size > MAX_PROJECT_CACHE_BYTES) return;

    this.delete(key);
    while (
      this.totalBytes + size > MAX_GLOBAL_CACHE_BYTES &&
      this.cache.size > 0
    ) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.delete(oldestKey);
      else break;
    }

    this.cache.set(key, { paths, cachedAt: Date.now(), sizeBytes: size });
    this.totalBytes += size;
  }

  delete(key: string) {
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
      this.cache.delete(key);
    }
  }
}

const globalPathCache = new ReferencePathCache();

function isSafeRelative(rel: string): boolean {
  if (!rel) return true;
  const p = rel.replaceAll("\\", "/");
  if (
    p.startsWith("/") ||
    p.includes(":") ||
    p.split("/").some((s) => s === ".." || s === ".")
  ) {
    return false;
  }
  return true;
}

function isPathInside(baseDir: string, targetPath: string): boolean {
  try {
    const realBase = realpathSync(baseDir);
    const realTarget = realpathSync(targetPath);
    const rel = relative(realBase, realTarget);
    return !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

export class WorkspaceReferenceService {
  /**
   * 逐级列出目录下的直接文件与子目录（统一结构化返回，RQ-10）
   */
  static listDirectory(
    repoRoot: string,
    dirRelativePath: string = "",
    cursor: number = 0,
    limit: number = 100,
    repoId: string = "main",
  ): {
    items: Array<{
      ref_id: string;
      repo_id: string;
      relative_path: string;
      kind: "file" | "directory";
      name: string;
    }>;
    nextCursor?: number;
  } {
    if (!isSafeRelative(dirRelativePath)) {
      throw new Error("访问路径越界超出工作区范围");
    }
    const fullDirPath = resolve(repoRoot, dirRelativePath);
    if (!isPathInside(repoRoot, fullDirPath)) {
      throw new Error("访问路径越界超出工作区范围");
    }
    if (!existsSync(fullDirPath)) {
      return { items: [] };
    }

    const dirents = readdirSync(fullDirPath, { withFileTypes: true });
    dirents.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const pageSlice = dirents.slice(cursor, cursor + limit);
    const items = pageSlice.map((d) => {
      const childRel = dirRelativePath
        ? `${dirRelativePath}/${d.name}`
        : d.name;
      const normRel = childRel.replaceAll("\\", "/");
      return {
        ref_id: id("ref"),
        repo_id: repoId,
        relative_path: normRel,
        kind: d.isDirectory() ? ("directory" as const) : ("file" as const),
        name: d.name,
      };
    });

    const nextCursor =
      cursor + limit < dirents.length ? cursor + limit : undefined;
    return { items, nextCursor };
  }

  /**
   * 搜索匹配的工作区文件与目录（统一字段与截断，RQ-10）
   */
  static searchReferences(
    repoRoot: string,
    query: string,
    cursor: number = 0,
    limit: number = 50,
    repoId: string = "main",
  ): {
    items: Array<{
      ref_id: string;
      repo_id: string;
      relative_path: string;
      kind: "file" | "directory";
    }>;
    nextCursor?: number;
    truncated?: boolean;
  } {
    const normQuery = query.trim().toLowerCase();
    let allPaths = globalPathCache.get(repoRoot)?.paths;

    if (!allPaths) {
      allPaths = [];
      const queue = [""];
      const visitedCount = { count: 0 };
      while (queue.length > 0 && visitedCount.count < 10000) {
        const cur = queue.shift()!;
        try {
          const fullPath = resolve(repoRoot, cur);
          const entries = readdirSync(fullPath, { withFileTypes: true });
          for (const ent of entries) {
            visitedCount.count++;
            if (ent.name === ".git" || ent.name === "node_modules") continue;
            const relChild = cur ? `${cur}/${ent.name}` : ent.name;
            const normRel = relChild.replaceAll("\\", "/");
            const kind = ent.isDirectory()
              ? ("directory" as const)
              : ("file" as const);
            allPaths.push({
              ref_id: id("ref"),
              repo_id: repoId,
              relative_path: normRel,
              kind,
            });
            if (ent.isDirectory() && queue.length < 500) {
              queue.push(normRel);
            }
          }
        } catch {}
      }
      globalPathCache.set(repoRoot, allPaths);
    }

    const matches = allPaths.filter(
      (p) => !normQuery || p.relative_path.toLowerCase().includes(normQuery),
    );

    const page = matches.slice(cursor, cursor + limit);
    const nextCursor =
      cursor + limit < matches.length ? cursor + limit : undefined;
    return {
      items: page,
      nextCursor,
      truncated: matches.length > 500,
    };
  }

  /**
   * 准确解析单个引用状态（深度防御 junction 与越界逃逸，RQ-11）
   */
  static resolveReference(
    repoRoot: string,
    repoId: string,
    relativePath: string,
  ): WorkspaceReference {
    const normRel = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
    const fullPath = resolve(repoRoot, normRel);
    const logicalRel = relative(resolve(repoRoot), fullPath);
    if (
      logicalRel.startsWith("..") ||
      isAbsolute(logicalRel) ||
      !isSafeRelative(normRel)
    ) {
      return {
        ref_id: id("ref"),
        repo_id: repoId,
        relative_path: normRel,
        kind: "file",
        availability: "outside_workspace",
        label: normRel,
      };
    }

    if (!existsSync(fullPath)) {
      return {
        ref_id: id("ref"),
        repo_id: repoId,
        relative_path: normRel,
        kind: "file",
        availability: "missing",
        label: normRel,
      };
    }

    if (!isPathInside(repoRoot, fullPath)) {
      return {
        ref_id: id("ref"),
        repo_id: repoId,
        relative_path: normRel,
        kind: "file",
        availability: "outside_workspace",
        label: normRel,
      };
    }

    let kind: "file" | "directory" = "file";
    try {
      const st = statSync(fullPath);
      kind = st.isDirectory() ? "directory" : "file";
    } catch {
      return {
        ref_id: id("ref"),
        repo_id: repoId,
        relative_path: normRel,
        kind: "file",
        availability: "unreadable",
        label: normRel,
      };
    }

    return {
      ref_id: id("ref"),
      repo_id: repoId,
      relative_path: normRel,
      kind,
      availability: "available",
      label: normRel,
      selected_at: new Date().toISOString(),
    };
  }

  /**
   * 读取单次文本预览，上限 256KiB，严格防御路径穿越 (RQ-11)
   */
  static readTextPreview(
    repoRoot: string,
    relativePath: string,
  ): { text: string; truncated: boolean; bytesRead: number } {
    if (!isSafeRelative(relativePath)) {
      throw new Error("访问路径越界超出工作区范围");
    }
    const fullPath = resolve(repoRoot, relativePath);
    if (!isPathInside(repoRoot, fullPath)) {
      throw new Error("访问路径越界超出工作区范围");
    }
    if (!existsSync(fullPath)) {
      return { text: "", truncated: false, bytesRead: 0 };
    }

    const st = statSync(fullPath);
    if (st.isDirectory()) {
      return {
        text: "[目录引用，按需由模型原生读取]",
        truncated: false,
        bytesRead: 0,
      };
    }

    const fd = openSync(fullPath, "r");
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_PREVIEW_BYTES));
      const bytesRead = readSync(fd, buf, 0, buf.length, 0);
      const text = buf.subarray(0, bytesRead).toString("utf8");
      const truncated = st.size > MAX_PREVIEW_BYTES;
      return {
        text: truncated ? text + "\n... [预览已截断，超出256KiB]" : text,
        truncated,
        bytesRead,
      };
    } finally {
      closeSync(fd);
    }
  }
}
