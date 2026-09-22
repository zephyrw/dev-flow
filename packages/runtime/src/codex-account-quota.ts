import { spawn } from "node:child_process";
import { JsonLines } from "../../adapters/agy/src/protocol.js";
import { quotaBuckets } from "./native-activity.js";
import type { QuotaBucket } from "../../contracts/src/run-observation.js";
import type { RunTelemetry } from "./run-telemetry.js";

type Source = {
  executable: string;
  prefixArgs?: string[];
  cwd: string;
  home: string;
};
type Snapshot = { buckets: QuotaBucket[]; observedAt: string };
const cache = new Map<
  string,
  { until: number; promise: Promise<Snapshot | undefined> }
>();

/** Only initialize and account/rateLimits/read; never opens a model turn or consumes reset credits. */
export function readCodexAccountQuota(
  source: Source,
): Promise<Snapshot | undefined> {
  const key = JSON.stringify([
    source.executable,
    source.prefixArgs,
    source.home,
  ]);
  const previous = cache.get(key);
  if (previous && previous.until > Date.now()) return previous.promise;
  const promise = new Promise<Snapshot | undefined>((resolve) => {
    const child = spawn(
      source.executable,
      [...(source.prefixArgs ?? []), "app-server", "--listen", "stdio://"],
      {
        cwd: source.cwd,
        env: { ...process.env, CODEX_HOME: source.home },
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let settled = false;
    const done = (value?: Snapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done(), 15000);
    const send = (message: unknown) =>
      child.stdin.write(JSON.stringify(message) + "\n");
    const lines = new JsonLines((message) => {
      if (message.id === 1) {
        if (message.error) return done();
        send({ method: "initialized" });
        send({
          id: 2,
          method: "account/rateLimits/read",
          params: { excludeResetCreditDetails: true },
        });
      } else if (message.id === 2) {
        const buckets = quotaBuckets(message.result);
        done(
          buckets.length
            ? { buckets, observedAt: new Date().toISOString() }
            : undefined,
        );
      }
    }, 1024 * 1024);
    child.on("error", () => done());
    child.on("close", () => done());
    child.stdin.on("error", () => done());
    child.stdout.on("data", (data) => {
      try {
        lines.push(data);
      } catch {
        done();
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "devflow_quota", version: "0.2.0" } },
    });
  });
  cache.set(key, { until: Date.now() + 60000, promise });
  // Bound distinct project/profile cache entries.
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return promise;
}

export function observeCodexAccountQuota(
  source: Source,
  telemetry: RunTelemetry,
) {
  let stopped = false;
  const poll = async () => {
    const value = await readCodexAccountQuota(source).catch(() => undefined);
    if (!stopped && value)
      telemetry.accountQuota(value.buckets, value.observedAt);
  };
  void poll();
  const timer = setInterval(() => void poll(), 60000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
