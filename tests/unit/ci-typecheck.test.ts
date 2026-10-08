import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTypecheck } from "../../scripts/ci/typecheck.mjs";

class TypecheckChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill() { return true; }
}

async function fixture(stdout: string[], stderr: string[], code: number | null, signal: string | null = null) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "devflow-ci-typecheck-"));
  let consoleOut = "", consoleErr = "";
  try {
    const summary = await runTypecheck({
      cwd: root,
      stdout: new Writable({ write(chunk, _encoding, done) { consoleOut += chunk.toString(); done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { consoleErr += chunk.toString(); done(); } }),
      spawn: () => {
        const child = new TypecheckChild();
        queueMicrotask(() => {
          for (const text of stdout) child.stdout.write(text);
          for (const text of stderr) child.stderr.write(text);
          child.stdout.end();
          child.stderr.end();
          child.emit("close", code, signal);
        });
        return child;
      },
    });
    const artifact = readFileSync(join(root, ".cache/quality/typecheck-summary.json"), "utf8");
    return { summary, artifact, consoleOut, consoleErr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("CI typecheck diagnostic projection", () => {
  it("protects console and artifact across chunks while retaining compiler locations and exit codes", async () => {
    const result = await fixture([
      "tests/example.ts(4,2): error TS2322: ordinary type mismatch\nAuthorization: Bea",
      "rer bearer-fixture-value\n",
      '{"token":"json-fixture-', 'value"}\n',
      "Cookie: cookie-fixture-value\n",
      "ghp_abcdefghijklmnopqrstuvwxyz123456\n",
    ], ["password=\"password-fixture-", "value\"\n"], 2);
    for (const text of [result.artifact, result.consoleOut + result.consoleErr]) {
      for (const secret of ["bearer-fixture-value", "json-fixture-value", "cookie-fixture-value", "password-fixture-value", "ghp_abcdefghijklmnopqrstuvwxyz123456"]) {
        expect(text).not.toContain(secret);
      }
      expect(text).toContain("tests/example.ts(4,2)");
      expect(text).toContain("[REDACTED]");
    }
    expect(result.summary.exit_code).toBe(2);
    expect(result.summary.status).toBe("failed");
    expect(JSON.parse(result.artifact)).toEqual(result.summary);
  });

  it("redacts a long value before retaining the bounded summary tail", async () => {
    const result = await fixture(["token=\"" + "sensitive-value".repeat(800) + "\"\nnormal diagnostic\n"], [], 0);
    expect(result.summary.stdout_summary.length).toBeLessThanOrEqual(8000);
    expect(result.consoleOut).not.toContain("sensitive-value");
    expect(result.artifact).not.toContain("sensitive-value");
    expect(result.summary.stdout_summary).toContain("normal diagnostic");
    expect(result.summary.status).toBe("passed");
  });

  it("masks multiline private keys and keeps signal termination unsuccessful", async () => {
    const result = await fixture([
      "-----BEGIN PRIVATE KEY-----\nprivate-key-",
      "fixture-data\n-----END PRIVATE KEY-----\n",
    ], [], null, "SIGTERM");
    expect(result.consoleOut + result.artifact).not.toContain("private-key-fixture-data");
    expect(result.summary.exit_code).not.toBe(0);
    expect(result.summary.signal).toBe("SIGTERM");
  });

  it("records a launch failure without exposing the raw error", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "devflow-ci-typecheck-"));
    try {
      const summary = await runTypecheck({
        cwd: root,
        spawn: () => {
          const child = new TypecheckChild();
          queueMicrotask(() => {
            child.emit("error", new Error("token=launch-fixture-secret"));
            child.stdout.end();
            child.stderr.end();
            child.emit("close", null, null);
          });
          return child;
        },
      });
      expect(summary.error).toBe("TYPECHECK_START_FAILED");
      expect(summary.exit_code).toBe(1);
      expect(readFileSync(join(root, ".cache/quality/typecheck-summary.json"), "utf8")).not.toContain("launch-fixture-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("waits for a slow output destination without ending the parent's stream", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "devflow-ci-typecheck-"));
    let logged = "", ended = false;
    const stdout = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, done) {
        setTimeout(() => { logged += chunk.toString(); done(); }, 5);
      },
      final(done) { ended = true; done(); },
    });
    try {
      const summary = await runTypecheck({
        cwd: root, stdout,
        stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
        spawn: () => {
          const child = new TypecheckChild();
          queueMicrotask(() => {
            child.stdout.end("normal compiler diagnostic\npassword=backpressure-fixture-secret\n");
            child.stderr.end();
            child.emit("close", 0, null);
          });
          return child;
        },
      });
      expect(summary.exit_code).toBe(0);
      expect(logged).toBe(summary.stdout_summary);
      expect(logged).toContain("normal compiler diagnostic");
      expect(logged).not.toContain("backpressure-fixture-secret");
      expect(ended).toBe(false);
    } finally {
      stdout.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
