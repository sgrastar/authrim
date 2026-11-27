-- Migration: 018_remove_organizations.sql
-- Description: Organisations are removed; groups replace them (see the D1 migration of the same
--              name; no backward compatibility, no data conversion). The PostgreSQL core schema
--              never had organizations, subject_org_membership or org_domain_mappings (dropped
--              here only if present). Dropped: user_roles with its sg_user_roles_* triggers and
--              functions, service_group_manual with its sg_service_group_manual_* triggers and
--              functions, roles.parent_role_id (and its self-referencing foreign key
--              roles_parent_fk), roles.hierarchy_level, roles.external_id and
--              tenant_invitations.org_id. The input triggers of migration 017 also count
--              'manual' memberships. Holds no personal data.
-- Author: @authrim
-- Date: 2026-11-27

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

DROP TABLE IF EXISTS user_roles;
DROP FUNCTION IF EXISTS sg_user_roles_insert_fn();
DROP FUNCTION IF EXISTS sg_user_roles_update_fn();
DROP FUNCTION IF EXISTS sg_user_roles_delete_fn();

DROP TABLE IF EXISTS service_group_manual;
DROP FUNCTION IF EXISTS sg_service_group_manual_insert_fn();
DROP FUNCTION IF EXISTS sg_service_group_manual_update_fn();
DROP FUNCTION IF EXISTS sg_service_group_manual_delete_fn();

DROP TABLE IF EXISTS org_domain_mappings;
DROP TABLE IF EXISTS subject_org_membership;
DROP TABLE IF EXISTS organizations;

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_parent_fk;
ALTER TABLE roles DROP COLUMN IF EXISTS parent_role_id;
ALTER TABLE roles DROP COLUMN IF EXISTS hierarchy_level;
ALTER TABLE roles DROP COLUMN IF EXISTS external_id;

ALTER TABLE IF EXISTS tenant_invitations DROP COLUMN IF EXISTS org_id;

-- Manual memberships are a service group input again (read from group_memberships): the input
-- triggers of migration 017 also count 'manual' rows (same names and functions). The epoch of
-- every tenant with a service-group catalog is advanced once (see the D1 migration).
DROP TRIGGER IF EXISTS sg_group_memberships_scim_insert ON group_memberships;
DROP TRIGGER IF EXISTS sg_group_memberships_scim_update ON group_memberships;
DROP TRIGGER IF EXISTS sg_group_memberships_scim_delete ON group_memberships;
CREATE TRIGGER sg_group_memberships_scim_insert AFTER INSERT ON group_memberships FOR EACH ROW
 WHEN (NEW.assignment_source IN ('scim', 'manual'))
 EXECUTE FUNCTION sg_group_memberships_scim_new_fn();
CREATE TRIGGER sg_group_memberships_scim_update AFTER UPDATE ON group_memberships FOR EACH ROW
 WHEN ((NEW.assignment_source IN ('scim', 'manual') OR OLD.assignment_source IN ('scim', 'manual')) AND (
  NEW.assignment_source IS DISTINCT FROM OLD.assignment_source
  OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
  OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  OR NEW.stale_after IS DISTINCT FROM OLD.stale_after OR NEW.group_id IS DISTINCT FROM OLD.group_id
  OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id))
 EXECUTE FUNCTION sg_group_memberships_scim_update_fn();
CREATE TRIGGER sg_group_memberships_scim_delete AFTER DELETE ON group_memberships FOR EACH ROW
 WHEN (OLD.assignment_source IN ('scim', 'manual'))
 EXECUTE FUNCTION sg_group_memberships_scim_old_fn();

INSERT INTO service_group_epoch(tenant_id, revision)
SELECT tenant_id, 1 FROM service_group_catalog
ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 018
-- =============================================================================
