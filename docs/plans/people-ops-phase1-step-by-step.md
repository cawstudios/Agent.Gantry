# People Ops Agent Phase 1 Step-by-Step Plan

**Status:** Draft  
**Date:** 2026-04-22  
**Scope:** One reliable Slack-first HR agent on one VM using existing MyClaw seams

## Objective

Ship one `people-ops-agent` with config-driven workflows, durable SQLite state, and controlled Slack operations.  
Phase 1 is a vertical slice, not a platform rewrite.

## Phase 1 Acceptance Criteria

1. Daily check-ins run automatically on schedule.
2. Missing responders receive follow-up messages.
3. Reminder workflows can be scheduled and executed.
4. Manager summaries are generated and sent.
5. Admin can ask in Slack for a new workflow, AI drafts a structured workflow, and the workflow activates only after explicit approval.
6. Admin can ask in Slack for tool or permission changes, AI drafts the config change, and the change activates only after explicit approval.
7. A second similar agent can be added mostly by copying config, adjusting permissions, and deploying.

## Fixed Scope and Constraints

### In Scope

1. Runtime model: one Node.js process on one VM.
2. Data model: one SQLite DB.
3. Channel model: one Slack workspace/app.
4. Workflow types: `check-in`, `follow-up`, `reminder`, `summary`.
5. Config-driven behavior through `agent.yaml`, `permissions.yaml`, and workflow files.
6. Admin chat flow for workflow creation: request -> AI draft -> approval -> activation.
7. Admin chat flow for tools and permissions: request -> AI draft -> approval -> activation.

### Not In Scope

1. Unbounded no-approval natural-language workflow creation.
2. Unbounded no-approval tool or permission changes.
3. Web UI for workflow/agent authoring.
4. Multi-agent orchestration platform.
5. New infra stack (Temporal/Kafka/Postgres/Redis/event bus/control plane).
6. Container/Kubernetes runtime abstraction for this phase.

## Runtime Flow Diagram

```mermaid
flowchart TD
    A[Admin asks in Slack] --> B[AI drafts workflow]
    B --> C[Human approval]
    C --> D[Persist workflow definition]
    A --> L[AI drafts tool/permission change]
    L --> M[Human approval]
    M --> N[Persist config change]
    D --> E[Scheduler trigger / Slack event]
    N --> G[Config-driven People Ops agent]
    E --> F[Workflow dispatcher]
    F --> G
    G --> H[Slack actions/messages]
    G --> I[Optional permitted CLI tools]
    H --> J[SQLite workflow state + checkpoints + audit log]
    I --> J
    J --> K[Manager summary / retry / escalation]
```

## Step-by-Step Development Plan

### Step 1: Agent Registry From Config

1. Add registry/loading so runtime discovers named agents from files.
2. Initial target: `agents/people-ops-agent/agent.yaml`.
3. Done when `people-ops-agent` boots without hardcoded behavior.
4. Detailed execution doc: `docs/plans/people-ops-step-1-agent-registry.md`.
5. Status: Completed on 2026-04-23.

### Step 2: Permission Profile Layer

1. Load per-agent `permissions.yaml`.
2. Enforce allowed tools, allowed CLIs, allowed channel destinations, and base rate limits.
3. Done when policy checks run before outbound actions/tool use.
4. Detailed execution doc: `docs/plans/people-ops-step-2-permission-profile.md`.
5. Status: Completed on 2026-04-24.

### Step 2.5: Channel-To-Agent Binding Cleanup

1. Let `agent.yaml` declare owned registered channel JIDs.
2. Reconcile registered channel rows so active channels point at configured agent folders instead of anonymous folders like `g1`.
3. Preserve existing channel session and scheduled job state during migration.
4. Done when `claw-test-channel` resolves to `people-ops-agent`.
5. Status: Completed on 2026-04-24.

### Step 3: Admin Chat To Permission And Tool Draft

1. Allow an admin to ask in Slack for a tool or permission change.
2. Translate the request into a structured draft for `permissions.yaml` or equivalent permission state.
3. Show the draft back to the admin for explicit approval.
4. Done when a permission/tool request can move from chat text to a reviewable structured draft.
5. Detailed execution doc: `docs/plans/people-ops-step-3-admin-chat-permission-draft.md`.
6. Status: Completed on 2026-04-25.

**Implemented Components:**
- Database migration 003_permission_drafts.sql
- Permission draft service with YAML generation
- Admin request parser for natural language and commands
- Approval workflow with audit trail
- Integration layer for agent-runner
- Comprehensive test suite
- Admin documentation guide

### Step 4: Workflow Definition Schema

1. Introduce minimal schema for recurring workflows with fixed step types.
2. Schema includes trigger, audience selector, timeout, retry policy, summary target, and ordered steps.
3. Done when workflow files validate deterministically at startup.
4. Detailed execution doc: `docs/plans/people-ops-step-4-workflow-schema.md`.
5. Status: Completed on 2026-04-25.

**Implemented Components:**
- Workflow schema TypeScript interfaces (workflow-schema.ts)
- Workflow validator with comprehensive checks (workflow-validator.ts)
- Workflow loader with YAML parsing and caching (workflow-loader.ts)
- Four example workflows for people-ops-agent:
  - attendance-daily.yaml - Daily check-in at 9 AM
  - attendance-followup.yaml - Follow-up reminders
  - self-appraisal-reminder.yaml - Monthly appraisal cycle
  - manager-summary.yaml - Daily manager reports
- Template files for workflows (checkin.md, followup.md, summary.md, appraisal-reminder.md)

### Step 5: Admin Chat To Workflow Draft

1. Allow an admin to ask for a new workflow in Slack.
2. Translate the request into a structured workflow draft limited to the fixed Phase 1 step types.
3. Show the draft back to the admin for explicit approval.
4. Done when a workflow request can move from chat text to a reviewable structured draft.

### Step 6: SQLite Workflow Persistence

1. Add workflow durability tables:
2. `agent_workflows`
3. `workflow_runs`
4. `workflow_checkpoints`
5. `workflow_targets`
6. `workflow_events`
7. `audit_events`
8. Done when definitions, runs, checkpoints, and audit events survive process restart.

### Step 7: Approval To Activation

1. After admin approval, persist and activate the drafted workflow, tool change, or permission change.
2. Reject or discard drafts that are not approved.
3. Done when no chat-authored workflow, tool change, or permission change can run without explicit approval.

### Step 8: Scheduler to Workflow Dispatch

1. Wire `task-scheduler.ts` to enqueue workflow runs by `workflow_id`.
2. Cron triggers produce workflow runs instead of raw prompts.
3. Done when schedule -> run -> persisted state path is stable.

### Step 9: Step Executor for Phase 1 Step Types

1. Implement only:
2. `send_message`
3. `wait_for_reply`
4. `follow_up_if_missing`
5. `post_summary`
6. `write_state`
7. `mark_complete`
8. Done when each step type executes with checkpoint and retry semantics.

### Step 10: Build `people-ops-agent` Workflow Files

1. Add workflow specs under `agents/people-ops-agent/workflows/`:
2. `attendance-daily.yaml`
3. `attendance-followup.yaml`
4. `self-appraisal-reminder.yaml`
5. `manager-summary.yaml`
6. Bind templates under `agents/people-ops-agent/templates/`.
7. Done when all four workflows pass schema validation and can be scheduled.

### Step 11: Operational Logging and Audit Trail

1. Log every outbound action and every workflow transition.
2. Include actor, workflow/run identifiers, target, action, result, timestamp, and correlation id.
3. Done when a full run can be reconstructed from persisted audit records.

### Step 12: Dev Validation

1. Run locally with test Slack workspace/channels and fake roster CSV.
2. Validate chat request -> AI draft -> approval -> activation path.
3. Validate tool/permission request -> AI draft -> approval -> activation path.
4. Validate daily check-in, missing-response follow-up, reminder schedule, and manager digest.
5. Done when acceptance criteria pass in local dev with repeatable runs.

### Step 13: Staging Rollout

1. Deploy same artifact shape to staging VM with staging Slack app/tokens.
2. Use limited pilot audience.
3. Done when a one-week staging burn-in has no blocker incidents.

### Step 14: Production Launch

1. Promote same artifact/config shape to prod VM.
2. Start with limited pilot group, then expand.
3. Done when pilot week is stable and all acceptance criteria remain green.

## Configuration Layout (Target)

```text
~/myclaw/
  settings.yaml
  .env
  agents/
    people-ops-agent/
      agent.yaml
      permissions.yaml
      prompt.md
      workflows/
        attendance-daily.yaml
        attendance-followup.yaml
        self-appraisal-reminder.yaml
        manager-summary.yaml
      templates/
        checkin.md
        followup.md
        summary.md
```

## Step-by-Step Execution Rule

1. Implement exactly one step at a time in order.
2. Run validation for that step before starting the next step.
3. Do not expand scope without explicitly updating this plan.
