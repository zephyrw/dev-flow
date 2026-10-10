import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

// Type checking precedes build in CI. Use the host's source loader first so
// coverage observes the same transformed code that actually executes. Standalone
// Node needs tsx for unsupported TypeScript syntax; never load stale dist.
async function loadRedaction() {
  try { return await import("../../packages/presentation/src/secret-redactor.ts"); }
  catch (error) {
    if (error?.code !== "ERR_UNKNOWN_FILE_EXTENSION" &&
        error?.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") throw error;
  }
  const { tsImport } = await import("tsx/esm/api");
  return tsImport("../../packages/presentation/src/secret-redactor.ts", import.meta.url);
}

export async function runTypecheck(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const reportRoot = resolve(cwd, ".cache/quality");
  mkdirSync(reportRoot, { recursive: true });
  const summaryFile = join(reportRoot, "typecheck-summary.json");
  const save = (exitCode, signal, error, stdout, stderr) => {
    const summary = {
      status: exitCode === 0 ? "passed" : "failed",
      exit_code: exitCode,
      signal,
      error,
      stdout_summary: stdout,
      stderr_summary: stderr,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    return summary;
  };

  let redaction;
  try { redaction = await loadRedaction(); }
  catch { return save(1, null, "TYPECHECK_REDACTOR_LOAD_FAILED", "", ""); }

  const { DiagnosticRedactionContext, DiagnosticStreamRedactor } = redaction;
  const context = new DiagnosticRedactionContext();
  const captured = { stdout: "", stderr: "" };
  const destinations = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  const isWin = process.platform === "win32";
  let child;
  try {
    child = (options.spawn ?? spawn)(isWin ? "pnpm.cmd" : "pnpm", ["typecheck"], {
      cwd, stdio: ["ignore", "pipe", "pipe"], shell: isWin, windowsHide: true,
    });
  } catch { return save(1, null, "TYPECHECK_START_FAILED", "", ""); }

  let startFailed = false;
  const completion = new Promise((resolveExit) => {
    // Launch failures emit error followed by close. Do not log the raw Error,
    // which may contain command arguments or private host paths.
    child.once("error", () => { startFailed = true; });
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  const pump = (stream) => {
    const redactor = new DiagnosticStreamRedactor(64 * 1024, context);
    const emitSafe = (text) => {
      // Retain the previous wrapper's masking of standalone GitHub tokens too.
      const safe = text.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}/g, "[REDACTED]");
      captured[stream] = (captured[stream] + safe).slice(-8000);
      return safe;
    };
    const projection = new Transform({
      decodeStrings: false,
      transform(chunk, _encoding, callback) {
        try { callback(null, emitSafe(redactor.push(chunk))); }
        catch (error) { callback(error); }
      },
      flush(callback) {
        try { callback(null, emitSafe(redactor.push("", true))); }
        catch (error) { callback(error); }
      },
    });
    child[stream].setEncoding("utf8");
    // The destination sees only projected records; pipeline supplies backpressure
    // and never ends the parent's stdout/stderr after one child finishes.
    return pipeline(child[stream], projection, destinations[stream], { end: false })
      .catch((error) => {
        child.kill?.();
        throw error;
      });
  };
  const outputDone = Promise.allSettled([pump("stdout"), pump("stderr")]);
  const result = await completion;
  const outputs = await outputDone;
  const outputFailed = outputs.some((item) => item.status === "rejected");
  const exitCode = startFailed || outputFailed ? 1 : result.code ?? 1;
  const error = startFailed ? "TYPECHECK_START_FAILED" : outputFailed ? "TYPECHECK_OUTPUT_FAILED"
    : exitCode !== 0 ? "TypeScript typecheck failed" : null;
  return save(exitCode, result.signal ?? null, error, captured.stdout, captured.stderr);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const summary = await runTypecheck();
  process.exitCode = summary.exit_code;
}
