-- Migration: 035_user_lifecycle_state
-- Description: Add lifecycle_state to users_core for account completion/provisioning tracking
-- Date: 2026-04-23

-- SQLite/D1 ALTER TABLE limitations mean we add the column without a CHECK constraint here.
-- Application-level validation and the fresh schema enforce the allowed values:
-- invited, pending_verification, provisioning, incomplete, active,
-- dormant, archived, deprovisioned.

ALTER TABLE users_core ADD COLUMN lifecycle_state TEXT DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_users_core_lifecycle_state
  ON users_core(tenant_id, lifecycle_state);
