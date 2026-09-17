import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { hash } from "../../core/src/util.js";
import { requireCondition } from "../../contracts/src/index.js";
export async function acquireControllerLock(host: string, root: string) {
  requireCondition(
    !!host,
    "HOST_REQUIRED",
    "控制器需要 Process Host 以独占状态目录",
  );
  const child = spawn(
    host,
    ["controller-lock", hash(resolve(root).toLowerCase())],
    {
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        DOTNET_ROOT: process.env.DOTNET_ROOT ?? resolve(".cache/dotnet"),
      },
    },
  );
  child.stderr.resume();
  let acquired = false;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => {
      child.stdin.end();
      fail(Error("Controller lock timeout"));
    }, 10000);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
      const line = output.split("\n")[0];
      if (!output.includes("\n")) return;
      try {
        const value = JSON.parse(line!);
        clearTimeout(timer);
        if (value.locked) {
          acquired = true;
          done();
        } else fail(Error(value.message ?? "Controller lock failed"));
      } catch (e) {
        clearTimeout(timer);
        fail(e);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!acquired) fail(Error("Controller lock rejected: " + code));
    });
  });
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.stdin.end("\n");
    });
  };
}
