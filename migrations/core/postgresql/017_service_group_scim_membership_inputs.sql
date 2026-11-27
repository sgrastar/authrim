-- Migration: 017_service_group_scim_membership_inputs.sql
-- Description: The service groups' SCIM link input reads SCIM memberships of SCIM-kind canonical
--              groups instead of user_roles (see the D1 migration of the same name). Only 'scim'
--              membership rows bump the subject's input revision, and only when what makes the
--              membership effective changes (both subjects when a row moves): the evaluation's
--              own 'dynamic' output must not bump its own input. Creating, removing or switching
--              a SCIM group active / inactive bumps the tenant epoch. The epoch of every tenant
--              with a service-group catalog is advanced once, so results computed with the
--              former user_roles input are evaluated again. dynamic_membership_publications:
--              the newest dynamic generation published per subject and its pending cache
--              invalidation (see the D1 migration of the same name).
-- Author: @authrim
-- Date: 2026-11-27

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE dynamic_membership_publications (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  published_at BIGINT NOT NULL,
  invalidation_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, subject_id)
);
CREATE INDEX idx_dynamic_membership_publications_pending
  ON dynamic_membership_publications(tenant_id, invalidation_pending);

CREATE FUNCTION sg_group_memberships_scim_new_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE FUNCTION sg_group_memberships_scim_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 IF OLD.subject_id IS DISTINCT FROM NEW.subject_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
  INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 END IF;
 RETURN NEW; END; $$;
CREATE FUNCTION sg_group_memberships_scim_old_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_group_memberships_scim_insert AFTER INSERT ON group_memberships FOR EACH ROW
 WHEN (NEW.assignment_source = 'scim') EXECUTE FUNCTION sg_group_memberships_scim_new_fn();
CREATE TRIGGER sg_group_memberships_scim_update AFTER UPDATE ON group_memberships FOR EACH ROW
 WHEN ((NEW.assignment_source = 'scim' OR OLD.assignment_source = 'scim') AND (
  NEW.assignment_source IS DISTINCT FROM OLD.assignment_source
  OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state
  OR NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  OR NEW.stale_after IS DISTINCT FROM OLD.stale_after OR NEW.group_id IS DISTINCT FROM OLD.group_id
  OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id))
 EXECUTE FUNCTION sg_group_memberships_scim_update_fn();
CREATE TRIGGER sg_group_memberships_scim_delete AFTER DELETE ON group_memberships FOR EACH ROW
 WHEN (OLD.assignment_source = 'scim') EXECUTE FUNCTION sg_group_memberships_scim_old_fn();

CREATE FUNCTION sg_epoch_scim_groups_new_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;
CREATE FUNCTION sg_epoch_scim_groups_old_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_epoch_scim_groups_insert AFTER INSERT ON "groups" FOR EACH ROW
 WHEN (NEW.kind = 'scim') EXECUTE FUNCTION sg_epoch_scim_groups_new_fn();
CREATE TRIGGER sg_epoch_scim_groups_update AFTER UPDATE ON "groups" FOR EACH ROW
 WHEN ((NEW.kind = 'scim') IS DISTINCT FROM (OLD.kind = 'scim')
  OR (NEW.kind = 'scim' AND (NEW.id <> OLD.id OR NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state)))
 EXECUTE FUNCTION sg_epoch_scim_groups_new_fn();
CREATE TRIGGER sg_epoch_scim_groups_delete AFTER DELETE ON "groups" FOR EACH ROW
 WHEN (OLD.kind = 'scim') EXECUTE FUNCTION sg_epoch_scim_groups_old_fn();

INSERT INTO service_group_epoch(tenant_id, revision)
SELECT tenant_id, 1 FROM service_group_catalog
ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
