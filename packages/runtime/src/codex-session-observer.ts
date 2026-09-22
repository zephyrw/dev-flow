import { readdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { NativeConversationEvent } from "../../adapters/sdk/src/interface.js";
import {
  decodeCodexSessionRecord,
  rootProcessExitState,
} from "../../adapters/codex/src/conversation-source.js";
import type { RunTelemetry } from "./run-telemetry.js";

type BoundSession = {
  id: string;
  parentId?: string;
  file?: string;
  offset: number;
  decoder: StringDecoder;
  buffer: string;
  trusted: boolean;
};

function samePath(a: string, b: string) {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isSessionId(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

async function locateExactSessionFile(
  home: string,
  conversation: string,
  startedAt: string,
): Promise<string | undefined> {
  const dates = [new Date(startedAt)];
  if (conversation[14] === "7")
    dates.push(
      new Date(parseInt(conversation.replace(/-/g, "").slice(0, 12), 16)),
    );
  const dirs = new Set<string>();
  for (const date of dates)
    for (const offset of [-86400000, 0, 86400000]) {
      const d = new Date(date.getTime() + offset);
      if (Number.isFinite(d.getTime()))
        dirs.add(
          join(home, "sessions", ...d.toISOString().slice(0, 10).split("-")),
        );
    }
  const matches: string[] = [];
  for (const dir of dirs) {
    const files = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const file of files)
      if (file.isFile() && file.name.endsWith("-" + conversation + ".jsonl"))
        matches.push(join(dir, file.name));
  }
  if (matches.length === 1) return matches[0];
  return undefined;
}

/** Read only exact bound CLI sessions. No account files, directory-wide log scans or model calls. */
export class CodexSessionObserver {
  private rootId?: string;
  private sessions = new Map<string, BoundSession>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private inflight?: Promise<void>;
  constructor(
    private input: {
      home: string;
      cwd: string;
      startedAt: string;
      telemetry?: RunTelemetry;
      onConversationEvent?: (event: NativeConversationEvent) => void;
    },
  ) {}
  bind(conversation: string) {
    if (this.stopped || this.rootId === conversation) return;
    if (this.rootId || !isSessionId(conversation)) return;
    this.rootId = conversation;
    this.sessions.set(conversation, this.newBound(conversation));
    this.ensureTimer();
    void this.poll();
  }
  bindChild(conversation: string, parentId: string) {
    if (this.stopped || !isSessionId(conversation) || !isSessionId(parentId))
      return;
    if (!this.rootId) return;
    const existing = this.sessions.get(conversation);
    if (existing) return;
    this.sessions.set(conversation, this.newBound(conversation, parentId));
    this.ensureTimer();
    void this.poll();
  }
  notifyRootProcessExit() {
    if (!this.rootId) return;
    const payload = rootProcessExitState();
    this.emit({
      source_id: `codex:session:${this.rootId}`,
      source_seq: "root-process-exit",
      root_native_id: this.rootId,
      session_native_id: this.rootId,
      kind: "state",
      payload,
    });
  }
  private newBound(id: string, parentId?: string): BoundSession {
    return {
      id,
      parentId,
      offset: 0,
      decoder: new StringDecoder("utf8"),
      buffer: "",
      trusted: false,
    };
  }
  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), 2000);
    this.timer.unref();
  }
  async poll() {
    if (this.stopped) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.readAll().catch(() => {
      /* Optional telemetry must not interrupt execution. Old data is marked stale by the UI. */
    });
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }
  private async readAll() {
    for (const session of this.sessions.values()) await this.readSession(session);
  }
  private async readSession(session: BoundSession) {
    if (!session.file)
      session.file = await locateExactSessionFile(
        this.input.home,
        session.id,
        this.input.startedAt,
      );
    if (!session.file) return;
    const file = await open(session.file, "r");
    try {
      const stat = await file.stat();
      if (stat.size < session.offset) return;
      const size = Math.min(1024 * 1024, stat.size - session.offset);
      if (!size) return;
      const bytes = Buffer.allocUnsafe(size);
      const { bytesRead } = await file.read(bytes, 0, size, session.offset);
      const start = session.offset;
      session.offset += bytesRead;
      session.buffer += session.decoder.write(bytes.subarray(0, bytesRead));
      const lines = session.buffer.split("\n");
      session.buffer = lines.pop() ?? "";
      if (session.buffer.length > 4 * 1024 * 1024) session.buffer = "";
      let lineStart = start;
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        await this.acceptLine(session, line, String(lineStart));
        lineStart += lineBytes;
      }
    } finally {
      await file.close();
    }
  }
  private async acceptLine(
    session: BoundSession,
    line: string,
    sourceSeq: string,
  ) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    const payload = row.payload as Record<string, unknown> | undefined;
    if (row.type === "session_meta") {
      const cwd =
        typeof payload?.cwd === "string"
          ? await realpath(resolve(payload.cwd)).catch(() => "")
          : "";
      const expected = await realpath(this.input.cwd).catch(() => "");
      session.trusted =
        payload?.id === session.id && !!cwd && !!expected && samePath(cwd, expected);
    }
    const time = Date.parse(String(row.timestamp ?? ""));
    if (
      !session.trusted ||
      !Number.isFinite(time) ||
      time < Date.parse(this.input.startedAt)
    )
      return;
    this.applyRootTelemetry(session, row, payload);
    if (!this.input.onConversationEvent) return;
    const events = decodeCodexSessionRecord(row, {
      sourceId: `codex:session:${session.id}`,
      sourceSeq,
      rootNativeId: this.rootId ?? session.id,
      sessionNativeId: session.id,
      parentNativeId: session.parentId,
      occurredAt: String(row.timestamp ?? ""),
    });
    for (const event of events) this.emit(event);
  }
  private applyRootTelemetry(
    session: BoundSession,
    row: Record<string, unknown>,
    payload: Record<string, unknown> | undefined,
  ) {
    if (session.id !== this.rootId || !this.input.telemetry) return;
    if (row.type === "turn_context" && typeof payload?.model === "string") {
      this.input.telemetry.metadata({
        actual_model: payload.model,
        effort: typeof payload.effort === "string" ? payload.effort : undefined,
        model_source: "native_session",
      });
    }
    if (
      row.type === "event_msg" &&
      payload?.type === "token_count" &&
      payload.rate_limits
    ) {
      this.input.telemetry.quota(
        payload.rate_limits,
        String(row.timestamp ?? ""),
        "native_session",
      );
    }
  }
  private emit(event: NativeConversationEvent) {
    this.input.onConversationEvent?.(event);
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.poll();
    this.stopped = true;
  }
}
