import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getNativeAsync } from "../../packages/process/src/native/index.js";
import { readPosixProcesses } from "../../scripts/ci/owned-processes.mjs";
import {
  RepeatedStatusFilter,
  pipeStreamWithRedaction,
  spawnTarget,
  discoverTargets,
  readBrowserDiagnostics,
} from "../../scripts/ci/run-targets.mjs";
import {
  DiagnosticRedactionContext,
  DiagnosticStreamRedactor,
  publicDiagnostic,
} from "../../packages/presentation/src/secret-redactor.js";

describe("CI browser failure diagnostics", () => {
  const withReport = (content: unknown, check: (file: string) => void) => {
    const directory = mkdtempSync(join(tmpdir(), "devflow-ci-browser-"));
    const file = join(directory, "report.json");
    try {
      writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
      check(file);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };

  it("retains nested failed specs, file positions and collection errors without copying raw attachments", () => {
    withReport({
      suites: [{ title: "workflow.spec.ts", file: "tests/e2e/workflow.spec.ts", specs: [], suites: [{
        title: "nested describe", specs: [
          { title: "successful operation", ok: true, tests: [] },
          { title: "failed operation", ok: false, file: "tests/e2e/workflow.spec.ts", line: 42, column: 7,
            tests: [{ status: "unexpected", results: [{ status: "failed", errors: [{ message: "button did not appear" }],
              stdout: ["raw console"], attachments: [{ path: "private/trace.zip" }] }] }] },
        ],
      }] }],
      errors: [{ message: "fixture setup failed" }, { value: "non-Error setup failure" }],
    }, file => {
      const result = readBrowserDiagnostics(file, publicDiagnostic);
      expect(result.status).toBe("available");
      expect(result.failures).toEqual([{
        file: "tests/e2e/workflow.spec.ts", line: 42, column: 7,
        titles: ["workflow.spec.ts", "nested describe", "failed operation"],
        tests: [{ status: "unexpected", errors: ["button did not appear"] }],
      }]);
      expect(result.errors).toEqual(["fixture setup failed", "non-Error setup failure"]);
      expect(JSON.stringify(result)).not.toMatch(/raw console|trace\.zip|successful operation/);
    });
  });

  it("redacts titles and error messages before truncating while retaining ordinary locations", () => {
    const longSecret = "private-value-" + "x".repeat(600);
    withReport({ suites: [{ title: 'token="suite-secret"', specs: [{
      title: 'password="title-secret"', ok: false, file: "tests/e2e/model-settings.spec.ts", line: 12,
      tests: [{ status: "unexpected", results: [{ errors: [
        { message: `password="${longSecret}" ordinary failure` },
        { message: "Bearer bearer-secret" },
        { message: '{"cookie":"cookie-secret","message":"safe message"}' },
      ] }] }],
    }] }], errors: [{ message: "oauth token=collection-secret" }] }, file => {
      const result = readBrowserDiagnostics(file, publicDiagnostic);
      const output = JSON.stringify(result);
      expect(result.status).toBe("available");
      expect(result.failures[0]?.file).toBe("tests/e2e/model-settings.spec.ts");
      expect(result.failures[0]?.line).toBe(12);
      expect(output).not.toMatch(/suite-secret|title-secret|private-value|bearer-secret|cookie-secret|collection-secret/);
      expect(output).toContain("ordinary failure");
      expect(output).toContain("[REDACTED]");
      expect(result.failures[0]?.tests[0]?.errors.every(error => error.length <= 500)).toBe(true);
    });
  });

  it("distinguishes missing, malformed and unreadable reports and fails closed without a projector", () => {
    const directory = mkdtempSync(join(tmpdir(), "devflow-ci-browser-"));
    try {
      expect(readBrowserDiagnostics(join(directory, "missing.json"), publicDiagnostic).status).toBe("missing");
      expect(readBrowserDiagnostics(directory, publicDiagnostic).status).toBe("read_failed");
      expect(readBrowserDiagnostics(join(directory, "missing.json")).status).toBe("redaction_unavailable");
    } finally { rmSync(directory, { recursive: true, force: true }); }
    for (const report of ["{broken", { suites: "invalid" }, { suites: [{ specs: {}, suites: [] }] }]) {
      withReport(report, file => expect(readBrowserDiagnostics(file, publicDiagnostic)).toEqual({
        status: "invalid", failures: [], errors: [],
      }));
    }
    withReport({ suites: [], errors: [{ message: "raw secret" }] }, file => {
      expect(readBrowserDiagnostics(file, () => { throw new Error("projector failed"); })).toEqual({
        status: "redaction_unavailable", failures: [], errors: [],
      });
    });
  });
});

describe("CI run targets pipeline & redaction (A10, A11)", () => {
  it("A10-1: merges repeated sensitive authentication status lines without unbounded output", () => {
    let output = "";
    const filter = new RepeatedStatusFilter((text) => {
      output += text;
      return true;
    });

    for (let i = 0; i < 50; i++) {
      filter.push("[敏感认证操作：仅保留状态]\n");
    }
    filter.push("Normal line 1\n");
    filter.push("[敏感认证操作：仅保留状态]\n");
    filter.push("[敏感认证操作：仅保留状态]\n");
    filter.flush();

    expect(output).toContain("[敏感认证操作：仅保留状态]\n");
    expect(output).toContain("重复 49 次已折叠");
    expect(output).toContain("Normal line 1\n");
    expect(output).toContain("重复 1 次已折叠");
  });

  it("A10-2: stream pipeline redacts secrets across chunks and handles backpressure", async () => {
    const readable = new PassThrough();
    const writeChunks: string[] = [];
    let drainListener: (() => void) | null = null;
    const writeDest = {
      write(chunk: string) {
        writeChunks.push(chunk);
        // Simulate backpressure on second write
        if (writeChunks.length === 2) return false;
        return true;
      },
      once(event: string, callback: () => void) {
        if (event === "drain") drainListener = callback;
      },
    };

    const context = new DiagnosticRedactionContext();
    const redactor = new DiagnosticStreamRedactor(64 * 1024, context);
    const filter = new RepeatedStatusFilter((s) => writeDest.write(s));

    const pipePromise = pipeStreamWithRedaction(readable, writeDest, redactor, filter);

    readable.write('password="secret');
    readable.write('-part-2" normal-log\n');

    if (drainListener) {
      (drainListener as () => void)();
    }

    readable.end();
    await pipePromise;

    const fullOutput = writeChunks.join("");
    expect(fullOutput).not.toContain("secret-part-2");
    expect(fullOutput).toContain("[REDACTED]");
    expect(fullOutput).toContain("normal-log");
  });

  it("A10-3: handles oversize incomplete records by safely suppressing and truncating", async () => {
    const readable = new PassThrough();
    const writeChunks: string[] = [];
    const writeDest = {
      write(chunk: string) {
        writeChunks.push(chunk);
        return true;
      },
      once() {},
    };

    const context = new DiagnosticRedactionContext();
    const redactor = new DiagnosticStreamRedactor(128, context);
    const filter = new RepeatedStatusFilter((s) => writeDest.write(s));

    const pipePromise = pipeStreamWithRedaction(readable, writeDest, redactor, filter);

    readable.write("x".repeat(200));
    readable.end();
    await pipePromise;

    const fullOutput = writeChunks.join("");
    expect(fullOutput).toContain("超过安全缓冲上限");
  });

  it("A11-1: discoverTargets finds and sorts valid test files", () => {
    const targets = discoverTargets();
    expect(Array.isArray(targets)).toBe(true);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(["vitest", "node", "playwright"]).toContain(target.kind);
      expect(typeof target.file).toBe("string");
    }
  });

  it("A11-2: spawnTarget handles normal exit and non-zero exit cleanly", async () => {
    const ok = await spawnTarget(["-e", "process.exit(0)"], {});
    expect(ok.exit_code).toBe(0);
    expect(ok.timed_out).toBe(false);

    const fail = await spawnTarget(["-e", "process.exit(42)"], {});
    expect(fail.exit_code).toBe(42);
    expect(fail.timed_out).toBe(false);
  });

  it("A11-3: spawnTarget enforces timeout and terminates child process", async () => {
    const timeoutResult = await spawnTarget(["-e", "setTimeout(() => {}, 60000)"], {}, {
      timeoutMs: 500,
    });
    expect(timeoutResult.timed_out).toBe(true);
    expect([124, 1]).toContain(timeoutResult.exit_code);
  }, 30000);

  for (const { exitCode, inheritedOutput } of [
    { exitCode: 0, inheritedOutput: false },
    { exitCode: null, inheritedOutput: false },
    { exitCode: 0, inheritedOutput: true },
    { exitCode: 42, inheritedOutput: true },
    { exitCode: null, inheritedOutput: true },
  ]) {
    const exitEarly = exitCode !== null;
    it(`A11: cleans a detached descendant with ${inheritedOutput ? "inherited output" : "ignored output"} when target ${exitEarly ? `exits ${exitCode}` : "times out"}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "devflow-ci-owned-"));
      const marker = join(directory, "descendant.json");
      const native = await getNativeAsync();
      const target = `
        (async () => {
          const { spawn } = require('node:child_process');
          const fs = require('node:fs');
          const native = await (await import(process.env.CI_NATIVE_URL)).getNativeAsync();
          const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 20000)'], {
            detached: true,
            stdio: process.env.CI_INHERIT_OUTPUT === '1' ? ['ignore', 'inherit', 'inherit'] : 'ignore',
            env: process.env, windowsHide: true,
          });
          child.once('spawn', () => {
            fs.writeFileSync(process.env.CI_DESCENDANT_MARKER, JSON.stringify({
              pid: child.pid, creation: native.getProcessCreationTime(child.pid)?.toString(),
            }));
            // Leave the ancestry visible for the running tracker; after this the
            // descendant must be reclaimed even though it belongs to another group.
            if (process.env.CI_EXIT_EARLY === '1')
              setTimeout(() => process.exit(Number(process.env.CI_TARGET_EXIT_CODE)), 750);
            else setInterval(() => {}, 1000);
          });
        })().catch(() => process.exit(1));
      `;
      const alive = async (pid: number) => {
        if (process.platform !== "win32") {
          const record = (await readPosixProcesses()).find((item: { pid: number }) => item.pid === pid);
          return !!record && !record.zombie;
        }
        try { process.kill(pid, 0); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
      };
      try {
        const result = await spawnTarget(["-e", target], {
          CI_NATIVE_URL: pathToFileURL(resolve("dist/packages/process/src/native/index.js")).href,
          CI_DESCENDANT_MARKER: marker, CI_EXIT_EARLY: exitEarly ? "1" : "0",
          CI_TARGET_EXIT_CODE: String(exitCode ?? 0), CI_INHERIT_OUTPUT: inheritedOutput ? "1" : "0",
        }, { timeoutMs: exitEarly ? 15000 : 2500, cleanupTimeoutMs: 25000 });
        expect(result.exit_code).toBe(exitEarly ? exitCode : 124);
        expect(result.timed_out).toBe(!exitEarly);
        expect(result.error).toBe(exitEarly ? null : "Process timed out");
        const descendant = JSON.parse(readFileSync(marker, "utf8"));
        expect(descendant.creation).toBeTruthy();
        expect(await alive(descendant.pid)).toBe(false);
      } finally {
        // A failed regression must not leave its own fixture alive. Never signal
        // a reused PID: compare the creation identity recorded by its actual parent.
        if (existsSync(marker)) {
          const descendant = JSON.parse(readFileSync(marker, "utf8"));
          if (descendant.creation && await alive(descendant.pid) &&
              native.getProcessCreationTime(descendant.pid)?.toString() === descendant.creation) {
            try { process.kill(descendant.pid, "SIGKILL"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    }, 45000);
  }

  it("A11-4: spawnTarget accepts custom stdout/stderr streams via options.stdout/options.stderr", async () => {
    let captured = "";
    const customStdout = {
      write(chunk: string) {
        captured += chunk;
        return true;
      },
    };
    const result = await spawnTarget(["-e", "console.log('custom-stream-test-output')"], {}, {
      stdout: customStdout as any,
    });
    expect(result.exit_code).toBe(0);
    expect(captured).toContain("custom-stream-test-output");
  });
});
