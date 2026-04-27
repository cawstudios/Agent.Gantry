ALTER TABLE provider_sessions
  ADD COLUMN IF NOT EXISTS latest_artifact_id text;

CREATE TABLE IF NOT EXISTS provider_session_artifacts (
  id text PRIMARY KEY,
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_session_id text NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  provider_session_id text NOT NULL,
  provider text NOT NULL,
  artifact_kind text NOT NULL,
  storage_type text NOT NULL,
  storage_ref text NOT NULL,
  content_hash text NOT NULL,
  size_bytes integer NOT NULL,
  content_text text,
  metadata_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_provider_session_artifacts_latest
  ON provider_session_artifacts(provider_session_id, artifact_kind, created_at, id);

CREATE INDEX IF NOT EXISTS idx_provider_session_artifacts_session
  ON provider_session_artifacts(agent_session_id, provider, artifact_kind, created_at);
