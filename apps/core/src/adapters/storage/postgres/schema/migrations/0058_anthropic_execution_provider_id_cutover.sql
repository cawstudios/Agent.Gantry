UPDATE agent_runs
SET execution_provider_id = 'anthropic:claude-agent-sdk'
WHERE execution_provider_id IN (
  'anthropic',
  'anthropic-claude-agent-sdk'
);

UPDATE provider_sessions
SET
  provider = 'anthropic:claude-agent-sdk',
  provider_ref_json = jsonb_build_object(
    'kind', 'provider_session',
    'value', 'anthropic:claude-agent-sdk:' || external_session_id,
    'provider', 'anthropic:claude-agent-sdk',
    'externalSessionId', external_session_id
  ),
  updated_at = now()
WHERE provider IN (
  'anthropic',
  'anthropic-claude-agent-sdk'
);
