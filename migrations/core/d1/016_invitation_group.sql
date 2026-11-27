-- Migration: 016_invitation_group.sql
-- Description: The group an invitation joins (optional). Redeeming an invitation that names a
--              group writes a membership of the new account (assignment_source 'invitation',
--              source_ref the invitation id) on the account's database. The group is in the
--              tenant metadata database, so the column carries no foreign key; the admin API
--              checks the group when the invitation is created. org_id stays until the
--              organisations are removed.
-- Author: @authrim
-- Date: 2026-11-27

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

ALTER TABLE tenant_invitations ADD COLUMN group_id TEXT;
