# People Ops Step 4: Workflow Definition Schema

**Status:** In Progress
**Date:** 2026-04-25
**Dependencies:** Steps 1, 2, 2.5, 3 (completed)

## Objective

Define a minimal YAML schema for recurring workflows with fixed step types. The schema must support trigger, audience selector, timeout, retry policy, summary target, and ordered steps. Workflows must validate deterministically at startup.

## Acceptance Criteria

1. Workflow files use a structured YAML schema
2. Schema supports trigger (cron/schedule), audience, steps, timeout, retry policy, summary target
3. Only fixed Phase 1 step types allowed
4. Workflows validate deterministically at startup
5. Validation errors are clear and actionable
6. Example workflows created for people-ops-agent

## Workflow Schema

### Complete Workflow Structure

```yaml
id: attendance-daily
name: Daily Attendance Check-in
description: Send daily attendance check-in to all employees at 9 AM
version: 1.0.0
enabled: true

# Trigger configuration
trigger:
  type: cron
  expression: "0 9 * * *"  # Cron expression
  timezone: Asia/Kolkata

# Who receives this workflow
audience:
  type: roster
  source: file:roster/employees.csv
  filter:
    department: ["HR", "Engineering", "Sales"]
    status: "active"

# Timeout and retry policy
timeout:
  initial: 24h          # How long to wait for first response
  step: 1h              # Timeout between retry steps
  max_duration: 72h     # Maximum total duration

retry_policy:
  max_attempts: 3
  backoff: exponential  # linear | exponential | fixed
  initial_delay: 1h
  max_delay: 24h

# Where to send the summary
summary_target:
  type: slack
  target: "#hr-managers"
  include:
    - respondents
    - non_respondents
    - responses_summary
    - failed_targets

# Workflow steps
steps:
  - id: send_checkin
    type: send_message
    config:
      template: checkin.md
      channel: slack
    timeout: 5m

  - id: wait_response
    type: wait_for_reply
    config:
      timeout: 24h
    depends_on: send_checkin

  - id: follow_non_respondents
    type: follow_up_if_missing
    config:
      template: followup.md
      wait_for: 24h
      max_reminders: 2
    depends_on: wait_response

  - id: generate_summary
    type: post_summary
    config:
      template: summary.md
      include_details: true
    depends_on: follow_non_respondents

  - id: save_state
    type: write_state
    config:
      key: attendance_daily
      include_timestamp: true
    depends_on: generate_summary

  - id: complete
    type: mark_complete
    config:
      status: success
    depends_on: save_state
```

### Fixed Phase 1 Step Types

#### 1. send_message
Send a message to target users.

```yaml
type: send_message
config:
  template: message.md      # Template file path
  channel: slack           # slack | email
  personal: true           # Whether to send personal messages
  subject: "Check-in required"  # For email
timeout: 5m                # Max time to send all messages
```

#### 2. wait_for_reply
Wait for responses from targets.

```yaml
type: wait_for_reply
config:
  timeout: 24h             # How long to wait
  min_responses: 10        # Minimum required responses
  percentage: 80           # Or minimum percentage
depends_on: send_checkin   # Must wait for send_message
```

#### 3. follow_up_if_missing
Follow up with users who haven't responded.

```yaml
type: follow_up_if_missing
config:
  template: followup.md
  wait_for: 24h            # How long to wait before following up
  max_reminders: 2         # Maximum number of reminders
  escalation_target: "@manager"  # Optional escalation
depends_on: wait_response
```

#### 4. post_summary
Post summary to managers.

```yaml
type: post_summary
config:
  template: summary.md
  include_details: true
  format: markdown         # markdown | json | html
depends_on: follow_non_respondents
```

#### 5. write_state
Save workflow state to database.

```yaml
type: write_state
config:
  key: workflow_state      # Key for state storage
  include_timestamp: true
  include_responses: true
depends_on: generate_summary
```

#### 6. mark_complete
Mark workflow as complete.

```yaml
type: mark_complete
config:
  status: success          # success | partial | failed
depends_on: save_state
```

## Validation Rules

### Required Fields
- `id` - Unique workflow identifier
- `name` - Human-readable name
- `trigger` - Must have type and expression/cron
- `audience` - Must have type and source
- `steps` - At least one step

### Trigger Validation
- `type` must be `cron`
- `expression` must be valid cron expression
- `timezone` must be valid IANA timezone

### Audience Validation
- `type` must be `roster` (Phase 1)
- `source` must be `file:` path
- Filter must reference valid CSV columns

### Step Validation
- All step types must be from fixed set
- Step IDs must be unique within workflow
- `depends_on` must reference valid step IDs
- No circular dependencies allowed
- Templates must exist in agent's templates directory

### Template Validation
- All referenced templates must exist
- Templates use valid Mustache syntax
- Required variables available in context

## Implementation Components

### 1. Workflow Schema Module
**File:** `.runtime/agent-runner/src/workflow-schema.ts`

```typescript
export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  version?: string;
  enabled: boolean;
  trigger: TriggerConfig;
  audience: AudienceConfig;
  timeout?: TimeoutConfig;
  retry_policy?: RetryPolicyConfig;
  summary_target?: SummaryTargetConfig;
  steps: WorkflowStep[];
}

export interface WorkflowStep {
  id: string;
  type: StepType;
  config: Record<string, unknown>;
  timeout?: string;
  depends_on?: string[];
}

export type StepType =
  | 'send_message'
  | 'wait_for_reply'
  | 'follow_up_if_missing'
  | 'post_summary'
  | 'write_state'
  | 'mark_complete';

// Validation function
export function validateWorkflow(
  workflow: unknown,
  agentId: string
): ValidationResult;
```

### 2. Workflow Loader Module
**File:** `.runtime/agent-runner/src/workflow-loader.ts`

```typescript
export class WorkflowLoader {
  constructor(private agentConfigPath: string);

  // Load all workflows for an agent
  async loadWorkflows(agentId: string): Promise<WorkflowDefinition[]>;

  // Load single workflow file
  async loadWorkflowFile(filePath: string): Promise<WorkflowDefinition>;

  // Validate workflow exists and is valid
  async validateWorkflow(filePath: string): Promise<ValidationResult>;

  // Get workflow by ID
  async getWorkflow(workflowId: string): Promise<WorkflowDefinition | null>;
}
```

### 3. Workflow Validator
**File:** `.runtime/agent-runner/src/workflow-validator.ts`

```typescript
export class WorkflowValidator {
  // Validate complete workflow
  validate(workflow: WorkflowDefinition, agentId: string): ValidationResult;

  // Validate trigger configuration
  validateTrigger(trigger: TriggerConfig): ValidationResult;

  // Validate audience configuration
  validateAudience(audience: AudienceConfig): ValidationResult;

  // Validate steps
  validateSteps(steps: WorkflowStep[]): ValidationResult;

  // Validate dependencies (no cycles)
  validateDependencies(steps: WorkflowStep[]): ValidationResult;

  // Validate templates exist
  validateTemplates(steps: WorkflowStep[], agentId: string): ValidationResult;
}
```

## Example Workflows for people-ops-agent

### 1. attendance-daily.yaml
Daily attendance check-in workflow.

### 2. attendance-followup.yaml
Follow-up workflow for missing attendance responses.

### 3. self-appraisal-reminder.yaml
Monthly reminder for self-appraisals.

### 4. manager-summary.yaml
Daily summary for managers with attendance status.

## Testing Strategy

1. **Schema validation tests** - Test all validation rules
2. **Workflow loading tests** - Test loading from files
3. **Template validation tests** - Test template existence checks
4. **Dependency validation tests** - Test circular dependency detection
5. **Integration tests** - Test complete workflow loading

## Error Handling

Validation errors should be:
- **Specific** - Exact field and problem identified
- **Actionable** - Clear how to fix
- **Contextual** - Show the invalid value
- **Helpful** - Suggest corrections

Example error messages:
```
❌ Invalid workflow 'attendance-daily':
  - Step 'wait_response' depends on non-existent step 'send_chk'
  - Template 'checkin.md' not found in agents/people-ops-agent/templates/
  - Invalid cron expression: '0 25 * * *' (minute must be 0-59)
```

## Security Considerations

1. **Path traversal** - Validate template paths don't escape agent directory
2. **Code injection** - No code execution in templates
3. **Resource limits** - Max steps, max targets, max duration
4. **Access control** - Only admins can modify workflow files

## Migration Path

1. Create schema definition
2. Implement validation module
3. Create workflow loader
4. Add validation to agent startup
5. Create example workflows
6. Test validation with valid/invalid workflows

## Rollback Plan

If schema issues occur:
1. Disable strict validation (add flag)
2. Log warnings instead of errors
3. Allow workflows to load with warnings
4. Fix schema issues incrementally

## Success Metrics

1. All workflow files validate successfully
2. Invalid workflows caught at startup with clear errors
3. No circular dependencies in valid workflows
4. All templates exist and are accessible
5. Validation completes in < 1 second per workflow
