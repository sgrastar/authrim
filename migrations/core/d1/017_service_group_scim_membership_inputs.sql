-- Migration: 017_service_group_scim_membership_inputs.sql
-- Description: The service groups' SCIM link input now reads SCIM memberships of SCIM-kind
--              canonical groups (group_memberships rows with assignment_source 'scim', on the
--              subject's account database; groups of kind 'scim', in the tenant metadata
--              database) instead of user_roles, which SCIM no longer writes. These triggers keep
--              that input versioned, as the user_roles / roles triggers did: a change to what
--              makes a SCIM membership effective bumps the subject's input revision (both
--              subjects when a row moves to another subject), and a SCIM group created, removed,
--              or switched active / inactive bumps the tenant epoch. Only 'scim' rows count: the
--              evaluation publishes its own output as 'dynamic' rows, which must not bump its own
--              input (nor do manual, rule or invitation rows, which are not an input of the
--              service groups).
--              Results computed with the former user_roles input must not stay fresh: the epoch
--              of every tenant with a service-group catalog is advanced once, so the scheduler
--              evaluates its subjects again.
--              dynamic_membership_publications (on each account database, next to the
--              subject's group_memberships): the newest dynamic generation published for the
--              subject (its source_ref, zero-padded so text order is generation order), written in
--              the same batch as the membership rows, so a publication of an older generation is
--              refused also after an empty one or after a group's rows were deleted; and whether
--              the subject's cached claims still have to be invalidated for it.
-- Author: @authrim
-- Date: 2026-11-27

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE dynamic_membership_publications (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  invalidation_pending INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, subject_id)
);
CREATE INDEX idx_dynamic_membership_publications_pending
  ON dynamic_membership_publications(tenant_id, invalidation_pending);

CREATE TRIGGER sg_group_memberships_scim_insert AFTER INSERT ON group_memberships
WHEN NEW.assignment_source = 'scim' BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_group_memberships_scim_update AFTER UPDATE ON group_memberships
WHEN (NEW.assignment_source = 'scim' OR OLD.assignment_source = 'scim') AND (
  NEW.assignment_source IS NOT OLD.assignment_source OR NEW.lifecycle_state IS NOT OLD.lifecycle_state
  OR NEW.starts_at IS NOT OLD.starts_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.stale_after IS NOT OLD.stale_after OR NEW.group_id IS NOT OLD.group_id
  OR NEW.subject_id IS NOT OLD.subject_id OR NEW.tenant_id IS NOT OLD.tenant_id) BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.subject_id, 1 WHERE OLD.subject_id IS NOT NEW.subject_id OR OLD.tenant_id IS NOT NEW.tenant_id ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_group_memberships_scim_delete AFTER DELETE ON group_memberships
WHEN OLD.assignment_source = 'scim' BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.subject_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_epoch_scim_groups_insert AFTER INSERT ON "groups"
WHEN NEW.kind = 'scim' BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_scim_groups_update AFTER UPDATE ON "groups"
WHEN (NEW.kind = 'scim') <> (OLD.kind = 'scim')
  OR (NEW.kind = 'scim' AND (NEW.id <> OLD.id OR NEW.lifecycle_state IS NOT OLD.lifecycle_state)) BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_scim_groups_delete AFTER DELETE ON "groups"
WHEN OLD.kind = 'scim' BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;

INSERT INTO service_group_epoch(tenant_id, revision)
SELECT tenant_id, 1 FROM service_group_catalog WHERE 1 = 1
ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
