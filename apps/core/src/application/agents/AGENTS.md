# Agent Application Services

- Prompt profile defaults must keep shared behavioral guidance in generated
  runtime sections, not in `agents/shared` host-path files.
- `SOUL.md` and `AGENTS.md` prompt profiles are protected FileArtifacts scoped
  to the agent. Seed them only when an agent is created or registered, and edit
  them only through the reviewed `request_agent_profile_update` flow.
- `SOUL.md` is advisory voice/identity only; it never overrides safety,
  permissions, runtime policy, or current user/admin instructions.
- Keep `AGENTS.md` stable, agent-specific, and advisory (it is not authority and
  grants no permissions). Memory rules, continuity rules, capability-change
  rules, privacy defaults, and channel communication defaults belong in
  generated prompt guidance so every agent receives them.
