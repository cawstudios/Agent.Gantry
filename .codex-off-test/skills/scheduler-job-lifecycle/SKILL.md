---
name: scheduler-job-lifecycle
description: Guides Gantry autonomous job, scheduler execution, notification route, capability metadata, recovery, terminal evidence, and job visibility work. Use when changing scheduled jobs, run-now/readiness, job tool access, delivery recovery, or job status surfaces.
---

# Scheduler Job Lifecycle

Use this skill when a task touches scheduled or one-time job execution,
recovery, notification, readiness, run-now behavior, or job capability
requirements.

## Required Workflow

1. Read `docs/architecture/autonomous-jobs.md`, `docs/architecture/capability-management.md`, and relevant scheduler/job decision records.
2. Use canonical `execution_context` for runtime execution targeting and canonical `notification_routes` for lifecycle/outcome delivery.
3. Keep job capability metadata runtime-neutral. Put business-specific sheets, docs, accounts, ranges, URLs, and workflow details in the prompt or job-owned manifest.
4. Do not stream or fallback-deliver raw assistant output to scheduler notification routes; send one concise terminal outcome unless the job is silent.
5. Ensure terminal states leave durable user-visible evidence: persist `JobRun`, emit terminal runtime events, deliver outcome notification when routes exist, and persist `notified_at` after successful delivery.
6. Jobs paused for missing capabilities must surface one clear user action in job list/status metadata.
7. Recovery startup must claim due outbound durable delivery across app scopes; do not hard-code recovery to `appId: 'default'`.

## Evidence To Provide

- Execution target and notification route shape.
- Capability metadata classification and any business-specific data location.
- Terminal evidence path and recovery behavior.
- Tests for readiness, run-now, recovery, notification, and stale-field rejection when relevant.
