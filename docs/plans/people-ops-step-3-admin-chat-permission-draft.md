# People Ops Step 3: Admin Chat to Permission and Tool Draft

**Status:** In Progress  
**Date:** 2026-04-25  
**Dependencies:** Steps 1, 2, 2.5 (completed)

## Objective

Allow admins to request tool or permission changes via Slack chat, translate requests into structured drafts for `permissions.yaml`, and show drafts for explicit approval before activation.

## Acceptance Criteria

1. Admin can ask in Slack for a tool or permission change
2. System translates the request into a structured draft (YAML format)
3. Draft is shown back to admin for explicit approval
4. No permission/tool change can run without explicit approval
5. Drafts are persisted in SQLite for audit trail

## Implementation Components

### 1. Database Schema (messages.db)

```sql
-- Permission draft tables
CREATE TABLE permission_drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  draft_type TEXT NOT NULL, -- 'tool_change' | 'permission_change' | 'config_change'
  requested_by TEXT NOT NULL, -- Slack user ID
  request_text TEXT NOT NULL, -- Original request
  draft_yaml TEXT NOT NULL, -- Structured YAML draft
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by TEXT, -- Slack user ID who approved/rejected
  reviewed_at TEXT,
  rejection_reason TEXT,
  applied_at TEXT,
  error_message TEXT
);

CREATE INDEX idx_permission_drafts_agent_status 
  ON permission_drafts(agent_id, status, created_at DESC);

CREATE TABLE permission_draft_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- 'created' | 'approved' | 'rejected' | 'applied' | 'failed'
  actor TEXT NOT NULL, -- Slack user ID or 'system'
  details TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (draft_id) REFERENCES permission_drafts(id) ON DELETE CASCADE
);

CREATE INDEX idx_permission_draft_audit_draft_id 
  ON permission_draft_audit(draft_id, created_at DESC);
```

### 2. Permission Draft Service

**File:** `.runtime/agent-runner/src/permission-draft-service.ts`

```typescript
// Interfaces for permission drafts
export interface PermissionDraft {
  id: string;
  agentId: string;
  draftType: 'tool_change' | 'permission_change' | 'config_change';
  requestedBy: string;
  requestText: string;
  draftYaml: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  appliedAt?: string;
  errorMessage?: string;
}

export interface PermissionDraftRequest {
  agentId: string;
  requestedBy: string;
  requestText: string;
}

export interface PermissionDraftApproval {
  draftId: string;
  approvedBy: string;
  approved: boolean;
  reason?: string;
}

// Service functions
export class PermissionDraftService {
  constructor(private dbPath: string) {}

  // Create a new permission draft
  async createDraft(request: PermissionDraftRequest): Promise<PermissionDraft>;

  // Get draft by ID
  async getDraft(draftId: string): Promise<PermissionDraft | null>;

  // List pending drafts for an agent
  async listPendingDrafts(agentId: string): Promise<PermissionDraft[]>;

  // Approve or reject a draft
  async approveDraft(approval: PermissionDraftApproval): Promise<void>;

  // Apply an approved draft to the agent's permissions.yaml
  async applyDraft(draftId: string): Promise<void>;

  // Parse natural language request into structured YAML
  async parseRequestToYaml(requestText: string): Promise<string>;
}
```

### 3. Admin Request Detection

**File:** `.runtime/agent-runner/src/admin-request-parser.ts`

```typescript
export interface AdminRequest {
  isPermissionRequest: boolean;
  isWorkflowRequest: boolean;
  confidence: number;
  extractedIntent?: {
    type: 'add_tool' | 'remove_tool' | 'add_permission' | 'remove_permission' | 'update_rate_limit';
    target: string;
    value?: boolean | number;
  };
}

export function parseAdminRequest(message: string): AdminRequest {
  // Detect permission/tool change requests
  const patterns = [
    /(?:add|enable|give|grant)\s+(?:me\s+)?(?:access\s+to\s+)?(?:the\s+)?(\w+)\s*(?:tool|command)/i,
    /(?:remove|disable|revoke)\s+(?:the\s+)?(\w+)\s*(?:tool|command)/i,
    /(?:change|update|set|increase|decrease)\s+(\w+)\s+(?:limit|quota)/i,
  ];

  // Analyze message and return structured intent
  // ...
}
```

### 4. Integration with Agent Runner

Modify `agent-runner/src/index.ts` to:

1. **Detect admin requests** in incoming messages
2. **Create permission drafts** when detected
3. **Present drafts for approval** before executing
4. **Apply approved drafts** to permissions.yaml

### 5. Admin Slack Commands

Supported commands:
- `/permission add <tool>` - Request adding a tool
- `/permission remove <tool>` - Request removing a tool  
- `/permission limit <type> <number>` - Request rate limit change
- `/permission approve <draft-id>` - Approve a pending draft
- `/permission reject <draft-id> [reason]` - Reject a pending draft
- `/permission status` - Show pending drafts

### 6. YAML Generation

Generate structured YAML drafts like:

```yaml
tools:
  message_send: true
  message_read: true
  bash: false
  web_search: true  # <-- ADDED
allowed_clis:
  - gworkspace
require_onecli: true
allowed_channel_targets:
  slack:
    - "#hr-managers"
    - "@hr-manager"
rate_limits:
  messages_per_hour: 100  # <-- CHANGED from 80
  summaries_per_hour: 10
```

## Testing Strategy

1. **Unit tests** for request parser patterns
2. **Integration tests** for draft creation and approval flow
3. **E2E tests** with Slack integration
4. **Security tests** ensuring no changes without approval

## Security Considerations

1. **Approval required** - No permission change takes effect without explicit admin approval
2. **Audit trail** - All requests, approvals, and applications are logged
3. **Idempotency** - Duplicate requests detected and handled
4. **Validation** - YAML validation before applying drafts
5. **Rollback** - Previous permissions backed up before changes

## Migration Path

1. Add database tables via migration
2. Deploy permission draft service
3. Add admin request detection to message handler
4. Test with admin users
5. Document admin commands

## Rollback Plan

If issues occur:
1. Stop using permission draft system
2. Revert to manual permissions.yaml editing
3. Disable auto-detection (add feature flag)
4. Keep audit trail for investigation

## Success Metrics

1. Admin requests successfully parsed (>90% accuracy)
2. Draft approval flow completed without errors
3. No permission changes applied without approval
4. Audit trail 100% complete for all changes
