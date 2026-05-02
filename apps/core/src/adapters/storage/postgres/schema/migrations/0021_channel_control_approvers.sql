CREATE TABLE IF NOT EXISTS conversation_approvers (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversation_approvers_conversation
  ON conversation_approvers(conversation_id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_conversation_approvers_user
  ON conversation_approvers(app_id, conversation_id, external_user_id);
