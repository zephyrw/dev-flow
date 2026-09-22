/** Upgrade bridge: observes specified workflows until the old controller exits. No dispatch or task mutations. */
import {
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { Store } from "../packages/store/src/store.js";
import { loadConfig } from "../packages/contracts/src/config.js";
import type { Workflow, Run } from "../packages/contracts/src/index.js";
import { RunTelemetry } from "../packages/runtime/src/run-telemetry.js";
import { CodexSessionObserver } from "../packages/runtime/src/codex-session-observer.js";
import { observeCodexAccountQuota } from "../packages/runtime/src/codex-account-quota.js";
import { executablePath } from "../packages/process/src/executable.js";
import { storedNativeRecord } from "../packages/runtime/src/stored-native-record.js";

const config = loadConfig();
const workflows = process.argv.slice(2);
if (!workflows.length || workflows.some((id) => !/^wf-[a-z0-9-]+$/i.test(id)))
  throw Error("Specify workflow ids to observe");
const descriptor = join(config.storage_root, "controller-process.json");
const controller = readFileSync(descriptor, "utf8");
const lock = join(config.storage_root, "telemetry-observer.lock");
const lockFd = openSync(lock, "wx");
writeFileSync(lockFd, String(process.pid));
const store = new Store(join(config.storage_root, "devflow.sqlite"));
const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const executable = executablePath(config.models.codex_executable);
type Watching = {
  run: Run;
  telemetry: RunTelemetry;
  observer: CodexSessionObserver;
  stopQuota: () => void;
  file: string;
  offset: number;
  buffer: string;
  decoder: StringDecoder;
  reviewCursor: number;
  reviewBuffer: string;
};
const watching = new Map<string, Watching>();
let busy = false,
  closing = false;
async function stop(entry: Watching) {
  entry.stopQuota();
  await entry.observer.close();
  entry.telemetry.finish(
    store.get<Run>("run", entry.run.id)?.status === "failed",
  );
}
async function poll() {
  if (busy || closing) return;
  busy = true;
  try {
    if (readFileSync(descriptor, "utf8") !== controller) {
      await close();
      return;
    }
    try { process.kill(JSON.parse(controller).pid, 0); } catch { await close(); return; }
    for (const id of workflows) {
      const workflow = store.get<Workflow>("workflow", id);
      const run = workflow?.run_id && store.get<Run>("run", workflow.run_id);
      let entry = watching.get(id);
      if (
        entry &&
        (!run || run.id !== entry.run.id || run.status !== "running")
      ) {
        await stop(entry);
        watching.delete(id);
        entry = undefined;
      }
      if (
        !workflow ||
        !run ||
        run.status !== "running" ||
        run.adapter !== "codex"
      )
        continue;
      if (!entry) {
        // A newer controller already owns telemetry: never compete with it.
        if (
          store.get("run_observation", run.id) &&
          !store.get("telemetry_bridge", run.id)
        )
          continue;
        const record = store.get<any>("process_record", run.id);
        if (!record?.cwd) continue;
        store.put("telemetry_bridge", run.id, id, {
          controller,
          started_at: new Date().toISOString(),
        });
        const telemetry = new RunTelemetry(store, workflow, run);
        const observer = new CodexSessionObserver({
          home,
          cwd: record.cwd,
          startedAt: run.started_at,
          telemetry,
        });
        const file = join(
          config.storage_root,
          "native-runs",
          run.id,
          "stdout.jsonl",
        );
        const stopQuota = observeCodexAccountQuota(
          {
            executable,
            prefixArgs: config.models.codex_prefix_args,
            cwd: record.cwd,
            home,
          },
          telemetry,
        );
        entry = {
          run,
          telemetry,
          observer,
          stopQuota,
          file,
          offset: 0,
          reviewCursor: 0,
          reviewBuffer: "",
          buffer: "",
          decoder: new StringDecoder("utf8"),
        };
        watching.set(id, entry);
      }
      if (existsSync(entry.file)) {
        const length = Math.min(
          1024 * 1024,
          statSync(entry.file).size - entry.offset,
        );
        if (length > 0) {
          const fd = openSync(entry.file, "r");
          try {
            const buffer = Buffer.alloc(length);
            const count = readSync(fd, buffer, 0, length, entry.offset);
            entry.offset += count;
            entry.buffer += entry.decoder.write(buffer.subarray(0, count));
            const lines = entry.buffer.split("\n");
            entry.buffer = lines.pop() ?? "";
            if (entry.buffer.length > 4 * 1024 * 1024) entry.buffer = "";
            for (const line of lines) {
              const raw = storedNativeRecord(line);
              if (!raw) continue;
              entry.telemetry.accept(raw);
              if (typeof raw.thread_id === "string") entry.observer.bind(raw.thread_id);
            }
          } finally {
            closeSync(fd);
          }
        }
      } else {
        // Old ephemeral review sessions have no JSON file. Preserve their existing diagnostic events;
        // the presentation layer projects only allowlisted tool lifecycle lines from them.
        const rows = store.db
          .prepare(
            "SELECT seq,data FROM events WHERE workflow_id=? AND seq>? ORDER BY seq LIMIT 1000",
          )
          .all(id, entry.reviewCursor) as { seq: number; data: string }[];
        for (const row of rows) {
          entry.reviewCursor = row.seq;
          const event = JSON.parse(row.data);
          if (event.run_id !== run.id || event.type !== "ReviewDiagnostic")
            continue;
          entry.reviewBuffer += String(event.payload?.text ?? "");
          const lines = entry.reviewBuffer.split("\n");
          entry.reviewBuffer = lines.pop() ?? "";
          if (entry.reviewBuffer.length > 1024 * 1024) entry.reviewBuffer = "";
          for (const line of lines) {
            const model = line.match(/^model:\s*([\w.:-]+)\s*$/);
            if (model)
              entry.telemetry.metadata({
                actual_model: model[1],
                model_source: "native_event",
              });
          }
        }
      }
      await entry.observer.poll();
      entry.telemetry.flush();
    }
  } catch (error) {
    console.error(
      "Telemetry observer:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void poll(), 2000);
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  for (const entry of watching.values()) {
    entry.stopQuota();
    await entry.observer.close();
    entry.telemetry.flush();
  }
  store.close();
  closeSync(lockFd);
  unlinkSync(lock);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
await poll();
