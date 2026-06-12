---
name: capability-lifecycle
description: Guides Gantry tool, skill, MCP server, browser, local CLI, semantic capability, inventory, and permission lifecycle work. Use when changing durable capability selection, visible attached sources, transient request_permission flows, or agent access review paths.
---

# Capability Lifecycle

Use this skill for durable agent capability work and for changes that could
blur visibility, inventory, authority, or one-off permission grants.

## Required Workflow

1. Read `docs/architecture/capability-management.md`, `docs/decisions/2026-05-20-simple-permission-and-job-tool-lifecycle.md`, and `docs/architecture/codebase-refactor-principles.md`.
2. Preserve the split: `sources` are attached/onboarded resources, `capabilities` are durable authority, and `inventory` is read-only discoverability.
3. Use `capability_search`, `propose_capability`, and `manage_capability` for reviewed semantic capability changes.
4. Keep `request_permission` for one-off exact access, Browser, exact Gantry admin tools, provider/channel permissions, or scoped `RunCommand(<literal argv pattern>)` fallback when no reviewed semantic capability fits.
5. State whether the change affects transient approval, persistent capability selection, or both.
6. Keep Browser durable authority canonical as `browser.use`; do not persist provider-private browser tool names as authority.
7. For `local_cli` capabilities, require pinned executable identity, auth/preflight, protected paths, denied environment overrides, and reviewed command templates.

## Evidence To Provide

- Which lane changed: `sources`, `capabilities`, `inventory`, transient permission, or runtime projection.
- Human/admin review path for durable access changes.
- Settings/API/MCP/admin-tool round-trip impact.
- Tests proving visibility and authority do not collapse into one field.
