---
name: settings-control-plane
description: Guides Gantry changes to settings.yaml desired state, settings projection, control API, CLI, Gantry MCP/admin tools, agents, conversations, model defaults, and provider connections. Use when changing configuration ownership or any settings-backed runtime surface.
---

# Settings Control Plane

Use this skill when a task touches desired state, runtime projection, agent
administration, provider connections, conversation binding, model defaults,
or admin mutation paths.

## Required Workflow

1. Read `docs/decisions/2026-04-17-settings-runtime-truth.md`, `docs/architecture/codebase-refactor-principles.md`, and any relevant architecture docs for the touched surface.
2. Classify new values first: non-secrets in `settings.yaml`, runtime secrets behind `RuntimeSecretProvider`, and agent credentials behind `AgentCredentialBroker`.
3. Treat `settings.yaml` as the restart source of truth for desired-state fields; Postgres/runtime rows are projections unless a decision record says otherwise.
4. Keep parser, renderer, API, CLI, MCP/admin-tool, docs, and tests aligned when the settings shape changes.
5. State whether the change writes `settings.yaml`, reconciles Postgres/runtime projection, and updates API/CLI/MCP/admin-tool surfaces.
6. Do not add runtime-only branches, migration commands, or compatibility shims for stale local settings unless explicitly approved by a decision record.

## Evidence To Provide

- Source-of-truth classification for each changed value.
- Parser/renderer and projection impact.
- API, CLI, MCP/admin-tool, docs, and test impact, including explicit non-impact reasons.
- Verification command covering settings round-trip behavior when changed.
