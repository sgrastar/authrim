-- Migration: 018_drop_persistent_identifier_profiles.sql
-- Description: The persistent_identifier mapping step replaces persistent identifier profiles.
--              - Dropped: persistent_identifier_profiles and its index. The old
--                oidc_pairwise_sub / saml_edu_person_targeted_id transform operations and their
--                profile settings are no longer read. No data is carried over (no backward
--                compatibility); the key_registries table and its secrets stay.
--              Holds no personal data.
-- Author: @authrim
-- Date: 2026-11-14
-- Issue: Persistent identifier step PR-3 (removal of the old system)

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP INDEX IF EXISTS idx_persistent_identifier_profiles_tenant_state;
DROP TABLE IF EXISTS persistent_identifier_profiles;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- The dropped table is not recreated (its definition stays in the baseline migration).
-- DELETE FROM schema_migrations WHERE version = 18;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 018
-- =============================================================================
