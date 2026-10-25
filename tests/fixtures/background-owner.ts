import { spawn } from "node:child_process";
import { spawnWindowsBackground } from "../../packages/service/src/windows-background.js";
process.once("message", async (message: { root: string }) => {
  try {
    const childCode = "setInterval(() => {}, 1000)";
    const regular = spawn(process.execPath, ["-e", childCode], { detached: true, windowsHide: true, stdio: "ignore" });
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const isolated = await spawnWindowsBackground(process.execPath, ["-e", "console.log('ready');" + childCode], process.cwd(), env,
      message.root + "/stdout.log", message.root + "/stderr.log");
    process.send?.({ regular: regular.pid, isolated });
    setInterval(() => {}, 1000);
  } catch (error) { process.send?.({ error: String(error) }); }
});
