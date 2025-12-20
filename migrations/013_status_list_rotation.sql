-- ============================================================================
-- Phase 9.x: Status List Rotation Support
-- ============================================================================
-- Adds rotation support for credential status lists
--
-- Changes:
-- 1. status_lists: Add state, used_count, sealed_at columns
-- 2. issued_credentials: Add status_list_id column
-- ============================================================================

-- ============================================================================
-- Update status_lists table
-- ============================================================================

-- Add state column: 'active' | 'sealed' | 'archived'
-- - active: Currently accepting new credential allocations
-- - sealed: Full, no longer accepting new allocations but still serving status checks
-- - archived: Old list, can be deleted after TTL
ALTER TABLE status_lists ADD COLUMN state TEXT DEFAULT 'active';

-- Add used_count to track allocated indices
ALTER TABLE status_lists ADD COLUMN used_count INTEGER DEFAULT 0;

-- Add sealed_at timestamp
ALTER TABLE status_lists ADD COLUMN sealed_at TEXT;

-- Create index for efficient active list lookup
CREATE INDEX IF NOT EXISTS idx_status_lists_tenant_state ON status_lists(tenant_id, state);

-- ============================================================================
-- Update issued_credentials table
-- ============================================================================

-- Add status_list_id to track which list the credential belongs to
ALTER TABLE issued_credentials ADD COLUMN status_list_id TEXT REFERENCES status_lists(id);

-- Create index for efficient lookup by status list
CREATE INDEX IF NOT EXISTS idx_issued_credentials_status_list ON issued_credentials(status_list_id);
