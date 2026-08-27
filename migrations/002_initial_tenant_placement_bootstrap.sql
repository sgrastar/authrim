-- Migration: 002_initial_tenant_placement_bootstrap.sql
-- Description: Allow Setup to materialize the configured placement of the pristine initial tenant
-- Author: Authrim
-- Date: 2026-08-26

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

-- The semantic baseline seeds one tenant as tenant_exclusive so a database is safe before
-- Setup finishes. Setup must still be able to select shared_pool for that pristine row. Keep
-- the one-way placement guard for every materialized tenant and allow only the untouched,
-- single seeded row to receive its initial policy.
DROP TRIGGER IF EXISTS trg_tenant_placement_policy_no_scope_weakening;

CREATE TRIGGER trg_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON tenants
WHEN OLD.isolation_policy = 'tenant_exclusive'
  AND NEW.isolation_policy <> 'tenant_exclusive'
  AND NOT (
    OLD.id = 'default'
    AND OLD.created_at = OLD.updated_at
    AND (SELECT COUNT(*) FROM tenants) = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_policy_scope_weakening');
END;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- Rollback must recreate trg_tenant_placement_policy_no_scope_weakening without the
-- pristine-row exception. Do not roll back after a shared_pool initial tenant is materialized.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 002
-- =============================================================================
