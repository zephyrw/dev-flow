-- 初始架构版本 1: 核心实体、事件、去重与任务队列
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS entities(
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  owner TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(kind, id)
);

CREATE INDEX IF NOT EXISTS entities_owner ON entities(kind, owner);

CREATE TABLE IF NOT EXISTS events(
  workflow_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(workflow_id, seq)
);

CREATE TABLE IF NOT EXISTS dedup(
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox(
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens(
  hash TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
