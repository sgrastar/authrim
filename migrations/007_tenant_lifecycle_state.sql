-- =============================================================================
-- Tenant lifecycle state
-- Replace tenants.is_active with tenants.lifecycle_state as the canonical lifecycle gate.
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN (
    'provisioning',
    'active',
    'suspended',
    'frozen',
    'migration_read_only',
    'deleting',
    'deleted',
    'restore_pending',
    'restore_validating'
  ));

UPDATE tenants
SET lifecycle_state = CASE WHEN is_active = 1 THEN 'active' ELSE 'suspended' END
WHERE lifecycle_state IS NULL OR lifecycle_state = 'active';

ALTER TABLE tenants DROP COLUMN is_active;
