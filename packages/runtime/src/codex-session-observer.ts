import { readdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RunTelemetry } from "./run-telemetry.js";

/** Read only the exact CLI session. No account files, directory-wide log scans or model calls. */
export class CodexSessionObserver {
  private conversation?: string;
  private file?: string;
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private trusted = false;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;
  constructor(
    private input: {
      home: string;
      cwd: string;
      startedAt: string;
      telemetry: RunTelemetry;
    },
  ) {}
  bind(conversation: string) {
    if (this.stopped || this.conversation === conversation) return;
    if (this.conversation || !/^[0-9a-f-]{36}$/i.test(conversation)) return;
    this.conversation = conversation;
    this.timer = setInterval(() => void this.poll(), 2000);
    this.timer.unref();
    void this.poll();
  }
  private async locate() {
    if (!this.conversation) return;
    const dates = [new Date(this.input.startedAt)];
    // Codex uses UUIDv7 session ids, including when resuming an older session.
    if (this.conversation[14] === "7")
      dates.push(
        new Date(
          parseInt(this.conversation.replace(/-/g, "").slice(0, 12), 16),
        ),
      );
    const dirs = new Set<string>();
    for (const date of dates)
      for (const offset of [-86400000, 0, 86400000]) {
        const d = new Date(date.getTime() + offset);
        if (Number.isFinite(d.getTime()))
          dirs.add(
            join(
              this.input.home,
              "sessions",
              ...d.toISOString().slice(0, 10).split("-"),
            ),
          );
      }
    const matches: string[] = [];
    for (const dir of dirs) {
      const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const file of files)
        if (
          file.isFile() &&
          file.name.endsWith("-" + this.conversation + ".jsonl")
        )
          matches.push(join(dir, file.name));
    }
    if (matches.length === 1) this.file = matches[0];
  }
  async poll() {
    if (this.stopped) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.read().catch(() => {
      /* Optional telemetry must not interrupt execution. Old data is marked stale by the UI. */
    });
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }
  private async read() {
    if (!this.file) await this.locate();
    if (!this.file) return;
    const file = await open(this.file, "r");
    try {
      const stat = await file.stat();
      if (stat.size < this.offset) return; // Replaced/truncated session is not a new trusted source.
      const size = Math.min(1024 * 1024, stat.size - this.offset);
      if (!size) return;
      const bytes = Buffer.allocUnsafe(size);
      const { bytesRead } = await file.read(bytes, 0, size, this.offset);
      this.offset += bytesRead;
      this.buffer += this.decoder.write(bytes.subarray(0, bytesRead));
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      if (this.buffer.length > 4 * 1024 * 1024) this.buffer = "";
      for (const line of lines) {
        let row: any;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const p = row.payload;
        if (row.type === "session_meta") {
          const samePath = (a: string, b: string) =>
            process.platform === "win32"
              ? a.toLowerCase() === b.toLowerCase()
              : a === b;
          const cwd =
            typeof p?.cwd === "string"
              ? await realpath(resolve(p.cwd)).catch(() => "")
              : "";
          const expected = await realpath(this.input.cwd).catch(() => "");
          this.trusted =
            p?.id === this.conversation &&
            !!cwd &&
            !!expected &&
            samePath(cwd, expected);
        }
        const time = Date.parse(row.timestamp);
        if (
          !this.trusted ||
          !Number.isFinite(time) ||
          time < Date.parse(this.input.startedAt)
        )
          continue;
        if (row.type === "turn_context" && typeof p?.model === "string") {
          this.input.telemetry.metadata({
            actual_model: p.model,
            effort: typeof p.effort === "string" ? p.effort : undefined,
            model_source: "native_session",
          });
        }
        if (
          row.type === "event_msg" &&
          p?.type === "token_count" &&
          p.rate_limits
        ) {
          this.input.telemetry.quota(
            p.rate_limits,
            row.timestamp,
            "native_session",
          );
        }
      }
    } finally {
      await file.close();
    }
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.poll();
    this.stopped = true;
  }
}
