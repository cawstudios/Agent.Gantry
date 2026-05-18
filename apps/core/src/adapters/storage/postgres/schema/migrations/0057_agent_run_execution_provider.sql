ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS execution_provider_id text,
  ADD COLUMN IF NOT EXISTS provider_run_id text,
  ADD COLUMN IF NOT EXISTS provider_session_id text,
  ADD COLUMN IF NOT EXISTS worker_id text,
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE agent_runs
SET execution_provider_id = 'anthropic-claude-agent-sdk'
WHERE execution_provider_id IS NULL;

ALTER TABLE agent_runs
  ALTER COLUMN execution_provider_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_runs_execution_provider
  ON agent_runs(execution_provider_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_provider_session
  ON agent_runs(provider_session_id);

CREATE INDEX IF NOT EXISTS idx_agent_runs_lease_claim
  ON agent_runs(status, lease_expires_at, lease_owner);
