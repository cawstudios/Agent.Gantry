-- boondi-crm migration 0003 — admin comments on Boondi response messages.
--
-- Owned by the boondi-crm connector, not Gantry core. The table intentionally
-- does not reference Gantry's messages table: the service validates targets at
-- write time against the configured Gantry schema while keeping CRM migrations
-- independent of core schema ownership.

CREATE TABLE IF NOT EXISTS boondi_response_comments (
  message_id      text PRIMARY KEY,
  conversation_id text NOT NULL,
  comment_text    text NOT NULL CHECK (
    length(btrim(comment_text)) > 0
    AND length(comment_text) <= 4000
  ),
  author_email    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_brc_conversation_updated
  ON boondi_response_comments (conversation_id, updated_at DESC);
