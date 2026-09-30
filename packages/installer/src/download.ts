import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export interface VerificationResult {
  valid: boolean;
  actualHash?: string;
  expectedHash: string;
  error?: string;
}

export function verifyFileSha256(
  filePath: string,
  expectedHash: string,
): VerificationResult {
  if (!existsSync(filePath)) {
    return { valid: false, expectedHash, error: "文件不存在" };
  }
  const content = readFileSync(filePath);
  const actualHash = createHash("sha256").update(content).digest("hex");
  return {
    valid: actualHash.toLowerCase() === expectedHash.toLowerCase(),
    actualHash,
    expectedHash,
  };
}

export function isSafeExtractionPath(
  targetBase: string,
  entryRelativePath: string,
): boolean {
  if (
    !entryRelativePath ||
    /[:\\\\]/.test(entryRelativePath) ||
    entryRelativePath.split("/").includes("..") ||
    entryRelativePath.split("\\").includes("..") ||
    entryRelativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(entryRelativePath) ||
    entryRelativePath.includes("\0")
  ) {
    return false;
  }
  const rel = relative(
    resolve(targetBase),
    resolve(targetBase, entryRelativePath),
  );
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

export type ArchiveEntryType = "file" | "directory" | "symlink" | "hardlink" | "other";

export interface ArchiveEntrySafety {
  safe: boolean;
  reason?: string;
}

/**
 * Reject absolute paths, `..`, symbolic links, hard links, and any write that
 * would escape the staging root — before extraction touches the filesystem.
 */
export function assertSafeArchiveEntry(
  targetBase: string,
  entryRelativePath: string,
  entryType: ArchiveEntryType,
  linkTarget?: string,
): ArchiveEntrySafety {
  if (entryType === "symlink" || entryType === "hardlink") {
    return {
      safe: false,
      reason: "归档含符号链接或硬链接，拒绝解压以避免跨根写入",
    };
  }
  if (entryType === "other") {
    return { safe: false, reason: "归档含不支持的条目类型" };
  }
  if (!isSafeExtractionPath(targetBase, entryRelativePath)) {
    return { safe: false, reason: "归档路径逃逸：" + entryRelativePath };
  }
  if (linkTarget !== undefined) {
    if (
      linkTarget.includes("\0") ||
      isAbsolute(linkTarget) ||
      linkTarget.split("/").includes("..") ||
      linkTarget.split("\\").includes("..")
    ) {
      return { safe: false, reason: "归档链接目标不安全" };
    }
  }
  return { safe: true };
}

/** True when a copy/write target stays under targetBase after resolve. */
export function isWithinRoot(targetBase: string, candidate: string): boolean {
  const rel = relative(resolve(targetBase), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
