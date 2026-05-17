---
name: provider-adapter
description: Use for LLM, channel, browser, sandbox, credential, and external provider adapter changes in Gantry.
---

# Provider Adapter

Use this skill when a task changes LLM providers, channel providers, browser providers, sandbox providers, credential brokers, provider sessions, or provider-specific SDK integration.

## Required Workflow

1. Read `docs/decisions/0001-agent-runtime-platform.md`, `docs/architecture/codebase-refactor-principles.md`, and relevant provider or credential decision records.
2. Implement provider behavior behind ports or adapter-owned APIs. Do not leak provider SDK types, callback shapes, model IDs, or channel payloads into domain/application logic.
3. Normalize inbound channel payloads into canonical app, conversation, thread, message, session, and run concepts before application behavior runs.
4. Translate provider failures into stable application errors or decisions at the adapter boundary.
5. Add or update provider-session, resume, channel wiring, or message persistence tests for changed behavior.
6. Run `python3 .codex/scripts/check_architecture.py` and `python3 .codex/scripts/check_task_completion.py` before final handoff when possible.

## Evidence To Provide

- Port or adapter boundary used.
- Provider leakage checked.
- Resume/session or message persistence tests updated when relevant.
