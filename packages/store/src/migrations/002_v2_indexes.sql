-- 架构版本 2: 增强索引以支持高并发出件箱与幂等消费 (RQ-01, RQ-06)
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_wf_kind ON outbox(workflow_id, kind);
CREATE INDEX IF NOT EXISTS idx_entities_kind_owner_version ON entities(kind, owner, version);
