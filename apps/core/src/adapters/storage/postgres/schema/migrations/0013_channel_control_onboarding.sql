-- Control API channel onboarding and reversible agent binding disablement.

ALTER TABLE channel_installations
  ADD COLUMN IF NOT EXISTS config_json text NOT NULL DEFAULT '{}';

ALTER TABLE agent_channel_bindings
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS trigger_mode text NOT NULL DEFAULT 'keyword',
  ADD COLUMN IF NOT EXISTS memory_scope text NOT NULL DEFAULT 'conversation';

CREATE INDEX IF NOT EXISTS idx_agent_channel_bindings_agent_conversation
  ON agent_channel_bindings(app_id, agent_id, conversation_id, thread_id);
