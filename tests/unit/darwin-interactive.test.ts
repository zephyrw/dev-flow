import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, type Socket } from "node:net";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const relay = vi.hoisted(() => ({
  connect: undefined as undefined | ((command: string) => Promise<void>),
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (_file: string, args: string[]) => {
        const script = args.at(-1)!;
        const command = JSON.parse(
          script.slice(script.indexOf("do script ") + 10),
        );
        await relay.connect!(command);
        return { stdout: "", stderr: "" };
      },
    }),
  };
});
import { spawnDarwinInteractive } from "../../packages/process/src/native/darwin-interactive.js";
import { darwinProcessInfo } from "../../packages/process/src/native/darwin-processes.js";
let socket: Socket | undefined;
afterEach(() => {
  socket?.destroy();
  socket = undefined;
});
describe.skipIf(process.platform !== "darwin")(
  "macOS login PTY with a synthetic Terminal relay",
  () => {
    it("provides /dev/tty to a CLI under a detached session leader", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "pty-session-"));
      const source = new URL(
        "../../packages/process/src/native/darwin-interactive.ts",
        import.meta.url,
      ).href;
      const mock = join(root, "relay.mjs");
      writeFileSync(
        mock,
        `import {spawn} from 'node:child_process';import {promisify} from 'node:util';import {connect} from 'node:net';export {spawn};export const execFile=Object.assign(()=>{},{[promisify.custom]:async(_file,args)=>{const script=args.at(-1);const command=JSON.parse(script.slice(script.indexOf('do script ')+10));const socket=connect(command.match(/nc -U '([^']+)'/)[1]);socket.on('data',data=>{process.stdout.write(data);if(data.toString().includes('controlling-tty'))socket.write('complete\\n');});await new Promise((yes,no)=>{socket.once('connect',yes);socket.once('error',no);});return {stdout:'',stderr:''};}});`,
      );
      const driver = join(root, "driver.mjs");
      writeFileSync(
        driver,
        `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='node:child_process'&&context.parentURL===${JSON.stringify(source)})return {url:${JSON.stringify(pathToFileURL(mock).href)},shortCircuit:true};return next(specifier,context);}});process.on('SIGHUP',()=>{});const {spawnDarwinInteractive}=await import(${JSON.stringify(source)});const child=await spawnDarwinInteractive({executable:process.execPath,args:['-e',"const fs=require('node:fs');fs.closeSync(fs.openSync('/dev/tty','r'));console.log('controlling-tty');process.stdin.once('data',()=>process.exit(0));"],cwd:${JSON.stringify(root)},env:{},signal:new AbortController().signal,onDisconnect:()=>process.exit(2)});child.once('exit',code=>process.exit(code??1));`,
      );
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process",
        );
      const child = actual.spawn(
        process.execPath,
        ["--import", "tsx", driver],
        { detached: true, stdio: "pipe" },
      );
      let output = "",
        error = "";
      child.stdout!.on("data", (data) => (output += data));
      child.stderr!.on("data", (data) => (error += data));
      try {
        const code = await new Promise<number | null>((resolve) =>
          child.once("exit", resolve),
        );
        expect(error).toBe("");
        expect(code).toBe(0);
        expect(output).toContain("controlling-tty");
      } finally {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
        rmSync(root, { recursive: true, force: true });
      }
    }, 20000);
    it("provides interactive stdin/stdout while keeping the CLI in the owned runner group", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "pty-test-"));
      let output = "";
      relay.connect = async (command) => {
        const path = command.match(/nc -U '([^']+)'/)![1]!;
        socket = connect(path);
        socket.on("data", (data) => (output += data));
        await new Promise<void>((resolve, reject) => {
          socket!.once("connect", resolve);
          socket!.once("error", reject);
        });
      };
      try {
        const child = await spawnDarwinInteractive({
          executable: process.execPath,
          args: [
            "-e",
            "console.log(JSON.stringify({input:process.stdin.isTTY,output:process.stdout.isTTY}));process.stdin.once('data',()=>process.exit(0));",
          ],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
          onDisconnect: () => {},
        });
        const exit = new Promise((resolve) => child.once("exit", resolve));
        expect(darwinProcessInfo(child.pid!)!.pgid).toBe(
          darwinProcessInfo(process.pid)!.pgid,
        );
        await vi.waitFor(() =>
          expect(output).toContain('"input":true,"output":true'),
        );
        socket!.write("complete\n");
        expect(await exit).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it("cleans the relay and stops its owner when the login window is closed", async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "pty-close-"));
      relay.connect = async (command) => {
        socket = connect(command.match(/nc -U '([^']+)'/)![1]!);
        await new Promise<void>((resolve, reject) => {
          socket!.once("connect", resolve);
          socket!.once("error", reject);
        });
      };
      const disconnected = vi.fn();
      const child = await spawnDarwinInteractive({
        executable: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"],
        cwd: root,
        env: {},
        signal: new AbortController().signal,
        onDisconnect: disconnected,
      });
      try {
        socket!.destroy();
        await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce());
      } finally {
        child.kill("SIGKILL");
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
