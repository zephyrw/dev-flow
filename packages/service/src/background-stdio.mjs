import { openSync, writeSync } from "node:fs";

// WMI has no inherited console handles. Keep controller diagnostics in the same
// per-instance logs as other platforms, before the controller module is loaded.
for (const [stream, key] of [[process.stdout, "DEVFLOW_CONTROLLER_STDOUT"], [process.stderr, "DEVFLOW_CONTROLLER_STDERR"]]) {
  const path = process.env[key];
  if (!path) throw new Error("Controller log path missing");
  delete process.env[key];
  const fd = openSync(path, "a");
  stream.write = (chunk, encoding, callback) => {
    if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
    try {
      writeSync(fd, typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk);
      if (callback) process.nextTick(callback);
    } catch (error) {
      if (callback) process.nextTick(callback, error); else throw error;
    }
    return true;
  };
  // The OS closes the descriptor after every exit listener has logged.
}
