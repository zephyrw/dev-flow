CREATE INDEX IF NOT EXISTS idx_conversation_node_root
ON entities(json_extract(data, '$.root_id'))
WHERE kind = 'conversation_node';

CREATE INDEX IF NOT EXISTS idx_conversation_activity_conversation_seq
ON events(
  workflow_id,
  json_extract(data, '$.payload.conversation_id'),
  seq
)
WHERE json_extract(data, '$.type') = 'ConversationActivity';

CREATE INDEX IF NOT EXISTS idx_project_aside_created_id
ON entities(json_extract(data, '$.created_at'), id)
WHERE kind = 'project_aside_index';
