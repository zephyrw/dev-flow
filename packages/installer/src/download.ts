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
    entryRelativePath.startsWith("/")
  ) {
    return false;
  }
  const rel = relative(
    resolve(targetBase),
    resolve(targetBase, entryRelativePath),
  );
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}
