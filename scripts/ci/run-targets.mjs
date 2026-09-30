import { readdirSync, mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { OwnedProcessTracker } from "./owned-processes.mjs";

const require = createRequire(import.meta.url);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name).replaceAll("\\", "/")]);
}

export function discoverTargets() {
  return [
    ...["tests/unit", "tests/integration"].flatMap((directory) => files(directory)
      .filter((file) => /\.test\.tsx?$/.test(file)).map((file) => ({ kind: "vitest", file }))),
    { kind: "node", file: "scripts/install-skills.test.mjs" },
    ...files("tests/e2e").filter((file) => /\.spec\.ts$/.test(file)).map((file) => ({ kind: "playwright", file })),
  ].sort((a, b) => a.file.localeCompare(b.file));
}

export class RepeatedStatusFilter {
  constructor(writeFn) {
    this.writeFn = writeFn;
    this.lastLine = "";
    this.repeatCount = 0;
  }

  push(text) {
    if (!text) return true;
    const lines = text.split("\n");
    let ok = true;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (line === "[敏感认证操作：仅保留状态]") {
        if (this.lastLine === line) {
          this.repeatCount++;
        } else {
          if (this.repeatCount > 1) {
            ok = this.writeFn(`[上述敏感认证状态重复 ${this.repeatCount - 1} 次已折叠]\n`) && ok;
          }
          this.lastLine = line;
          this.repeatCount = 1;
          ok = this.writeFn(line + "\n") && ok;
        }
      } else {
        if (this.repeatCount > 1) {
          ok = this.writeFn(`[上述敏感认证状态重复 ${this.repeatCount - 1} 次已折叠]\n`) && ok;
          this.repeatCount = 0;
        }
        this.lastLine = "";
        ok = this.writeFn(line + "\n") && ok;
      }
    }
    const tail = lines[lines.length - 1];
    if (tail) {
      if (tail === "[敏感认证操作：仅保留状态]") {
        if (this.lastLine === tail) {
          this.repeatCount++;
        } else {
          if (this.repeatCount > 1) {
            ok = this.writeFn(`[上述敏感认证状态重复 ${this.repeatCount - 1} 次已折叠]\n`) && ok;
          }
          this.lastLine = tail;
          this.repeatCount = 1;
          ok = this.writeFn(tail) && ok;
        }
      } else {
        if (this.repeatCount > 1) {
          ok = this.writeFn(`[上述敏感认证状态重复 ${this.repeatCount - 1} 次已折叠]\n`) && ok;
          this.repeatCount = 0;
        }
        this.lastLine = "";
        ok = this.writeFn(tail) && ok;
      }
    }
    return ok;
  }

  flush() {
    if (this.repeatCount > 1) {
      this.writeFn(`[上述敏感认证状态重复 ${this.repeatCount - 1} 次已折叠]\n`);
      this.repeatCount = 0;
    }
  }
}

export function pipeStreamWithRedaction(readable, writeDest, redactor, statusFilter) {
  if (!readable) return Promise.resolve();
  readable.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let finished = false;
    let resumeOnDrain;
    const detach = () => {
      readable.off("data", data);
      readable.off("error", fail);
      writeDest.off?.("error", fail);
      if (resumeOnDrain) writeDest.off?.("drain", resumeOnDrain);
    };
    const fail = error => {
      if (finished) return;
      finished = true;
      readable.pause();
      detach();
      reject(error);
    };
    const data = chunk => {
      try {
        if (!statusFilter.push(redactor.push(chunk))) {
          readable.pause();
          resumeOnDrain = () => { resumeOnDrain = null; readable.resume(); };
          writeDest.once("drain", resumeOnDrain);
        }
      } catch (error) { fail(error); }
    };
    const finish = () => {
      if (finished) return;
      try {
        statusFilter.push(redactor.push("", true));
        statusFilter.flush();
        finished = true;
        detach();
        resolve();
      } catch (error) { fail(error); }
    };
    readable.on("data", data);
    readable.once("error", fail);
    writeDest.on?.("error", fail);
    readable.once("end", finish);
    readable.once("close", finish);
  });
}

export async function spawnTarget(args, env, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 25000;
  const stdoutDest = options.stdout ?? process.stdout;
  const stderrDest = options.stderr ?? process.stderr;

  let redaction;
  try { redaction = await import("../../dist/packages/presentation/src/secret-redactor.js"); }
  catch { return { exit_code: 1, signal: null, error: "PROCESS_REDACTOR_LOAD_FAILED", timed_out: false }; }
  const { DiagnosticRedactionContext, DiagnosticStreamRedactor } = redaction;
  const context = new DiagnosticRedactionContext();
  const projectError = error => String(context.project(error instanceof Error ? error.message : String(error)));
  const stdoutRedactor = new DiagnosticStreamRedactor(64 * 1024, context);
  const stderrRedactor = new DiagnosticStreamRedactor(64 * 1024, context);

  const stdoutFilter = new RepeatedStatusFilter((str) => stdoutDest.write(str));
  const stderrFilter = new RepeatedStatusFilter((str) => stderrDest.write(str));
  let ProcessManager;
  try { ({ ProcessManager } = await import("../../dist/packages/process/src/manager.js")); }
  catch (error) { return { exit_code: 1, signal: null, error: projectError(error), timed_out: false }; }
  // Configure tracking before start(): its lifecycle callback binds the root before
  // the SDK sends the tool's start message. Windows uses the SDK's persistent Job.
  const tracker = process.platform === "win32" ? null : new OwnedProcessTracker();
  let managed;
  let cleanupHooks;
  try {
    const manager = new ProcessManager((_spec, event) => {
      const identity = event.identity;
      if (identity?.pgid && identity.launcher_creation_time) {
        tracker?.setRoot(identity.pgid, identity.launcher_creation_time);
        void tracker?.capture();
      }
    });
    managed = manager.start({
      id: `ci-${randomUUID()}`, executable: process.execPath, args, cwd: process.cwd(),
      env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, value]) => typeof value === "string")),
      timeout_ms: 0,
    }, {
      // start() initializes asynchronously; these handlers are installed below
      // before native initialization can begin finishing the process.
      onCleanupStart: () => cleanupHooks.begin(),
      beforePipesClose: () => cleanupHooks.clean(),
    });
  } catch (error) { return { exit_code: 1, signal: null, error: projectError(error), timed_out: false }; }
  const outputs = { stdout: new PassThrough(), stderr: new PassThrough() };
  for (const stream of ["stdout", "stderr"]) {
    managed.on(stream, chunk => {
      if (outputs[stream].destroyed) return;
      if (!outputs[stream].write(chunk)) managed.pauseOutput?.(stream);
    });
    outputs[stream].on("drain", () => managed.resumeOutput?.(stream));
  }
  const outputDone = Promise.all([
    pipeStreamWithRedaction(outputs.stdout, stdoutDest, stdoutRedactor, stdoutFilter),
    pipeStreamWithRedaction(outputs.stderr, stderrDest, stderrRedactor, stderrFilter),
  ]);
  let timedOut = false, timer, cleanupTimer, cleanupDeadline, settling = false, resolved = false;
  let stopTask = null;
  let cleanupError = null;
  let outputError = null;
  let detachedCleanupConfirmed = false;
  const poll = tracker ? setInterval(() => { void tracker.capture(); }, 100) : null;
  return await new Promise(resolve => {
    const complete = (code, signal, error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      if (poll) clearInterval(poll);
      outputs.stdout.destroy();
      outputs.stderr.destroy();
      resolve({
        exit_code: timedOut ? 124 : (error ? 1 : code ?? (signal ? 1 : 0)),
        signal: signal ?? null,
        error: error ?? (timedOut ? "Process timed out" : null),
        timed_out: timedOut,
      });
    };
    const armCleanupDeadline = () => {
      cleanupDeadline ??= Date.now() + cleanupTimeoutMs;
      cleanupTimer ??= setTimeout(() => {
        // Do not cancel an in-flight owned cleanup, but never claim it succeeded.
        complete(1, null, "PROCESS_CLEANUP_UNCONFIRMED");
      }, cleanupTimeoutMs);
    };
    cleanupHooks = {
      begin: () => {
        clearTimeout(timer);
        armCleanupDeadline();
      },
      clean: async () => {
        // The SDK has stopped its Job/group. Reclaim tracked detached owners
        // before it waits for pipes they may still be holding open.
        try {
          const detached = await tracker?.cleanup(cleanupDeadline);
          if (detached && !detached.confirmed) {
            cleanupError = detached.error ?? "PROCESS_CLEANUP_UNCONFIRMED";
            throw new Error(cleanupError);
          }
          detachedCleanupConfirmed = true;
        } catch (error) {
          cleanupError ??= projectError(error);
          throw error;
        }
      },
    };
    const stop = (reason = "timeout") => {
      if (!stopTask) {
        armCleanupDeadline();
        stopTask = (async () => {
          // Capture detached descendants while the persistent launcher is still alive.
          await tracker?.capture();
          try { await managed.stop(reason); }
          catch (error) {
            cleanupError = [cleanupError, `PROCESS_CLEANUP_UNCONFIRMED: ${projectError(error)}`]
              .filter(Boolean).join("; ");
          }
        })();
      }
      return stopTask;
    };
    const finish = async (result, error) => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      armCleanupDeadline();
      if (stopTask) await stopTask;
      if (poll) clearInterval(poll);
      if (!detachedCleanupConfirmed) {
        const detached = await tracker?.cleanup(cleanupDeadline);
        if (detached && !detached.confirmed) cleanupError = detached.error;
      }
      outputs.stdout.end();
      outputs.stderr.end();
      await outputDone;
      complete(result?.code, result?.signal, [cleanupError, outputError, error].filter(Boolean).join("; ") || null);
    };
    const settle = (result, error) => {
      void finish(result, error).catch(async failure => {
        // An output/cleanup exception must still produce a target result.
        const diagnostic = projectError(failure);
        try {
          await stop("manual");
          if (!detachedCleanupConfirmed) {
            const detached = await tracker?.cleanup(cleanupDeadline);
            if (detached && !detached.confirmed) cleanupError = detached.error;
          }
        } catch (cleanupFailure) {
          cleanupError = `PROCESS_CLEANUP_UNCONFIRMED: ${projectError(cleanupFailure)}`;
        }
        complete(1, result?.signal, [cleanupError, outputError, error, diagnostic].filter(Boolean).join("; "));
      });
    };
    void outputDone.catch(error => {
      outputError = projectError(error);
      void stop("manual").catch(failure => settle(null, projectError(failure)));
    });
    managed.completion.then(result => settle(result, null), error => {
      // The SDK refuses successful completion when Job/group exit is unconfirmed.
      settle(null, projectError(error));
    });
    if (timeoutMs > 0) timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, timeoutMs);
  });
}

export async function runTargets(options = {}) {
  const reportRoot = resolve(".cache/quality");
  mkdirSync(reportRoot, { recursive: true });
  const root = mkdtempSync(join(reportRoot, "run-"));
  const blobs = join(root, "blobs");
  mkdirSync(blobs, { recursive: true });
  const targets = options.targets ?? discoverTargets();
  const results = [];
  const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const playwright = require.resolve("@playwright/test/cli");
  const expectedBlobs = [];

  for (const [index, target] of targets.entries()) {
    const directory = join(root, `target-${index}`);
    mkdirSync(directory, { recursive: true });
    let args;
    if (target.kind === "vitest") {
      const blobPath = join(blobs, `${index}.json`);
      expectedBlobs.push({ index, target, blobPath });
      args = [
        vitest, "run", target.file, "--coverage", "--coverage.reporter=json",
        "--maxWorkers=1", "--reporter=default", "--reporter=blob",
        `--outputFile.blob=${blobPath}`,
        `--coverage.reportsDirectory=${join(directory, "coverage")}`
      ];
    } else if (target.kind === "node") {
      args = ["--test", target.file];
    } else {
      args = [playwright, "test", target.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"];
    }

    const runResult = await spawnTarget(args, { DEVFLOW_TEST_RUN_DIR: join(directory, "instance") }, options);
    results.push({
      ...target,
      ...runResult,
      sha: process.env.QUALITY_SHA ?? null,
      platform: `${process.platform}-${process.arch}`,
    });
  }

  let missingBlobs = false;
  for (const item of expectedBlobs) {
    if (!existsSync(item.blobPath)) {
      missingBlobs = true;
      const targetResult = results[item.index];
      if (targetResult && targetResult.exit_code === 0) {
        targetResult.exit_code = 1;
        targetResult.error = targetResult.error ? `${targetResult.error}; Missing coverage blob` : "Missing coverage blob";
      }
    }
  }

  let mergeResult = { exit_code: 0 };
  if (targets.some((t) => t.kind === "vitest")) {
    mergeResult = await spawnTarget([
      vitest, "--merge-reports", blobs, "--coverage",
      "--coverage.reporter=text", "--coverage.reporter=json", "--coverage.reporter=html",
      "--reporter=default", `--coverage.reportsDirectory=${join(root, "coverage")}`
    ], {}, options);
  }

  const summary = {
    targets: results,
    coverage_merge_exit_code: mergeResult.exit_code,
  };
  writeFileSync(join(root, "results.json"), JSON.stringify(summary, null, 2));
  const failed = missingBlobs || mergeResult.exit_code !== 0 || results.some((item) => item.exit_code !== 0);
  process.exitCode = failed ? 1 : 0;
  return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await runTargets();
