-- Control API channel onboarding and reversible agent binding disablement.

ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS config_json text NOT NULL DEFAULT '{}';

ALTER TABLE agent_conversation_bindings
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

ALTER TABLE agent_conversation_bindings
  ADD COLUMN IF NOT EXISTS trigger_mode text;

UPDATE agent_conversation_bindings
SET trigger_mode = CASE WHEN requires_trigger THEN 'keyword' ELSE 'always' END
WHERE trigger_mode IS NULL;

ALTER TABLE agent_conversation_bindings
  ALTER COLUMN trigger_mode SET DEFAULT 'keyword',
  ALTER COLUMN trigger_mode SET NOT NULL;

ALTER TABLE agent_conversation_bindings
  ADD COLUMN IF NOT EXISTS memory_scope text NOT NULL DEFAULT 'conversation';

CREATE INDEX IF NOT EXISTS idx_agent_conversation_bindings_agent_conversation
  ON agent_conversation_bindings(app_id, agent_id, conversation_id, thread_id);
