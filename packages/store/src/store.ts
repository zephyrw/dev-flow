import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { FlowError, type DomainEvent } from "../../contracts/src/index.js";
import { canonical, hash, id, now, publicEvent } from "../../core/src/util.js";
import { runMigrations } from "./migrations/index.js";

export class Store extends EventEmitter {
  db: Database.Database;
  private depth = 0;
  private pending: DomainEvent[] = [];
  private publicCache = new Map<string, DomainEvent>();
  constructor(public file: string) {
    super();
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { timeout: 5000 });
    runMigrations(this.db);
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as any).then === "function")
        throw new FlowError("ASYNC_TRANSACTION", "事务中禁止等待异步操作");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.pending = [];
      throw e;
    } finally {
      this.depth--;
    }
    const events = this.pending.splice(0);
    for (const event of events) {
      for (const listener of this.listeners("event")) {
        try {
          listener(event);
        } catch (error) {
          console.error("Event subscriber failed", error);
        }
      }
    }
    return result;
  }
  get<T>(kind: string, key: string): T | undefined {
    const r = this.db
      .prepare("SELECT data FROM entities WHERE kind=? AND id=?")
      .get(kind, key) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as T) : undefined;
  }
  must<T>(kind: string, key: string): T {
    const v = this.get<T>(kind, key);
    if (!v) throw new FlowError("NOT_FOUND", `${kind} ${key} 不存在`, 404);
    return v;
  }
  list<T>(kind: string, owner?: string): T[] {
    const rows =
      owner === undefined
        ? this.db
            .prepare("SELECT data FROM entities WHERE kind=? ORDER BY rowid")
            .all(kind)
        : this.db
            .prepare(
              "SELECT data FROM entities WHERE kind=? AND owner=? ORDER BY rowid",
            )
            .all(kind, owner);
    return (rows as { data: string }[]).map((r) => JSON.parse(r.data) as T);
  }
  put(kind: string, key: string, owner: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO entities(kind,id,owner,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,owner=excluded.owner,version=entities.version+1",
      )
      .run(kind, key, owner, canonical(data));
  }
  entries<T>(kind: string, owner: string): { id: string; value: T }[] {
    return (
      this.db
        .prepare("SELECT id,data FROM entities WHERE kind=? AND owner=?")
        .all(kind, owner) as { id: string; data: string }[]
    ).map((row) => ({ id: row.id, value: JSON.parse(row.data) as T }));
  }
  remove(kind: string, key: string) {
    this.db
      .prepare("DELETE FROM entities WHERE kind=? AND id=?")
      .run(kind, key);
  }
  event(
    workflow_id: string,
    project_id: string,
    type: string,
    payload: unknown,
    run_id?: string,
  ): DomainEvent {
    return this.transaction(() => {
      const r = this.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM events WHERE workflow_id=?",
        )
        .get(workflow_id) as { seq: number };
      const e = {
        workflow_id,
        project_id,
        event_seq: r.seq,
        type,
        payload,
        created_at: now(),
        ...(run_id ? { run_id } : {}),
      };
      this.db
        .prepare("INSERT INTO events VALUES(?,?,?)")
        .run(workflow_id, r.seq, canonical(e));
      this.pending.push(e);
      return e;
    });
  }
  events(workflow: string, after = 0, limit = 100): DomainEvent[] {
    return this.db
      .prepare<unknown[], { data: string }>(
        "SELECT data FROM events WHERE workflow_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(workflow, after, Math.min(1000, limit))
      .map((r) => JSON.parse(r.data as string));
  }
  recentEvents(workflow: string, limit = 500): DomainEvent[] {
    return this.db
      .prepare<unknown[], { data: string }>(
        "SELECT data FROM events WHERE workflow_id=? ORDER BY seq DESC LIMIT ?",
      )
      .all(workflow, Math.min(1000, limit))
      .reverse()
      .map((r) => JSON.parse(r.data as string));
  }
  publicEvent(event: DomainEvent): DomainEvent {
    const key = `${event.workflow_id}:${event.event_seq}`;
    const cached = this.publicCache.get(key);
    if (cached) return cached;
    const result = publicEvent(event) as DomainEvent;
    this.publicCache.set(key, result);
    if (this.publicCache.size > 4000)
      this.publicCache.delete(this.publicCache.keys().next().value!);
    return result;
  }
  eventCursor(workflow: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE workflow_id=?",
        )
        .get(workflow) as { seq: number }
    ).seq;
  }
  deduplicate<T>(key: string, request: unknown, fn: () => T): T {
    return this.transaction(() => {
      const requestHash = hash(canonical(request));
      const r = this.db.prepare("SELECT * FROM dedup WHERE key=?").get(key) as
        | { request_hash: string; result: string }
        | undefined;
      if (r) {
        if (r.request_hash !== requestHash)
          throw new FlowError(
            "IDEMPOTENCY_CONFLICT",
            "同一幂等键的参数不同",
            409,
          );
        return JSON.parse(r.result) as T;
      }
      const result = fn();
      this.db
        .prepare("INSERT INTO dedup VALUES(?,?,?)")
        .run(key, requestHash, canonical(result));
      return result;
    });
  }
  enqueue(workflow: string, kind: string, data: unknown) {
    const key = id("out");
    this.db
      .prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
      .run(key, workflow, kind, canonical(data), "pending", now());
    return key;
  }
  jobs() {
    return this.db
      .prepare(
        "SELECT * FROM outbox WHERE status='pending' ORDER BY created_at",
      )
      .all() as unknown as {
      id: string;
      workflow_id: string;
      kind: string;
      data: string;
    }[];
  }
  jobStatus(key: string, status: string) {
    this.db.prepare("UPDATE outbox SET status=? WHERE id=?").run(status, key);
  }
  close() {
    this.db.close();
  }
}
