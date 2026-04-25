-- Migration 003: Permission Draft System
-- This migration adds tables to support admin-driven permission and tool changes
-- with explicit approval workflows and audit trails

-- Permission drafts table
-- Stores draft permission changes requested by admins via chat
CREATE TABLE IF NOT EXISTS permission_drafts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  draft_type TEXT NOT NULL CHECK(draft_type IN ('tool_change', 'permission_change', 'config_change')),
  requested_by TEXT NOT NULL,
  request_text TEXT NOT NULL,
  draft_yaml TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'applied', 'failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  rejection_reason TEXT,
  applied_at TEXT,
  error_message TEXT
);

-- Index for querying pending drafts by agent
CREATE INDEX IF NOT EXISTS idx_permission_drafts_agent_status
  ON permission_drafts(agent_id, status, created_at DESC);

-- Index for querying drafts by requester
CREATE INDEX IF NOT EXISTS idx_permission_drafts_requested_by
  ON permission_drafts(requested_by, created_at DESC);

-- Audit trail for permission drafts
CREATE TABLE IF NOT EXISTS permission_draft_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('created', 'approved', 'rejected', 'applied', 'failed')),
  actor TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (draft_id) REFERENCES permission_drafts(id) ON DELETE CASCADE
);

-- Index for querying audit events by draft
CREATE INDEX IF NOT EXISTS idx_permission_draft_audit_draft_id
  ON permission_draft_audit(draft_id, created_at DESC);

-- Index for querying all audit events by time
CREATE INDEX IF NOT EXISTS idx_permission_draft_audit_created_at
  ON permission_draft_audit(created_at DESC);

-- Trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_permission_drafts_timestamp
AFTER UPDATE ON permission_drafts
FOR EACH ROW
BEGIN
  UPDATE permission_drafts SET updated_at = datetime('now') WHERE id = NEW.id;
END;
