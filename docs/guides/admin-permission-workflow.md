# Admin Permission Workflow Guide

## Overview

The MyClaw Permission Draft System allows admins to request, review, and approve changes to agent permissions and tools through Slack chat. All permission changes require explicit approval before taking effect.

## How It Works

1. **Request** - Admin requests a permission/tool change via Slack
2. **Draft** - System generates a structured YAML draft showing the proposed changes
3. **Review** - Admin reviews the draft to understand what will change
4. **Approve/Reject** - Admin explicitly approves or rejects the draft
5. **Apply** - Approved changes are automatically applied to the agent's permissions.yaml

## Available Commands

### Request Permission Changes

#### Natural Language Requests
You can request changes using plain English:

```
add web_search tool
remove bash tool
change messages_per_hour limit to 100
increase summaries_per_hour limit by 5
```

#### Explicit Commands
Or use explicit `/permission` commands:

```
/permission add <tool_name>
/permission remove <tool_name>
/permission limit <limit_type> <value>
```

### Review and Approve Drafts

#### List Pending Drafts
```
/permission status
```

#### Approve a Draft
```
/permission approve <draft_id>
```

#### Reject a Draft
```
/permission reject <draft_id> [optional reason]
```

## Examples

### Example 1: Add a New Tool

**Step 1: Request the tool**
```
/permission add web_search
```

**Step 2: Review the draft**
The system will show you exactly what will change:
```yaml
tools:
  message_send: true
  message_read: true
  bash: false
  web_search: true  # ADDED VIA DRAFT
...
```

**Step 3: Approve**
```
/permission approve draft-1234567890-abc123
```

### Example 2: Update Rate Limits

**Step 1: Request the change**
```
/permission limit messages_per_hour 100
```

**Step 2: Review the draft**
```yaml
rate_limits:
  messages_per_hour: 100  # CHANGED VIA DRAFT
  summaries_per_hour: 10
```

**Step 3: Approve**
```
/permission approve draft-1234567890-abc123
```

### Example 3: Remove a Tool

**Step 1: Request removal**
```
/permission remove bash
```

**Step 2: Review and approve**
```
/permission approve draft-1234567890-abc123
```

## Draft Lifecycle

Every permission draft goes through these states:

1. **pending** - Draft created, awaiting approval
2. **approved** - Draft approved by admin, not yet applied
3. **rejected** - Draft rejected by admin
4. **applied** - Draft successfully applied to permissions.yaml
5. **failed** - Draft approval succeeded but application failed

## Audit Trail

All permission changes are logged with:
- Who requested the change
- When it was requested
- Who approved/rejected it
- When it was applied
- Any errors that occurred

You can view the audit trail in the database:
```sql
SELECT * FROM permission_draft_audit ORDER BY created_at DESC;
```

## Safety Features

### No Auto-Application
- **No permission change takes effect without explicit approval**
- Drafts must be explicitly approved using `/permission approve`
- You can review the exact YAML changes before approving

### Backup Creation
- Before applying any change, the system backs up the current permissions.yaml
- Backups are named: `permissions.yaml.backup.<timestamp>`
- You can manually revert if needed

### Validation
- YAML is validated before application
- Invalid drafts are rejected with error messages
- Application failures are logged and preserved in the database

## Common Errors

### "Draft not found"
- The draft ID doesn't exist or has been deleted
- Check `/permission status` to see valid draft IDs

### "Draft is not pending"
- The draft has already been approved, rejected, or applied
- You can only approve/reject pending drafts

### "Failed to apply draft"
- The backup succeeded but the new permissions couldn't be written
- Check file permissions and disk space
- The original permissions.yaml is still in place

## Best Practices

1. **Always review drafts carefully** before approving
2. **Test in staging** before applying to production agents
3. **Use natural language** for simple requests, commands for complex ones
4. **Keep draft IDs** when you get them - you'll need them to approve
5. **Check `/permission status`** regularly to review pending drafts

## Security Considerations

- Only authorized admins should have permission to approve drafts
- All approval actions are logged with the approver's identity
- Drafts cannot be modified once created - a new draft must be created
- Applied changes create backups before modifying files

## Rollback

If you need to rollback a permission change:

1. Find the backup file: `permissions.yaml.backup.<timestamp>`
2. Copy it back: `cp permissions.yaml.backup.<timestamp> permissions.yaml`
3. Restart the agent to load the old permissions

## Troubleshooting

### Permission changes not taking effect
1. Check if the draft was actually applied: `/permission status`
2. Look for drafts with status "applied"
3. Restart the agent to reload permissions

### Can't create drafts
1. Check you have admin permissions in the Slack channel
2. Verify the agent is running
3. Check database connectivity

### Draft application failed
1. Check the error message in the draft details
2. Verify file permissions for the permissions.yaml file
3. Check disk space on the server
