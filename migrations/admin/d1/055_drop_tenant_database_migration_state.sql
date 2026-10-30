-- Migration: 055_drop_tenant_database_migration_state.sql
-- Description: Remove the unused Admin migration state table so the migration engine can own its sentinel.
-- Date: 2026-10-30
--
-- Live tenant migration state belongs to Control's control_tenant_database_migration_state.
-- Published Admin baselines remain immutable; existing installations receive this forward drop.

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP INDEX IF EXISTS idx_tenant_database_migration_state_status;
DROP TABLE IF EXISTS tenant_database_migration_state;
