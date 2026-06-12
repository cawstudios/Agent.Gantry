---
name: memory-architecture-contract
description: Guides Gantry memory architecture work around session digest, continuity, compaction, dreaming, retrieval, source-first ingestion, and cleanup. Use when planning or changing memory services, generated memories, memory APIs, MCP tools, settings, or retrieval behavior.
---

# Memory Architecture Contract

Use this skill for memory planning, memory service fixes, generated memories,
retrieval claims, compaction handling, and source-first knowledge management.

## Required Workflow

1. Read relevant docs under `docs/architecture/`, `docs/decisions/`, and current memory service code before choosing a design.
2. Prefer digest-first continuity for long sessions; do not reduce memory design to small fact extraction when the task is about session continuity or generated memories.
3. Treat compaction summaries as high-signal inputs, not raw durable memory.
4. Keep dreaming deterministic when used for maintenance: schema-validated operations, idempotency, rollback or replay safety, and auditability.
5. Treat blogs, docs, posts, and files as immutable memory sources feeding reviewed memory, not direct arbitrary `memory_save` writes.
6. Be precise about retrieval. Do not claim semantic/vector retrieval is active unless the current code and tests prove it.
7. Include cleanup across CLI, `settings.yaml`, control API, MCP tools, parser/renderer, docs, and tests when replacing memory behavior.

## Evidence To Provide

- Memory source, continuity, compaction, dreaming, retrieval, and embedding impact.
- API/CLI/MCP/settings surfaces changed or explicitly unchanged.
- Deterministic validation and rollback/audit plan for generated memory operations.
- Tests or code evidence backing any retrieval capability claim.
