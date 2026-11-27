-- Migration: 016_invitation_group.sql
-- Description: The group an invitation joins (optional; see the D1 migration of the same name).
--              The PostgreSQL core schema has no tenant_invitations table yet (invitations are
--              D1 only), so the column is added only where the table exists.
-- Author: @authrim
-- Date: 2026-11-27

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE IF EXISTS tenant_invitations ADD COLUMN IF NOT EXISTS group_id TEXT;
