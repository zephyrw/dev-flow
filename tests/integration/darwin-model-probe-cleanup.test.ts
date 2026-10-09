import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLimitedCli } from "../../packages/core/src/model-catalog-service.js";

describe.skipIf(process.platform !== "darwin")(
  "macOS model probe cancellation",
  () => {
    it("kills an owned probe tree including a TERM-resistant child and leaves external processes alive", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "mac-probe-stop-"));
      const facts = join(root, "child.pid");
      const external = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      );
      const script = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});child.once('spawn',()=>writeFileSync(process.argv[1],String(child.pid)));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
      const handle = startLimitedCli({
        adapterId: "agy",
        executable: process.execPath,
        args: ["-e", script, facts],
        cwd: root,
        env: {},
        timeoutMs: 10000,
        outputLimit: 4096,
      });
      try {
        await vi.waitFor(() =>
          expect(Number(readFileSync(facts, "utf8"))).toBeGreaterThan(1),
        );
        const descendant = Number(readFileSync(facts, "utf8"));
        await handle.cancel();
        expect((await handle.result).cancelled).toBe(true);
        await vi.waitFor(() => {
          expect(() => process.kill(descendant, 0)).toThrow();
          expect(() => process.kill(handle.pid!, 0)).toThrow();
        });
        expect(() => process.kill(external.pid!, 0)).not.toThrow();
      } finally {
        await handle.cancel();
        external.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    }, 20000);
  },
);
