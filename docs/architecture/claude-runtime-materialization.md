# Claude Runtime Materialization

Claude provider files are generated per run. They are compatibility inputs for
the Claude SDK, not MyClaw source of truth.

## Generated Per Run

The Anthropic Claude adapter creates a temporary `CLAUDE_CONFIG_DIR` for each
run. The directory contains:

- `settings.json` rendered by MyClaw
- `skills/` materialized from the active skill source
- `projects/<project>/` used only to restore and capture provider session files

The temp directory is removed after the run unless explicit debug retention is
enabled by the caller.

## Durable Sources

Durable state stays outside Claude runtime files:

- Postgres owns apps, agents, config versions, tools, skills, memory policy,
  permission policy, sessions, messages, and runs.
- `ProviderArtifactStore` owns provider continuation and export bytes.
- Package assets provide bundled compatibility skills until the skill registry
  becomes DB/artifact backed.

The runtime-home Claude directory is not an enterprise runtime source of truth.

## Settings

`settings.json` is rendered from canonical runtime inputs such as effective
agent config, LLM/provider profile, runtime settings, memory behavior, and hook
commands. It must not contain raw provider secrets.

Claude settings are not permission policy. Host-side `PermissionPolicyService`
and sandbox policy remain authoritative for tool execution.

`settings.local.json` is ignored in enterprise runtime because local Claude
settings are not MyClaw policy.

## Skills

Skills are materialized into the temp `skills/` directory. For this cut, the
temporary `SkillSource` reads bundled package assets. Prompt 12A can replace
that source with a DB/artifact-backed `SkillRegistry` without changing Claude
runtime execution.

Durable user-installed files under the runtime-home Claude skills directory are
not read or copied by enterprise runtime.

## Provider Artifacts

Before provider-native resume, MyClaw restores the latest `claude-jsonl`
artifact into the temp project directory. After the run, updated JSONL and
session indexes are captured through `ProviderArtifactStore`, then temp files
are removed.
