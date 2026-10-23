import { closeSync, openSync, rmSync, writeFileSync } from "node:fs";

/** No subprocess can read these new Run files until the whole factory returns. */
export function writePermissionArtifacts(files: ReadonlyArray<{ path: string; content: string }>): () => void {
  const owned: string[] = [];
  const cleanup = () => {
    const errors: unknown[] = [];
    for (const path of owned) {
      try { rmSync(path, { force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Could not remove Run permission artifacts");
  };
  try {
    for (const file of files) {
      // Exclusive creation preserves an existing file and avoids orphaned atomic-write temp files.
      const fd = openSync(file.path, "wx", 0o600);
      owned.push(file.path);
      try { writeFileSync(fd, file.content); } finally { closeSync(fd); }
    }
    return cleanup;
  } catch (error) {
    try { cleanup(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Run permission artifact creation and cleanup failed");
    }
    throw error;
  }
}
