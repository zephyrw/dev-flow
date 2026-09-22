import type Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_initial",
    sql: `CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS entities_owner ON entities(kind,owner);
    CREATE TABLE IF NOT EXISTS events(workflow_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workflow_id,seq));
    CREATE TABLE IF NOT EXISTS dedup(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY,data TEXT NOT NULL);`,
  },
  {
    version: 2,
    name: "002_v2_indexes",
    sql: `CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_wf_kind ON outbox(workflow_id, kind);
    CREATE INDEX IF NOT EXISTS idx_entities_kind_owner_version ON entities(kind, owner, version);`,
  },
  {
    version: 3,
    name: "003_conversation_indexes",
    sql: `CREATE INDEX IF NOT EXISTS idx_conversation_node_root ON entities(json_extract(data, '$.root_id')) WHERE kind = 'conversation_node';
    CREATE INDEX IF NOT EXISTS idx_conversation_activity_conversation_seq ON events(workflow_id, json_extract(data, '$.payload.conversation_id'), seq) WHERE json_extract(data, '$.type') = 'ConversationActivity';
    CREATE INDEX IF NOT EXISTS idx_project_aside_created_id ON entities(json_extract(data, '$.created_at'), id) WHERE kind = 'project_aside_index';`,
  },
];

export function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  const currentVersion =
    (db.pragma("user_version", { simple: true }) as number) || 0;

  for (const m of MIGRATIONS) {
    if (m.version > currentVersion) {
      db.transaction(() => {
        db.exec(m.sql);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}
