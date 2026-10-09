import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, cpSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  darwinProcessInfo,
  darwinProcessPath,
  listDarwinProcesses,
} from "../../packages/process/src/native/darwin-processes.js";
import { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { Store } from "../../packages/store/src/store.js";

describe.skipIf(process.platform !== "darwin")(
  "macOS native process facts and AGY ownership",
  () => {
    it("reads executable, owner, group and microsecond creation identity from the kernel", () => {
      const info = darwinProcessInfo(process.pid)!;
      expect(info.pid).toBe(process.pid);
      expect(info.uid).toBe(process.getuid!());
      expect(info.creation_time).toMatch(/^\d+:\d+$/);
      expect(realpathSync(darwinProcessPath(process.pid))).toBe(
        realpathSync(process.execPath),
      );
      expect(listDarwinProcesses().some((row) => row.pid === process.pid)).toBe(
        true,
      );
    });
    it("distinguishes owned CLI descendants from external same-user AGY processes", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "darwin-agy-"));
      const executable = join(root, "agy");
      cpSync(process.execPath, executable);
      const records = new Map<string, Record<string, unknown>>();
      const manager = new ProcessManager((spec, event) =>
        records.set(spec.id, {
          id: spec.id,
          agy_account: spec.agy_account,
          ...event,
        }),
      );
      const host = new AgyAccountProcessHost({
        store: { list: () => [...records.values()] } as unknown as Store,
        agyExecutable: executable,
        processManager: manager,
      });
      const external = spawn(executable, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
      });
      try {
        await new Promise<void>((resolve, reject) => {
          external.once("spawn", resolve);
          external.once("error", reject);
        });
        const child = manager.start({
          id: "owned",
          executable,
          args: ["-e", "setInterval(()=>{},1000)"],
          cwd: root,
          env: {},
          timeout_ms: 0,
          agy_account: {
            realm_id: "realm",
            account_id: "a",
            auth_epoch: 1,
            permit_id: "permit",
          },
        });
        await child.ready;
        const rows = await host.findExternalAgyProcesses();
        expect(rows.some((row) => row.pid === external.pid)).toBe(true);
        expect(rows.some((row) => row.pid === child.pid)).toBe(false);
        const stopped = await manager.stop("owned", "account_switch");
        expect(stopped.status).toBe("confirmed_exited");
        expect(await host.confirmJobsStopped(["owned"])).toBe(true);
        expect(await host.stopProcess(external.pid!, "unowned")).toBe(false);
      } finally {
        external.kill("SIGKILL");
        await manager.close();
        rmSync(root, { recursive: true, force: true });
      }
    }, 20000);
  },
);
