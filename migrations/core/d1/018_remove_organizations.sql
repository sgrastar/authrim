-- Migration: 018_remove_organizations.sql
-- Description: Organisations are removed; groups replace them (no backward compatibility, no data
--              conversion). Dropped:
--              - organizations, subject_org_membership, org_domain_mappings: tenant organisations,
--                their memberships and the e-mail-domain auto-join mappings. Joining by domain is
--                a dynamic group with a domain condition plus a role assignment to that group.
--              - user_roles and its sg_user_roles_* triggers: SCIM Groups write group_memberships
--                (assignment_source 'scim'); nothing reads user_roles any more.
--              - service_group_manual and its sg_service_group_manual_* triggers: manual
--                memberships are group_memberships rows with assignment_source 'manual'.
--              - roles.parent_role_id (no role inheritance), roles.hierarchy_level (grant_tier is
--                the only delegation guard) and roles.external_id (SCIM Groups no longer use
--                roles), with their indexes.
--              - tenant_invitations.org_id: an invitation joins a group (group_id, migration 016).
--              The input triggers of migration 017 also count 'manual' memberships (a service
--              group input again, read from group_memberships). Holds no personal data.
-- Author: @authrim
-- Date: 2026-11-27

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP TRIGGER IF EXISTS sg_user_roles_insert;
DROP TRIGGER IF EXISTS sg_user_roles_update;
DROP TRIGGER IF EXISTS sg_user_roles_delete;
DROP TRIGGER IF EXISTS sg_service_group_manual_insert;
DROP TRIGGER IF EXISTS sg_service_group_manual_update;
DROP TRIGGER IF EXISTS sg_service_group_manual_delete;

DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS service_group_manual;
DROP TABLE IF EXISTS org_domain_mappings;
DROP TABLE IF EXISTS subject_org_membership;
DROP TABLE IF EXISTS organizations;

DROP INDEX IF EXISTS idx_roles_hierarchy_level;
DROP INDEX IF EXISTS idx_roles_parent_role_id;
ALTER TABLE roles DROP COLUMN hierarchy_level;
ALTER TABLE roles DROP COLUMN parent_role_id;
ALTER TABLE roles DROP COLUMN external_id;

ALTER TABLE tenant_invitations DROP COLUMN org_id;

-- Manual memberships (group_memberships rows with assignment_source 'manual') are now a service
-- group input (member(<group>) reads them, as it read service_group_manual): the input triggers
-- of migration 017 bump the subject's revision for 'manual' rows as for 'scim' ones (same names,
-- same conditions). The epoch of every tenant with a service-group catalog is advanced once, so
-- results computed without the manual input are evaluated again.
DROP TRIGGER IF EXISTS sg_group_memberships_scim_insert;
DROP TRIGGER IF EXISTS sg_group_memberships_scim_update;
DROP TRIGGER IF EXISTS sg_group_memberships_scim_delete;
CREATE TRIGGER sg_group_memberships_scim_insert AFTER INSERT ON group_memberships
WHEN NEW.assignment_source IN ('scim', 'manual') BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_group_memberships_scim_update AFTER UPDATE ON group_memberships
WHEN (NEW.assignment_source IN ('scim', 'manual') OR OLD.assignment_source IN ('scim', 'manual')) AND (
  NEW.assignment_source IS NOT OLD.assignment_source OR NEW.lifecycle_state IS NOT OLD.lifecycle_state
  OR NEW.starts_at IS NOT OLD.starts_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.stale_after IS NOT OLD.stale_after OR NEW.group_id IS NOT OLD.group_id
  OR NEW.subject_id IS NOT OLD.subject_id OR NEW.tenant_id IS NOT OLD.tenant_id) BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.subject_id, 1 WHERE OLD.subject_id IS NOT NEW.subject_id OR OLD.tenant_id IS NOT NEW.tenant_id ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_group_memberships_scim_delete AFTER DELETE ON group_memberships
WHEN OLD.assignment_source IN ('scim', 'manual') BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;

INSERT INTO service_group_epoch(tenant_id, revision)
SELECT tenant_id, 1 FROM service_group_catalog WHERE 1 = 1
ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;

-- =============================================================================
-- Down Migration (Rollback) - not provided
-- =============================================================================
-- The dropped tables and columns held organisation data that is not carried over; recreating
-- them would not restore their contents.

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 018
-- =============================================================================
