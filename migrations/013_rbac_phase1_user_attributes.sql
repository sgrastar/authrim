-- Migration: 013_rbac_phase1_user_attributes.sql
-- Description: Add user_type column to users table
-- Author: @authrim
-- Date: 2025-11-30
-- Issue: RBAC/ABAC Implementation Phase 1

-- =============================================================================
-- 1. Add user_type column to users table
-- =============================================================================
-- user_type is a coarse classification for UI/logging purposes.
-- Actual authorization should use role_assignments, NOT user_type.
--
-- Values:
--   - end_user: Regular end user (default)
--   - distributor_admin: Distributor/reseller administrator
--   - enterprise_admin: Enterprise customer administrator
--   - system_admin: System administrator

ALTER TABLE users ADD COLUMN user_type TEXT NOT NULL DEFAULT 'end_user';

-- =============================================================================
-- 2. Create index for user_type
-- =============================================================================

CREATE INDEX idx_users_user_type ON users(user_type);

-- =============================================================================
-- 3. Note: primary_org_id is NOT added in Phase 1
-- =============================================================================
-- Primary organization is determined by subject_org_membership.is_primary = 1.
-- This avoids dual source of truth issues.
-- If performance becomes a concern, primary_org_id can be added as a cache
-- column in a future migration.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 013
-- =============================================================================
