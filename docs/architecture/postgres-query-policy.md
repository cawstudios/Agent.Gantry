# Postgres Query Policy

Gantry uses Drizzle as the default interface for repository-owned Postgres data
access. Repositories should define tables in `apps/core/src/adapters/storage/postgres/schema/`
and use Drizzle inserts, updates, deletes, selects, transactions, and upserts for
normal CRUD behavior.

Raw SQL remains acceptable for Postgres operational primitives that Drizzle does
not model as durable application data access:

- migrations and schema bootstrap
- readiness and health probes
- advisory locks that intentionally pin a `pg` client
- `LISTEN`, `UNLISTEN`, and `pg_notify`
- narrow Drizzle `sql` fragments for JSON casts, expression predicates,
  counters, `CASE`, `GREATEST`, and index expressions

Concurrency-sensitive claim paths should still use Drizzle transactions and row
locks when the query builder can express the operation. New raw CRUD queries
should explain why Drizzle is not the better owner and must be added to the
raw-SQL allowlist test deliberately.

Runtime event append and webhook delivery enqueue are one transaction by design:
an event that asks for webhook delivery should not become visible without its
retryable delivery row. Non-webhook subscribers still observe committed events
through the runtime event exchange after that transaction succeeds.
