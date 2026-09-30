import { join } from "node:path";
import { atomicWrite } from "../../core/src/util.js";
import { getNativeAsync } from "../../process/src/native/index.js";

export async function recordController(
  storage: string,
  entry: string,
  mode: "full" | "accounts" = "full",
) {
  const native = await getNativeAsync();
  const creation = native.getProcessCreationTime(process.pid);
  if (creation == null) throw new Error("CONTROLLER_IDENTITY_UNAVAILABLE");
  atomicWrite(
    join(storage, "controller-process.json"),
    JSON.stringify(
      {
        pid: process.pid,
        started: String(creation),
        executable: process.execPath,
        entry,
        mode,
        protocol: "node-v1",
      },
      null,
      2,
    ),
  );
}
