-- Authrim 0.5.0 release migration bundle.
-- Generated from unpublished migrations; do not edit after release.

-- =============================================================================
-- Consolidated from 002_guest_account_lifecycle.sql
-- =============================================================================
-- Human guest lifecycle; device and agent identities are not enrolled here.
-- No account FK: the deletion fence must survive physical account removal for retries.
CREATE TABLE guest_account_lifecycle (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'active'
    CHECK (phase IN ('active', 'upgrading', 'registered', 'deleting', 'deleted')),
  created_at BIGINT NOT NULL CHECK (created_at >= 0),
  deletion_due_at BIGINT,
  policy_version TEXT NOT NULL,
  retention_application_id TEXT,
  upgrade_hold_until BIGINT,
  upgrade_operation_id TEXT,
  upgrade_admission_floor BIGINT NOT NULL DEFAULT 0,
  upgraded_at BIGINT,
  upgrade_finalized_at BIGINT,
  deletion_operation_id TEXT,
  deletion_route_json TEXT,
  deletion_started_at_ms BIGINT,
  deleted_at BIGINT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  CHECK (deletion_due_at IS NULL OR deletion_due_at >= created_at),
  CHECK (upgrade_hold_until IS NULL OR upgrade_hold_until >= created_at)
);
CREATE INDEX idx_guest_lifecycle_cleanup
  ON guest_account_lifecycle (tenant_id, phase, deletion_due_at, user_id);
CREATE INDEX idx_guest_lifecycle_created
  ON guest_account_lifecycle (tenant_id, created_at, user_id);

-- =============================================================================
-- Consolidated from 003_account_registration_state.sql
-- =============================================================================
-- Separate registration from account type. No runtime compatibility aliases.
ALTER TABLE identity_accounts ADD COLUMN registration_state TEXT NOT NULL DEFAULT 'registered'
  CHECK (registration_state IN ('guest', 'registered'));
UPDATE identity_accounts SET registration_state = 'guest', account_type = 'user' WHERE account_type = 'anonymous';
CREATE INDEX idx_identity_accounts_registration_state ON identity_accounts (tenant_id, registration_state);
ALTER TABLE anonymous_devices RENAME TO guest_devices;
-- Shared-HMAC device identifiers are not browser resume credentials. The old rows are
-- intentionally discarded because this unpublished migration has no compatibility contract.
TRUNCATE TABLE guest_devices;
ALTER TABLE guest_devices RENAME COLUMN device_id_hash TO resume_credential_hash;
ALTER TABLE guest_devices DROP COLUMN installation_id_hash;
ALTER TABLE guest_devices DROP COLUMN fingerprint_hash;
ALTER TABLE guest_devices DROP COLUMN device_platform;
ALTER TABLE guest_devices DROP COLUMN device_stability;
CREATE TABLE guest_account_upgrades (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  guest_user_id TEXT NOT NULL,
  upgraded_user_id TEXT NOT NULL,
  upgrade_method TEXT NOT NULL,
  provider_id TEXT,
  preserve_sub INTEGER NOT NULL DEFAULT 1 CHECK (preserve_sub = 1),
  upgraded_at BIGINT NOT NULL,
  data_migrated INTEGER NOT NULL DEFAULT 0 CHECK (data_migrated IN (0, 1))
);
CREATE INDEX idx_guest_account_upgrades_user ON guest_account_upgrades (tenant_id, guest_user_id, upgraded_at);
CREATE INDEX idx_guest_account_upgrades_target ON guest_account_upgrades (tenant_id, upgraded_user_id, upgraded_at);

ALTER INDEX idx_anonymous_devices_active_digest RENAME TO idx_guest_devices_active_resume_credential;
ALTER INDEX idx_anonymous_devices_user RENAME TO idx_guest_devices_user;
ALTER INDEX idx_anonymous_devices_expiry RENAME TO idx_guest_devices_expiry;

-- =============================================================================
-- Consolidated from 004_guest_deletion_audit_outbox.sql
-- =============================================================================
-- Durable reconciliation for guest deletion completion audits.
-- No account foreign key: the task must survive account deletion.
CREATE TABLE guest_deletion_audit_outbox (
  audit_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (length(metadata_json) <= 4096),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'succeeded')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at BIGINT NOT NULL,
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  succeeded_at BIGINT,
  UNIQUE (tenant_id, operation_id),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR
         (status <> 'succeeded' AND succeeded_at IS NULL))
);

CREATE INDEX idx_guest_deletion_audit_outbox_due
  ON guest_deletion_audit_outbox (tenant_id, status, next_attempt_at, created_at);

-- =============================================================================
-- Consolidated from 005_account_webhook_outbox.sql
-- =============================================================================
-- Align directory activation with the Core runtime contract without rewriting old releases.
-- Existing PostgreSQL accounts are already established; new accounts await publication.
ALTER TABLE identity_accounts ADD COLUMN IF NOT EXISTS directory_publication_state TEXT NOT NULL DEFAULT 'active'
  CHECK (directory_publication_state IN ('pending', 'active_pending_directory', 'active', 'disabled'));
ALTER TABLE identity_accounts ALTER COLUMN directory_publication_state SET DEFAULT 'pending';
-- Transactional, non-PII account notification outbox. No account FK: deletion must preserve delivery.
CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
);
CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until);

CREATE FUNCTION authrim_account_webhook_created_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.directory_publication_state = 'active'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_created_insert AFTER INSERT ON identity_accounts FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_created_insert();

CREATE FUNCTION authrim_account_webhook_created_activate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.directory_publication_state <> 'active' AND NEW.directory_publication_state = 'active' AND OLD.directory_publication_state <> 'disabled'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_created_activate AFTER UPDATE ON identity_accounts FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_created_activate();

CREATE FUNCTION authrim_account_webhook_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.deleted', a.registration_state, NULL, NULL, __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state = 'deleted' AND OLD.lifecycle_state <> 'deleted'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_deleted AFTER UPDATE ON identity_accounts FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_deleted();

CREATE FUNCTION authrim_account_webhook_registration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.registration.changed', a.registration_state, OLD.registration_state, 'registration_state', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.registration_state <> NEW.registration_state AND (NEW.registration_state = 'guest' OR NOT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id = NEW.tenant_id AND g.user_id = NEW.legacy_user_id AND g.phase <> 'registered'))));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_registration AFTER UPDATE ON identity_accounts FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_registration();

CREATE FUNCTION authrim_account_webhook_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'account', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state NOT IN ('deleted', 'deleting') AND OLD.directory_publication_state = 'active' AND NEW.registration_state = OLD.registration_state AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.display_label IS DISTINCT FROM OLD.display_label OR NEW.metadata_json IS DISTINCT FROM OLD.metadata_json)));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_updated AFTER UPDATE ON identity_accounts FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_updated();

CREATE FUNCTION authrim_account_webhook_guest_committed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.registration.changed', 'registered', 'guest', 'registration_state', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.legacy_user_id = NEW.user_id AND OLD.phase = 'upgrading' AND NEW.phase = 'registered' AND a.registration_state = 'registered');
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_guest_committed AFTER UPDATE ON guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_guest_committed();

CREATE FUNCTION authrim_account_webhook_profiles_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_profiles_insert AFTER INSERT ON profiles FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_profiles_insert();

CREATE FUNCTION authrim_account_webhook_profiles_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_profiles_update AFTER UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_profiles_update();

CREATE FUNCTION authrim_account_webhook_profiles_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.primary_subject_id = OLD.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_profiles_delete AFTER DELETE ON profiles FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_profiles_delete();

CREATE FUNCTION authrim_account_webhook_profile_attribute_values_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_profile_attribute_values_insert AFTER INSERT ON profile_attribute_values FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_profile_attribute_values_insert();

CREATE FUNCTION authrim_account_webhook_profile_attribute_values_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_profile_attribute_values_update AFTER UPDATE ON profile_attribute_values FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_profile_attribute_values_update();

CREATE FUNCTION authrim_account_webhook_profile_attribute_values_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (EXISTS (SELECT 1 FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id AND p.subject_id = a.primary_subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_profile_attribute_values_delete AFTER DELETE ON profile_attribute_values FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_profile_attribute_values_delete();

CREATE FUNCTION authrim_account_webhook_contact_points_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND ((a.id = NEW.account_id OR a.primary_subject_id = NEW.subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_contact_points_insert AFTER INSERT ON contact_points FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_contact_points_insert();

CREATE FUNCTION authrim_account_webhook_contact_points_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND ((a.id = NEW.account_id OR a.primary_subject_id = NEW.subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_contact_points_update AFTER UPDATE ON contact_points FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_contact_points_update();

CREATE FUNCTION authrim_account_webhook_contact_points_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND ((a.id = OLD.account_id OR a.primary_subject_id = OLD.subject_id)) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_contact_points_delete AFTER DELETE ON contact_points FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_contact_points_delete();

CREATE FUNCTION authrim_account_webhook_user_custom_fields_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.legacy_user_id = NEW.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_user_custom_fields_insert AFTER INSERT ON user_custom_fields FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_user_custom_fields_insert();

CREATE FUNCTION authrim_account_webhook_user_custom_fields_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.legacy_user_id = NEW.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_user_custom_fields_update AFTER UPDATE ON user_custom_fields FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_user_custom_fields_update();

CREATE FUNCTION authrim_account_webhook_user_custom_fields_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.legacy_user_id = OLD.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;
CREATE TRIGGER account_webhook_user_custom_fields_delete AFTER DELETE ON user_custom_fields FOR EACH ROW EXECUTE FUNCTION authrim_account_webhook_user_custom_fields_delete();

CREATE FUNCTION account_webhook_guest_retention_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', 'guest', 'account', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.tenant_id = NEW.tenant_id AND a.legacy_user_id = NEW.user_id AND a.account_type = 'user' AND a.registration_state = 'guest' AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleting', 'deleted') AND NEW.phase IN ('active', 'upgrading') AND (NEW.deletion_due_at IS DISTINCT FROM OLD.deletion_due_at OR NEW.upgrade_hold_until IS DISTINCT FROM OLD.upgrade_hold_until OR NEW.policy_version IS DISTINCT FROM OLD.policy_version);
RETURN NEW;
END;
$$;
CREATE TRIGGER account_webhook_guest_retention AFTER UPDATE ON guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION account_webhook_guest_retention_fn();

-- =============================================================================
-- Consolidated from 006_webhook_payload_fields.sql
-- =============================================================================
-- External Core baselines did not previously contain webhook subscription configuration.
CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT 'tenant',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
);
-- Explicit per-destination account data selection. Existing subscriptions retain identifiers only.
ALTER TABLE webhook_configs ADD COLUMN payload_fields TEXT NOT NULL DEFAULT '[]';
ALTER TABLE webhook_configs ADD COLUMN registration_states TEXT NOT NULL DEFAULT '[]';

-- =============================================================================
-- Consolidated from 007_service_dynamic_groups.sql
-- =============================================================================
-- Service membership computation only; no existing authorization data is rewritten.
-- PostgreSQL's baseline lacks the legacy SCIM membership table present in D1.
-- Add the same explicit source without deriving memberships from role_assignments.
CREATE TABLE IF NOT EXISTS user_roles (
 user_id TEXT NOT NULL REFERENCES users_core(id) ON DELETE CASCADE,
 role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
 created_at BIGINT NOT NULL,
 tenant_id TEXT NOT NULL DEFAULT 'default',
 PRIMARY KEY (tenant_id, user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(tenant_id, role_id, created_at);
CREATE TABLE IF NOT EXISTS service_group_inputs (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE service_group_catalog (
 tenant_id TEXT PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 0, plan_json TEXT NOT NULL,
 updated_at BIGINT NOT NULL, write_token TEXT NOT NULL
);
CREATE TABLE service_group_revisions (
 tenant_id TEXT NOT NULL, revision BIGINT NOT NULL, plan_json TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (tenant_id, revision)
);
CREATE TABLE service_group_manual (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
 PRIMARY KEY (tenant_id, user_id, group_id)
);
CREATE TABLE service_group_results (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, generation BIGINT NOT NULL DEFAULT 0,
 rule_version BIGINT NOT NULL DEFAULT 0, core_version BIGINT NOT NULL DEFAULT -1,
 pii_version BIGINT NOT NULL DEFAULT -1, metadata_version BIGINT NOT NULL DEFAULT -1,
 epoch BIGINT NOT NULL DEFAULT -1, result_json TEXT, route_version TEXT NOT NULL DEFAULT '', evaluated_at BIGINT,
 lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
 error_code TEXT, attempts BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE service_group_audit (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 rule_version BIGINT NOT NULL, generation BIGINT NOT NULL,
 event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX idx_service_group_audit_subject ON service_group_audit(tenant_id, user_id, created_at);
CREATE TABLE service_group_epoch (
 tenant_id TEXT PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 1
);
CREATE TABLE service_group_scans (
 tenant_id TEXT NOT NULL, binding_ref TEXT NOT NULL, rule_version BIGINT NOT NULL,
 cursor_id TEXT NOT NULL DEFAULT '', processed BIGINT NOT NULL DEFAULT 0,
 failures BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
 lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
 PRIMARY KEY (tenant_id, binding_ref)
);
CREATE FUNCTION sg_identity_accounts_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_identity_accounts_insert AFTER INSERT ON identity_accounts FOR EACH ROW EXECUTE FUNCTION sg_identity_accounts_insert_fn();
CREATE FUNCTION sg_identity_accounts_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_identity_accounts_update AFTER UPDATE ON identity_accounts FOR EACH ROW EXECUTE FUNCTION sg_identity_accounts_update_fn();
CREATE FUNCTION sg_identity_accounts_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.legacy_user_id, 1 WHERE (OLD.legacy_user_id IS NOT NULL) AND OLD.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_identity_accounts_delete AFTER DELETE ON identity_accounts FOR EACH ROW EXECUTE FUNCTION sg_identity_accounts_delete_fn();
CREATE FUNCTION sg_user_custom_fields_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_user_custom_fields_insert AFTER INSERT ON user_custom_fields FOR EACH ROW EXECUTE FUNCTION sg_user_custom_fields_insert_fn();
CREATE FUNCTION sg_user_custom_fields_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_user_custom_fields_update AFTER UPDATE ON user_custom_fields FOR EACH ROW EXECUTE FUNCTION sg_user_custom_fields_update_fn();
CREATE FUNCTION sg_user_custom_fields_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_user_custom_fields_delete AFTER DELETE ON user_custom_fields FOR EACH ROW EXECUTE FUNCTION sg_user_custom_fields_delete_fn();
CREATE FUNCTION sg_user_roles_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_user_roles_insert AFTER INSERT ON user_roles FOR EACH ROW EXECUTE FUNCTION sg_user_roles_insert_fn();
CREATE FUNCTION sg_user_roles_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_user_roles_update AFTER UPDATE ON user_roles FOR EACH ROW EXECUTE FUNCTION sg_user_roles_update_fn();
CREATE FUNCTION sg_user_roles_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_user_roles_delete AFTER DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION sg_user_roles_delete_fn();
CREATE FUNCTION sg_service_group_manual_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_service_group_manual_insert AFTER INSERT ON service_group_manual FOR EACH ROW EXECUTE FUNCTION sg_service_group_manual_insert_fn();
CREATE FUNCTION sg_service_group_manual_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_service_group_manual_update AFTER UPDATE ON service_group_manual FOR EACH ROW EXECUTE FUNCTION sg_service_group_manual_update_fn();
CREATE FUNCTION sg_service_group_manual_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_service_group_manual_delete AFTER DELETE ON service_group_manual FOR EACH ROW EXECUTE FUNCTION sg_service_group_manual_delete_fn();
CREATE FUNCTION sg_contact_points_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_contact_points_insert AFTER INSERT ON contact_points FOR EACH ROW EXECUTE FUNCTION sg_contact_points_insert_fn();
CREATE FUNCTION sg_contact_points_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_contact_points_update AFTER UPDATE ON contact_points FOR EACH ROW EXECUTE FUNCTION sg_contact_points_update_fn();
CREATE FUNCTION sg_contact_points_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id), 1 WHERE (OLD.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_contact_points_delete AFTER DELETE ON contact_points FOR EACH ROW EXECUTE FUNCTION sg_contact_points_delete_fn();
CREATE FUNCTION sg_epoch_custom_claim_schemas_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_epoch_custom_claim_schemas_insert AFTER INSERT ON custom_claim_schemas FOR EACH ROW EXECUTE FUNCTION sg_epoch_custom_claim_schemas_insert_fn();
CREATE FUNCTION sg_epoch_custom_claim_schemas_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_epoch_custom_claim_schemas_update AFTER UPDATE ON custom_claim_schemas FOR EACH ROW EXECUTE FUNCTION sg_epoch_custom_claim_schemas_update_fn();
CREATE FUNCTION sg_epoch_custom_claim_schemas_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_epoch_custom_claim_schemas_delete AFTER DELETE ON custom_claim_schemas FOR EACH ROW EXECUTE FUNCTION sg_epoch_custom_claim_schemas_delete_fn();
CREATE FUNCTION sg_epoch_roles_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_epoch_roles_insert AFTER INSERT ON roles FOR EACH ROW EXECUTE FUNCTION sg_epoch_roles_insert_fn();
CREATE FUNCTION sg_epoch_roles_update_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_epoch_roles_update AFTER UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION sg_epoch_roles_update_fn();
CREATE FUNCTION sg_epoch_roles_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_epoch_roles_delete AFTER DELETE ON roles FOR EACH ROW EXECUTE FUNCTION sg_epoch_roles_delete_fn();
CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id);
CREATE FUNCTION sg_write_boundary_insert_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN NEW; END; $$;
CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION sg_write_boundary_insert_fn();
CREATE FUNCTION sg_write_boundary_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
 RETURN OLD; END; $$;
CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries FOR EACH ROW EXECUTE FUNCTION sg_write_boundary_delete_fn();

-- =============================================================================
-- Consolidated from 008_assurance_evidence.sql
-- =============================================================================
-- Identity assurance evidence (the IAL a subject was proofed at), as in the D1 core schema.
-- PostgreSQL's baseline lacks the table, so a tenant whose people live in PostgreSQL could not
-- record or read their IAL. Same columns and index as D1; times are epoch milliseconds.
CREATE TABLE IF NOT EXISTS assurance_evidence (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL DEFAULT 'default',
 subject_id TEXT,
 binding_id TEXT,
 evidence_type TEXT NOT NULL,
 issuer_ref TEXT,
 assurance_framework TEXT,
 assurance_level TEXT,
 evidence_hash TEXT,
 evidence_storage_ref TEXT,
 verified_at BIGINT,
 expires_at BIGINT,
 revoked_at BIGINT,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assurance_evidence_subject
 ON assurance_evidence(tenant_id, subject_id, evidence_type, expires_at);

-- =============================================================================
-- Consolidated from 009_assurance_evidence_revoked_by.sql
-- =============================================================================
-- Who revoked a piece of identity assurance evidence, recorded with the revocation, so the audit
-- of a revocation (completed by a retry when it failed) names the one who revoked it.
ALTER TABLE assurance_evidence ADD COLUMN revoked_by TEXT;

-- =============================================================================
-- Consolidated from 010_oauth_client_consent_revocations.sql
-- =============================================================================
-- A user's withdrawals of a client's consent, kept with the user's consents. Every withdrawal
-- increments generation; authorization codes, device and CIBA approvals and refresh-token families
-- record the generation they were granted under and are refused once it has moved on. revoked_at
-- (ms, only ever moving later) refuses what was issued before a withdrawal without recording a
-- generation, and consents a cache still holds from before it.
CREATE TABLE oauth_client_consent_revocations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  revoked_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, user_id, client_id)
);

-- The generation a consent was given under. A consent recorded while a withdrawal moved the
-- generation on (an approval racing the withdrawal) carries an earlier one and counts as absent.
ALTER TABLE oauth_client_consents ADD COLUMN consent_generation BIGINT NOT NULL DEFAULT 0;

-- =============================================================================
-- Consolidated from 011_account_webhook_subject_lookup.sql
-- =============================================================================
-- Account webhook trigger functions on profile and contact changes looked up the changed
-- subject's account without an index on identity_accounts.primary_subject_id, and the profile
-- attribute and contact point forms filtered it through a correlated EXISTS or an OR with the
-- primary key. Same rows, selected through indexed lookups (as the D1 migration of this change).
CREATE INDEX IF NOT EXISTS idx_identity_accounts_primary_subject
  ON identity_accounts(tenant_id, primary_subject_id);

CREATE OR REPLACE FUNCTION authrim_account_webhook_profile_attribute_values_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION authrim_account_webhook_profile_attribute_values_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION authrim_account_webhook_profile_attribute_values_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION authrim_account_webhook_contact_points_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS DISTINCT FROM NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION authrim_account_webhook_contact_points_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS DISTINCT FROM NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION authrim_account_webhook_contact_points_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.id = OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || replace(gen_random_uuid()::text, '-', ''), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = OLD.subject_id AND a.id IS DISTINCT FROM OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
RETURN NULL;
END;
$$;

-- =============================================================================
-- Consolidated from 012_flow_audit_sign_in_attempts.sql
-- =============================================================================
-- Failed sign-in attempts recorded with their Flow interaction, for investigating a sign-in
-- problem without personal data. A record names the method and a reason from a closed vocabulary,
-- never the user: once the account is known it carries the account's subject hash (an HMAC under
-- the investigation keyring). Each record has a random inquiry number, unique in its tenant.
ALTER TABLE flow_audit_events ADD COLUMN method TEXT;
ALTER TABLE flow_audit_events ADD COLUMN reason_code TEXT;
ALTER TABLE flow_audit_events ADD COLUMN subject_hash TEXT;
ALTER TABLE flow_audit_events ADD COLUMN inquiry_number TEXT;
-- An account's recent attempts, newest first.
CREATE INDEX IF NOT EXISTS idx_flow_audit_events_subject
  ON flow_audit_events(tenant_id, subject_hash, created_at)
  WHERE subject_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_audit_events_inquiry
  ON flow_audit_events(tenant_id, inquiry_number)
  WHERE inquiry_number IS NOT NULL;

-- =============================================================================
-- Consolidated from 013_saml_passkey_configuration_and_route_generation.sql
-- =============================================================================
-- Bring the Core PostgreSQL configuration used by SAML and browser passkey sign-in
-- into line with the current Core D1 schema. Integer switches intentionally remain
-- integers because the shared client and origin readers compare them with 1.
CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);
-- The nested CASE makes invalid JSON behave like the D1 partial index: it has no
-- indexed entity ID. A plain jsonb cast in the predicate can fail during index build.
CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id
  ON identity_providers (
    tenant_id,
    provider_type,
    (CASE
      WHEN config_json IS JSON THEN
        CASE
          WHEN jsonb_typeof(config_json::jsonb -> 'entityId') = 'string'
            THEN config_json::jsonb ->> 'entityId'
        END
    END)
  )
  WHERE provider_type IN ('saml_idp', 'saml_sp');

CREATE TABLE oauth_clients (
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  description TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  logo_uri TEXT,
  client_uri TEXT,
  policy_uri TEXT,
  tos_uri TEXT,
  contacts TEXT,
  subject_type TEXT DEFAULT 'public',
  sector_identifier_uri TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'client_secret_basic',
  token_exchange_allowed INTEGER DEFAULT 0,
  allowed_subject_token_clients TEXT,
  allowed_token_exchange_resources TEXT,
  delegation_mode TEXT DEFAULT 'delegation',
  client_credentials_allowed INTEGER DEFAULT 0,
  allowed_scopes TEXT,
  default_scope TEXT,
  default_audience TEXT,
  default_resource TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  is_trusted INTEGER DEFAULT 0,
  skip_consent INTEGER DEFAULT 0,
  allow_claims_without_scope INTEGER DEFAULT 0,
  claims_parameter_policy TEXT,
  asc_enabled INTEGER DEFAULT 1,
  asc_protected_request_required INTEGER DEFAULT 1,
  asc_sao_enabled INTEGER DEFAULT 1,
  asc_transformed_claims_enabled INTEGER DEFAULT 1,
  asc_allowed_transformed_claims TEXT,
  backchannel_token_delivery_mode TEXT,
  backchannel_client_notification_endpoint TEXT,
  backchannel_authentication_request_signing_alg TEXT,
  backchannel_user_code_parameter INTEGER DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  jwks TEXT,
  jwks_uri TEXT,
  userinfo_signed_response_alg TEXT,
  post_logout_redirect_uris TEXT,
  allowed_redirect_origins TEXT,
  backchannel_logout_uri TEXT,
  backchannel_logout_session_required INTEGER DEFAULT 0,
  frontchannel_logout_uri TEXT,
  frontchannel_logout_session_required INTEGER DEFAULT 0,
  logout_webhook_uri TEXT,
  logout_webhook_secret_encrypted TEXT,
  registration_access_token_hash TEXT,
  initiate_login_uri TEXT,
  login_ui_url TEXT,
  id_token_signed_response_alg TEXT,
  request_object_signing_alg TEXT,
  client_secret_hash TEXT,
  software_id TEXT,
  software_version TEXT,
  requestable_scopes TEXT,
  require_pkce INTEGER DEFAULT 0,
  application_type TEXT DEFAULT 'web',
  trust_group TEXT,
  trust_group_id TEXT,
  browser_public_client_mode TEXT,
  browser_refresh_token_policy TEXT NOT NULL DEFAULT 'disabled',
  native_sso_enabled INTEGER,
  native_channel_allowed INTEGER,
  allowed_channels TEXT,
  device_secret_revoke_enabled INTEGER,
  device_secret_revoke_trust_groups TEXT,
  device_secret_introspection_enabled INTEGER,
  device_secret_introspection_trust_groups TEXT,
  identity_mapping TEXT,
  attribute_release_consent TEXT,
  authorization_signed_response_alg TEXT,
  authorization_encrypted_response_alg TEXT,
  authorization_encrypted_response_enc TEXT,
  token_endpoint_auth_signing_alg TEXT,
  agent_access_registration_mode TEXT
    CHECK (agent_access_registration_mode IS NULL OR
      agent_access_registration_mode IN ('restricted_dcr', 'cimd')),
  agent_access_expires_at BIGINT,
  agent_access_last_used_at BIGINT,
  agent_access_registration_slot INTEGER
    CHECK (agent_access_registration_slot IS NULL OR
      (agent_access_registration_slot >= 0 AND agent_access_registration_slot < 20)),
  client_metadata_url TEXT,
  client_metadata_hash TEXT,
  client_metadata_fetched_at BIGINT,
  tls_client_certificate_bound_access_tokens INTEGER NOT NULL DEFAULT 0,
  minimum_ial TEXT CHECK (minimum_ial IS NULL OR minimum_ial IN ('IAL1', 'IAL2', 'IAL3')),
  PRIMARY KEY (tenant_id, client_id)
);

CREATE INDEX idx_oauth_clients_trust_group ON oauth_clients(tenant_id, trust_group);
CREATE INDEX idx_oauth_clients_application_type ON oauth_clients(tenant_id, application_type);
CREATE INDEX idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);
CREATE INDEX idx_oauth_clients_agent_access_lifecycle
  ON oauth_clients(tenant_id, agent_access_registration_mode, agent_access_expires_at);
CREATE UNIQUE INDEX idx_oauth_clients_agent_access_registration_slot
  ON oauth_clients(tenant_id, agent_access_registration_slot)
  WHERE agent_access_registration_mode = 'restricted_dcr'
    AND agent_access_registration_slot IS NOT NULL;

CREATE TABLE web_origin_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  cors_allowed INTEGER NOT NULL DEFAULT 1,
  csp_frame_ancestors TEXT,
  handoff_allowed INTEGER NOT NULL DEFAULT 1,
  iframe_allowed INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id)
    ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, origin)
);

CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);
CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);

-- Existing PostgreSQL accounts cannot be assigned a route generation without
-- trusted source evidence. The importer must provide it for every restored row.
ALTER TABLE identity_accounts
  ADD COLUMN account_route_generation BIGINT
    CHECK (account_route_generation >= 1);

-- =============================================================================
-- Consolidated from 014_saml_replication_account_bookkeeping.sql
-- =============================================================================
-- Preserve ordinary account-creation bookkeeping in SAML/passkey replication.
-- Text JSON preserves the source bytes; checks and relational keys follow Core D1.

CREATE TABLE account_creation_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  allocation_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN (
      'preparing', 'reserved', 'writing', 'directory_pending',
      'succeeded', 'blocked', 'canceled'
    )),
  publication_json TEXT
    CHECK (publication_json IS NULL OR
      ((publication_json IS JSON) AND length(publication_json) <= 16384)),
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, actor_id, idempotency_key),
  UNIQUE (tenant_id, account_id),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE TABLE "account_lifecycle_event_outbox" (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'account.created'),
  event_version BIGINT NOT NULL DEFAULT 1 CHECK (event_version = 1),
  payload_json TEXT NOT NULL CHECK ((payload_json IS JSON) AND length(payload_json) <= 4096),
  plugin_targets_json TEXT
    CHECK (plugin_targets_json IS NULL OR
      ((plugin_targets_json IS JSON) AND length(plugin_targets_json) <= 4096)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at BIGINT,
  next_attempt_at BIGINT,
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  succeeded_at BIGINT,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, operation_id, event_type),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL) OR
         status <> 'retry'),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY,          -- Composite: tenant_id:actor_id:method:path:resource_id:key
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,       -- admin_id who made the request
    method TEXT NOT NULL,         -- HTTP method (POST, PUT, DELETE)
    path TEXT NOT NULL,           -- API path pattern
    resource_id TEXT,             -- Target resource ID (if applicable)
    idempotency_key TEXT NOT NULL,-- The Idempotency-Key header value
    body_hash TEXT NOT NULL,      -- SHA-256 hash of request body
    response_status BIGINT NOT NULL,
    response_body TEXT NOT NULL,  -- Sanitized response (PII removed)
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_creation_operations_status
  ON account_creation_operations(status, updated_at);

CREATE INDEX idx_account_lifecycle_event_outbox_due
  ON account_lifecycle_event_outbox(status, next_attempt_at, created_at, event_id);

CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);

CREATE FUNCTION authrim_account_creation_operation_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'preparing' AND NEW.status IN ('reserved', 'blocked', 'canceled')) OR
    (OLD.status = 'reserved' AND NEW.status IN ('writing', 'blocked', 'canceled')) OR
    (OLD.status = 'writing' AND NEW.status IN ('directory_pending', 'succeeded', 'blocked')) OR
    (OLD.status = 'directory_pending' AND NEW.status IN ('succeeded', 'blocked')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('reserved', 'writing', 'directory_pending', 'canceled'))
  ) THEN RAISE EXCEPTION 'invalid_account_creation_operation_status_transition'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_account_creation_operation_status_transition
  BEFORE UPDATE OF status ON account_creation_operations FOR EACH ROW
  EXECUTE FUNCTION authrim_account_creation_operation_status_transition();

CREATE FUNCTION authrim_account_lifecycle_event_outbox_initial_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 THEN
    RAISE EXCEPTION 'invalid_account_lifecycle_event_initial_state';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_account_lifecycle_event_outbox_initial_state
  BEFORE INSERT ON account_lifecycle_event_outbox FOR EACH ROW
  EXECUTE FUNCTION authrim_account_lifecycle_event_outbox_initial_state();

CREATE FUNCTION authrim_account_lifecycle_event_outbox_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'dead_letter')) OR
    (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'dead_letter')) OR
    (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'dead_letter'))
  ) THEN RAISE EXCEPTION 'invalid_account_lifecycle_event_status_transition'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_account_lifecycle_event_outbox_status_transition
  BEFORE UPDATE OF status ON account_lifecycle_event_outbox FOR EACH ROW
  EXECUTE FUNCTION authrim_account_lifecycle_event_outbox_status_transition();

-- =============================================================================
-- Consolidated from 015_provisioning_revocation_receipts.sql
-- =============================================================================
-- Completion evidence is business state, independent of searchable log retention.
CREATE TABLE provisioning_revocation_receipts (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  subject_id TEXT,
  source_event_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX idx_provisioning_revocation_receipts_account
  ON provisioning_revocation_receipts(tenant_id,account_id,source_event_id,id);

-- =============================================================================
-- Consolidated from 016_log_iceberg_core_publications.sql
-- =============================================================================
-- Business-atomic publication receipts contain no plaintext or encrypted log body.
CREATE TABLE log_iceberg_core_publications (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK(length(record_id)=64),
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','committed','published','aborted')),
  body_prepared INTEGER NOT NULL DEFAULT 0 CHECK(body_prepared IN (0,1)),
  admission_expires_at BIGINT NOT NULL DEFAULT 0 CHECK(admission_expires_at>=0),
  admission_completed_at BIGINT,
  lease_token TEXT,
  lease_until BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK(state NOT IN ('committed','published') OR (body_prepared=1 AND admission_expires_at>0)),
  CHECK(admission_completed_at IS NULL OR state IN ('published','aborted')),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
CREATE INDEX idx_log_iceberg_core_publications_pending
  ON log_iceberg_core_publications(tenant_id,state,updated_at,id);

-- =============================================================================
-- Consolidated from 017_guest_erasure_admission.sql
-- =============================================================================
-- Guest-only source mutation admission; no new timestamp/actor retention policy.
-- Closed PostgreSQL Core profile: passkeys/devices exist; Core TOTP and routing outbox do not.
ALTER TABLE guest_deletion_audit_outbox ADD COLUMN execution_progress_json TEXT
  CHECK (execution_progress_json IS NULL OR octet_length(execution_progress_json)<=16384);

-- Shared locks fence ordinary source writes. Boundary changes update this row,
-- including under repeatable read: a stale snapshot must serialize/retry.
CREATE TABLE guest_core_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK (id=1),
  revision BIGINT NOT NULL CHECK (revision>=0)
);
INSERT INTO guest_core_mutation_epoch(id,revision) VALUES(1,0);

CREATE FUNCTION authrim_guest_erasure_json(value TEXT) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  RETURN COALESCE(value::jsonb,'{}'::jsonb);
EXCEPTION WHEN invalid_text_representation THEN
  RETURN '{}'::jsonb;
END;
$$;

CREATE FUNCTION authrim_guest_core_page_permitted(
  p_tenant TEXT,p_user TEXT,p_table TEXT,p_id TEXT
) RETURNS BOOLEAN LANGUAGE SQL VOLATILE AS $$
  SELECT EXISTS (
    SELECT 1 FROM guest_account_lifecycle g
    JOIN identity_accounts a ON a.tenant_id=g.tenant_id AND a.legacy_user_id=g.user_id
    JOIN guest_deletion_audit_outbox task ON task.tenant_id=g.tenant_id AND task.user_id=g.user_id
      AND task.operation_id=g.deletion_operation_id
    CROSS JOIN LATERAL (SELECT authrim_guest_erasure_json(g.deletion_route_json) AS route,
      authrim_guest_erasure_json(task.execution_progress_json) AS progress) document
    WHERE g.tenant_id=p_tenant AND g.user_id=p_user AND g.phase IN ('deleting','deleted')
      AND task.status IN ('pending','retry')
      AND document.route->'schemaVersion'='2'::jsonb
      AND document.route->>'operationId'=g.deletion_operation_id
      AND document.route->>'tenantId'=g.tenant_id AND document.route->>'userId'=g.user_id
      AND document.route->>'accountId'=a.id
      AND document.route->'accountRouteGeneration'=to_jsonb(a.account_route_generation)
      AND document.route->>'completionAuditId'=task.audit_id
      AND document.route#>>'{execution,phase}'='erasure_started'
      AND EXISTS (SELECT 1 FROM account_legal_hold_states authority
        WHERE authority.tenant_id=a.tenant_id AND authority.account_id=a.id
          AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=a.tenant_id
        AND h.subject_type='account' AND h.subject_id=a.id AND h.state='active')
      AND document.progress->'schemaVersion'='1'::jsonb
      AND jsonb_typeof(document.progress->'revision')='number'
      AND (document.progress->>'revision')::numeric>0
      AND document.progress#>>'{corePermit,table}'=p_table
      AND document.progress->>'stage'=CASE p_table
        WHEN 'passkeys' THEN 'drain_passkeys' WHEN 'guest_devices' THEN 'drain_guest_devices'
        WHEN 'identity_accounts' THEN 'final_core' ELSE NULL END
      AND jsonb_typeof(document.progress#>'{corePermit,ids}')='array'
      AND jsonb_array_length(CASE WHEN jsonb_typeof(document.progress#>'{corePermit,ids}')='array'
        THEN document.progress#>'{corePermit,ids}' ELSE '[]'::jsonb END) BETWEEN 1 AND 16
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(document.progress#>'{corePermit,ids}')='array'
          THEN document.progress#>'{corePermit,ids}' ELSE '[]'::jsonb END) AS key(value)
        WHERE jsonb_typeof(key.value)='string' AND octet_length(key.value#>>'{}') BETWEEN 1 AND 256
          AND key.value#>>'{}'=p_id)
  );
$$;

CREATE FUNCTION authrim_guest_core_source_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  old_row JSONB;
  new_row JSONB;
  user_column TEXT;
  frozen BOOLEAN;
  permitted BOOLEAN;
BEGIN
  user_column:=CASE WHEN TG_TABLE_NAME='identity_accounts' THEN 'legacy_user_id' ELSE 'user_id' END;
  IF TG_OP<>'INSERT' THEN old_row:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN new_row:=to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME='identity_accounts' AND (TG_OP<>'UPDATE' OR
    (new_row-ARRAY['display_label','metadata_json','updated_at']) IS DISTINCT FROM
      (old_row-ARRAY['display_label','metadata_json','updated_at'])) THEN
    -- Owner/status changes invalidate current-source proofs. Ordinary metadata writes
    -- retain shared admission, without serializing all unrelated profile updates.
    UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  ELSE
    PERFORM revision FROM guest_core_mutation_epoch WHERE id=1 FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  SELECT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.phase IN ('deleting','deleted')
    AND ((g.tenant_id=old_row->>'tenant_id' AND g.user_id=old_row->>user_column)
      OR (g.tenant_id=new_row->>'tenant_id' AND g.user_id=new_row->>user_column))) INTO frozen;
  IF frozen THEN
    permitted:=TG_OP<>'INSERT' AND authrim_guest_core_page_permitted(
      old_row->>'tenant_id',old_row->>user_column,TG_TABLE_NAME,old_row->>'id');
    IF TG_OP='UPDATE' THEN
      permitted:=permitted AND new_row->>'id'=old_row->>'id'
        AND new_row->>'tenant_id'=old_row->>'tenant_id'
        AND new_row->>user_column IS NOT DISTINCT FROM old_row->>user_column;
      IF TG_TABLE_NAME='identity_accounts' THEN
        permitted:=permitted
          AND (new_row-ARRAY['display_label','metadata_json','lifecycle_state','deleted_at',
            'updated_at','directory_publication_state'])=
            (old_row-ARRAY['display_label','metadata_json','lifecycle_state','deleted_at',
            'updated_at','directory_publication_state'])
          AND new_row->>'lifecycle_state' IN ('deleting','deleted')
          AND (new_row->>'display_label' IS NULL OR new_row->'display_label'=old_row->'display_label')
          AND (new_row->>'metadata_json' IS NULL OR new_row->'metadata_json'=old_row->'metadata_json');
        -- Allow the exact monotone B transition and its directory-disable effect.
        permitted:=permitted OR (
          (new_row-ARRAY['lifecycle_state','updated_at','deleted_at','directory_publication_state'])=
            (old_row-ARRAY['lifecycle_state','updated_at','deleted_at','directory_publication_state'])
          AND new_row->>'lifecycle_state'='deleting' AND old_row->>'lifecycle_state'<>'deleted'
          AND (new_row->>'directory_publication_state'=old_row->>'directory_publication_state'
            OR new_row->>'directory_publication_state'='disabled')
          AND (old_row->>'deleted_at' IS NULL OR new_row->'deleted_at'=old_row->'deleted_at')
          AND (new_row->>'updated_at')::bigint >= (old_row->>'updated_at')::bigint
          AND EXISTS (SELECT 1 FROM guest_account_lifecycle g
            JOIN guest_deletion_audit_outbox task ON task.tenant_id=g.tenant_id AND task.user_id=g.user_id
              AND task.operation_id=g.deletion_operation_id
            CROSS JOIN LATERAL (SELECT authrim_guest_erasure_json(g.deletion_route_json) AS route) document
            WHERE g.tenant_id=old_row->>'tenant_id' AND g.user_id=old_row->>'legacy_user_id'
              AND g.phase='deleting' AND task.status IN ('pending','retry')
              AND document.route->'schemaVersion'='2'::jsonb
              AND document.route->>'operationId'=g.deletion_operation_id
              AND document.route#>>'{execution,phase}'='erasure_started'
              AND document.route->>'accountId'=old_row->>'id'
              AND document.route->'accountRouteGeneration'=old_row->'account_route_generation'
              AND document.route->>'completionAuditId'=task.audit_id
              AND EXISTS (SELECT 1 FROM account_legal_hold_states authority
                WHERE authority.tenant_id=g.tenant_id AND authority.account_id=old_row->>'id'
                  AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL))
          AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=old_row->>'tenant_id'
            AND h.subject_type='account' AND h.subject_id=old_row->>'id' AND h.state='active')
        );
      END IF;
    END IF;
    IF NOT COALESCE(permitted,FALSE) THEN RAISE EXCEPTION 'guest_erasure_mutation_blocked'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

CREATE TRIGGER trg_guest_core_passkeys BEFORE INSERT OR UPDATE OR DELETE ON passkeys
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_source_guard();
CREATE TRIGGER trg_guest_core_devices BEFORE INSERT OR UPDATE OR DELETE ON guest_devices
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_source_guard();
CREATE TRIGGER trg_guest_core_accounts BEFORE INSERT OR UPDATE OR DELETE ON identity_accounts
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_source_guard();

CREATE FUNCTION authrim_guest_core_boundary_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
DECLARE route JSONB;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.phase IN ('deleting','deleted') THEN
      RAISE EXCEPTION 'guest_erasure_lifecycle_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.phase='deleted' AND NEW.phase<>'deleted')
    OR (OLD.phase='deleting' AND NEW.phase NOT IN ('deleting','deleted'))
    OR (OLD.phase IN ('deleting','deleted') AND (
      NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.deletion_operation_id IS DISTINCT FROM OLD.deletion_operation_id
      OR NEW.deletion_started_at_ms IS DISTINCT FROM OLD.deletion_started_at_ms)))
  THEN RAISE EXCEPTION 'guest_erasure_lifecycle_immutable'; END IF;
  IF TG_OP='UPDATE' AND OLD.phase IN ('deleting','deleted')
    AND NEW.deletion_route_json IS DISTINCT FROM OLD.deletion_route_json AND NOT COALESCE(
      OLD.phase='deleting' AND NEW.phase='deleting'
      AND authrim_guest_erasure_json(OLD.deletion_route_json)#>>'{execution,phase}'='accepted'
      AND authrim_guest_erasure_json(NEW.deletion_route_json)#>>'{execution,phase}'='erasure_started'
      AND (authrim_guest_erasure_json(OLD.deletion_route_json)-'execution')=
        (authrim_guest_erasure_json(NEW.deletion_route_json)-'execution'),FALSE)
  THEN RAISE EXCEPTION 'guest_erasure_lifecycle_immutable'; END IF;
  -- Ordinary enrollment/upgrades do not start a source freeze or upgrade shared locks.
  IF NEW.phase NOT IN ('deleting','deleted') THEN RETURN NEW; END IF;
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  route:=authrim_guest_erasure_json(NEW.deletion_route_json);
  IF NEW.phase IN ('deleting','deleted') AND route#>>'{execution,phase}'='erasure_started'
    AND EXISTS (SELECT 1 FROM legal_holds h JOIN identity_accounts a
      ON a.tenant_id=h.tenant_id AND a.id=h.subject_id
      WHERE a.tenant_id=NEW.tenant_id AND a.legacy_user_id=NEW.user_id
        AND h.subject_type='account' AND h.state='active')
  THEN RAISE EXCEPTION 'guest_erasure_legal_hold_active'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guest_core_boundary BEFORE INSERT OR UPDATE OR DELETE
ON guest_account_lifecycle FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_boundary_guard();

CREATE FUNCTION authrim_guest_core_hold_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  -- Both admission paths write this row before evaluating the opposite boundary.
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  IF NEW.subject_type='account' AND NEW.state='active' AND EXISTS (
    SELECT 1 FROM identity_accounts a JOIN guest_account_lifecycle g
      ON g.tenant_id=a.tenant_id AND g.user_id=a.legacy_user_id
    CROSS JOIN LATERAL (SELECT authrim_guest_erasure_json(g.deletion_route_json) AS route) document
    WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.subject_id
      AND (g.phase='deleted' OR (g.phase='deleting' AND NOT COALESCE(
        document.route->'schemaVersion'='2'::jsonb AND document.route->>'operationId'=g.deletion_operation_id
        AND document.route->>'accountId'=a.id
        AND document.route#>>'{execution,phase}'='accepted',FALSE)))
  ) THEN RAISE EXCEPTION 'guest_erasure_hold_admission_blocked'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guest_core_hold BEFORE INSERT OR UPDATE ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_hold_guard();

CREATE INDEX idx_guest_erasure_passkeys_page ON passkeys(tenant_id,user_id,id);

CREATE INDEX idx_guest_erasure_guest_devices_page ON guest_devices(tenant_id,user_id,id);


-- Reuse the non-PII epoch for the parents trusted by current-owner restore admission.
CREATE FUNCTION authrim_guest_core_parent_epoch_guard() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE AS $$
DECLARE old_row JSONB; new_row JSONB; fields TEXT[];
BEGIN
  IF TG_OP='UPDATE' THEN
    old_row:=to_jsonb(OLD); new_row:=to_jsonb(NEW);
    fields:=CASE WHEN TG_TABLE_NAME='identity_subjects'
      THEN ARRAY['id','tenant_id','subject_type','lifecycle_state','primary_account_id','deleted_at']
      ELSE ARRAY['id','tenant_id','subject_id','profile_type','lifecycle_state','deleted_at'] END;
    IF NOT EXISTS (SELECT 1 FROM unnest(fields) AS field(name)
      WHERE old_row->field.name IS DISTINCT FROM new_row->field.name) THEN RETURN NEW; END IF;
  END IF;
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest_core_admission_unavailable'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER trg_guest_core_subjects BEFORE INSERT OR UPDATE OR DELETE ON identity_subjects
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_parent_epoch_guard();
CREATE TRIGGER trg_guest_core_profiles BEFORE INSERT OR UPDATE OR DELETE ON profiles
FOR EACH ROW EXECUTE FUNCTION authrim_guest_core_parent_epoch_guard();

-- =============================================================================
-- Consolidated from 018_statement_consent_split_foundation.sql
-- =============================================================================
-- Statement consent split foundation (additive; nothing is rebuilt, dropped or rewritten).
-- Same columns as the D1 core stream, plus the two definition tables and the current-version
-- index that the PostgreSQL baseline never had, so statement consent can work on PostgreSQL.
-- There is no foreign key to the client table: clients are not in this database.

ALTER TABLE user_consent_records ADD COLUMN content_hash TEXT;
ALTER TABLE consent_item_history ADD COLUMN content_hash_after TEXT;

ALTER TABLE consent_statements ADD COLUMN definition_generation BIGINT NOT NULL DEFAULT 0
  CHECK (definition_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE consent_statements ADD COLUMN closed_generation BIGINT NOT NULL DEFAULT 0
  CHECK (closed_generation BETWEEN 0 AND 9007199254740991);
ALTER TABLE consent_statements ADD COLUMN retired_at BIGINT;

CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL REFERENCES consent_statements(id) ON DELETE CASCADE,
  is_required BIGINT NOT NULL DEFAULT 0,
  min_version TEXT,
  enforcement TEXT NOT NULL DEFAULT 'block',
  show_deletion_link BIGINT NOT NULL DEFAULT 0,
  deletion_url TEXT,
  conditional_rules_json TEXT,
  display_order BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, statement_id)
);
CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id, id);

CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL REFERENCES consent_statements(id) ON DELETE CASCADE,
  requirement TEXT NOT NULL DEFAULT 'inherit',
  min_version TEXT,
  enforcement TEXT,
  conditional_rules_json TEXT,
  display_order BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, client_id, statement_id)
);
CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);

-- At most one current version per statement (D1 has had this since its baseline).
CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard);
-- Retention and retirement scan a statement's records.
CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);

-- =============================================================================
-- Consolidated from 019_statement_consent_atomic_foundation.sql
-- =============================================================================
-- Statement consent step B: additive tables only. Triggers and D1 FK removal follow in PR7.
-- Guards are rebuilt projections; target restore identity must be rebound before writes.

CREATE TABLE statement_consent_guards (
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'statement')),
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'enforced', 'closed')),
  definition_generation BIGINT NOT NULL DEFAULT 0 CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  closed_generation BIGINT NOT NULL DEFAULT 0 CHECK (closed_generation BETWEEN 0 AND 9007199254740991),
  account_id TEXT NOT NULL DEFAULT '',
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at BIGINT NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  PRIMARY KEY (tenant_id, scope_kind, scope_key),
  CHECK ((scope_kind = 'tenant' AND scope_key = '') OR (scope_kind = 'statement' AND length(scope_key) > 0))
);
CREATE TABLE statement_consent_key_states (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  withdrawal_generation BIGINT NOT NULL CHECK (withdrawal_generation BETWEEN 0 AND 9007199254740991),
  last_operation_id TEXT,
  updated_at BIGINT NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, user_id, statement_id)
);
CREATE TABLE statement_consent_operations (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  actor_type TEXT NOT NULL CHECK (length(actor_type) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('grant', 'deny', 'withdraw')),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  expected_withdrawal_generation BIGINT NOT NULL CHECK (expected_withdrawal_generation BETWEEN 0 AND 9007199254740990),
  expected_definition_generation BIGINT NOT NULL CHECK (expected_definition_generation BETWEEN 0 AND 9007199254740991),
  expected_closed_generation BIGINT NOT NULL CHECK (expected_closed_generation BETWEEN 0 AND 9007199254740991),
  issued_at BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991),
  effect_at BIGINT NOT NULL CHECK (effect_at BETWEEN issued_at AND expires_at),
  definition_json TEXT NOT NULL CHECK (jsonb_typeof(definition_json::jsonb) = 'object'),
  before_json TEXT,
  after_json TEXT NOT NULL CHECK (jsonb_typeof((after_json)::jsonb) = 'object'),
  history_json TEXT CHECK (history_json IS NULL OR (jsonb_typeof((history_json)::jsonb) = 'object')),
  admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
  is_noop INTEGER NOT NULL CHECK (is_noop IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'applied', 'rejected')),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  required_terminal INTEGER NOT NULL DEFAULT 1 CHECK (required_terminal = 1),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (tenant_id, operation_id, is_terminal),
  CHECK ((status = 'executing' AND is_terminal = 0) OR (status IN ('applied', 'rejected') AND is_terminal = 1)),
  CHECK (before_json IS NULL OR (jsonb_typeof((before_json)::jsonb) = 'object')),
  CHECK ((is_noop = 1 AND history_json IS NULL AND before_json IS NOT NULL) OR (is_noop = 0 AND history_json IS NOT NULL)),
  FOREIGN KEY (tenant_id, operation_id, required_terminal)
    REFERENCES statement_consent_operations (tenant_id, operation_id, is_terminal)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX idx_statement_consent_one_executing_key ON statement_consent_operations
  (tenant_id, user_id, statement_id) WHERE is_terminal = 0;
CREATE TABLE statement_consent_admissions (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  statement_id TEXT NOT NULL,
  definition_generation BIGINT NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  issued_at BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991),
  PRIMARY KEY (tenant_id, operation_id)
);

-- Metadata-owned durable projection work, co-committed with the definition generation bump.
CREATE TABLE statement_consent_projection_jobs (
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  definition_generation BIGINT NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  closed_generation BIGINT NOT NULL CHECK (closed_generation BETWEEN 0 AND 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('enforced', 'closed')),
  targets_json TEXT,
  cursor_binding_ref TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, statement_id)
);

-- =============================================================================
-- Consolidated from 020_statement_consent_enforcement.sql
-- =============================================================================
-- Full release update only; PostgreSQL already has no definition foreign keys.
-- Functions and triggers are statically reviewed only in this environment.
CREATE TABLE statement_consent_retention_permits (
  tenant_id TEXT NOT NULL,
  permit_id TEXT NOT NULL,
  row_kind TEXT NOT NULL CHECK (row_kind IN ('record','history')),
  row_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  cutoff_at BIGINT NOT NULL CHECK (cutoff_at BETWEEN 0 AND 9007199254740991),
  legacy_retention_days BIGINT CHECK (legacy_retention_days BETWEEN 0 AND 9007199254740991 / 86400000),
  issued_at BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991),
  PRIMARY KEY (tenant_id,permit_id)
);

CREATE FUNCTION statement_consent_operation_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only terminal evidence may be rebound by the isolated importer transaction.
  IF NEW.is_terminal=1 AND NEW.status IN ('applied','rejected')
    AND NEW.tenant_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'tenant_id')
    AND NEW.account_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'account_id')
    AND NEW.physical_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'physical_id')
    AND NEW.restore_epoch=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'restore_epoch')
    AND NOT EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=NEW.tenant_id AND o.operation_id=NEW.operation_id)
  THEN RETURN NEW; END IF;

  IF NEW.status <> 'executing' OR NEW.is_terminal <> 0 OR EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND (o.operation_id = NEW.operation_id OR (o.user_id = NEW.user_id AND o.statement_id = NEW.statement_id AND o.is_terminal = 0))) OR (NOT ((NEW.after_json::jsonb ->> 'tenant_id') IS NOT DISTINCT FROM NEW.tenant_id) OR NOT ((NEW.after_json::jsonb ->> 'user_id') IS NOT DISTINCT FROM NEW.user_id) OR NOT ((NEW.after_json::jsonb ->> 'statement_id') IS NOT DISTINCT FROM NEW.statement_id)
      OR (NEW.is_noop = 1 AND (NEW.action <> 'grant' OR (NEW.after_json)::jsonb <> (NEW.before_json)::jsonb OR (NEW.after_json::jsonb ->> 'status') <> 'granted'))
      OR (NEW.is_noop = 0 AND ((NEW.history_json::jsonb ->> 'id') <> ('sc_' || NEW.operation_id || ':' || NEW.tenant_id)
        OR NOT ((NEW.history_json::jsonb ->> 'tenant_id') IS NOT DISTINCT FROM NEW.tenant_id)
        OR NOT ((NEW.history_json::jsonb ->> 'user_id') IS NOT DISTINCT FROM NEW.user_id)
        OR NOT ((NEW.history_json::jsonb ->> 'statement_id') IS NOT DISTINCT FROM NEW.statement_id)
        OR NOT ((NEW.history_json::jsonb ->> 'status_before') IS NOT DISTINCT FROM (NEW.before_json::jsonb ->> 'status'))
        OR NOT ((NEW.history_json::jsonb ->> 'status_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'status'))
        OR NOT ((NEW.history_json::jsonb ->> 'version_id_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version_id'))
        OR NOT ((NEW.history_json::jsonb ->> 'version_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version'))
        OR (NEW.action = 'grant' AND ((NEW.after_json::jsonb ->> 'status') <> 'granted' OR (NEW.history_json::jsonb ->> 'action') NOT IN ('granted','version_upgraded')))
        OR (NEW.action = 'withdraw' AND ((NEW.after_json::jsonb ->> 'status') <> 'withdrawn' OR (NEW.history_json::jsonb ->> 'action') <> 'withdrawn'))
        OR (NEW.action = 'deny' AND ((NEW.after_json::jsonb ->> 'status') NOT IN ('denied','withdrawn') OR (NEW.history_json::jsonb ->> 'action') NOT IN ('denied','withdrawn')))))
      OR (NEW.before_json IS NOT NULL AND ((NEW.after_json::jsonb ->> 'id') <> (NEW.before_json::jsonb ->> 'id')
        OR CAST((NEW.after_json::jsonb ->> 'created_at') AS BIGINT) <> CAST((NEW.before_json::jsonb ->> 'created_at') AS BIGINT)
        OR CAST((NEW.after_json::jsonb ->> 'updated_at') AS BIGINT) < CAST((NEW.before_json::jsonb ->> 'updated_at') AS BIGINT))) OR (NEW.is_noop = 0 AND NOT (((NEW.history_json::jsonb ->> 'content_hash_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'content_hash')) AND ((NEW.history_json::jsonb ->> 'version_id_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version_id')) AND ((NEW.history_json::jsonb ->> 'version_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version')) AND ((NEW.history_json::jsonb ->> 'status_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'status')) AND ((NEW.history_json::jsonb ->> 'granted_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'granted_at')) AND ((NEW.history_json::jsonb ->> 'withdrawn_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'withdrawn_at')) AND ((NEW.history_json::jsonb ->> 'expires_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'expires_at')) AND ((NEW.history_json::jsonb ->> 'retain_until') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'retain_until')) AND ((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'consent_settings_snapshot_at')) AND ((NEW.history_json::jsonb ->> 'record_retention_days_snapshot') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'record_retention_days_snapshot')) AND ((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot')))) OR CASE WHEN (jsonb_typeof(NEW.after_json::jsonb -> 'created_at') = 'number' AND ((NEW.after_json::jsonb ->> 'created_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'created_at'))::numeric,1)=0) AND (jsonb_typeof(NEW.after_json::jsonb -> 'updated_at') = 'number' AND ((NEW.after_json::jsonb ->> 'updated_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'updated_at'))::numeric,1)=0) AND (jsonb_typeof(NEW.after_json::jsonb -> 'granted_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'granted_at') = 'number' AND ((NEW.after_json::jsonb ->> 'granted_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'granted_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'withdrawn_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'withdrawn_at') = 'number' AND ((NEW.after_json::jsonb ->> 'withdrawn_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'withdrawn_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'expires_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'expires_at') = 'number' AND ((NEW.after_json::jsonb ->> 'expires_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'expires_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'retain_until') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'retain_until') = 'number' AND ((NEW.after_json::jsonb ->> 'retain_until'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'retain_until'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'consent_settings_snapshot_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'consent_settings_snapshot_at') = 'number' AND ((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'record_retention_days_snapshot') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'record_retention_days_snapshot') = 'number' AND ((NEW.after_json::jsonb ->> 'record_retention_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'record_retention_days_snapshot'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'reconsent_interval_days_snapshot') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'reconsent_interval_days_snapshot') = 'number' AND ((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric,1)=0)) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'granted_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'granted_at') = 'number' AND ((NEW.history_json::jsonb ->> 'granted_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'granted_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'withdrawn_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'withdrawn_at') = 'number' AND ((NEW.history_json::jsonb ->> 'withdrawn_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'withdrawn_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'expires_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'expires_at') = 'number' AND ((NEW.history_json::jsonb ->> 'expires_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'expires_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'retain_until') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'retain_until') = 'number' AND ((NEW.history_json::jsonb ->> 'retain_until'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'retain_until'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'consent_settings_snapshot_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'consent_settings_snapshot_at') = 'number' AND ((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'record_retention_days_snapshot') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'record_retention_days_snapshot') = 'number' AND ((NEW.history_json::jsonb ->> 'record_retention_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'record_retention_days_snapshot'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'reconsent_interval_days_snapshot') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'reconsent_interval_days_snapshot') = 'number' AND ((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'created_at') = 'number' AND ((NEW.history_json::jsonb ->> 'created_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'created_at'))::numeric,1)=0)) THEN 0 ELSE 1 END = 1) OR NEW.admitted <> (CASE WHEN EXISTS (SELECT 1 FROM statement_consent_guards t JOIN statement_consent_guards s ON s.tenant_id = t.tenant_id
      WHERE t.tenant_id = NEW.tenant_id AND t.scope_kind = 'tenant' AND t.scope_key = '' AND t.mode = 'enforced'
        AND s.scope_kind = 'statement' AND s.scope_key = NEW.statement_id AND (s.mode = 'enforced' OR (NEW.action <> 'grant' AND s.mode = 'closed'))
        AND t.account_id = NEW.account_id AND s.account_id = NEW.account_id
        AND t.physical_id = NEW.physical_id AND s.physical_id = NEW.physical_id
        AND t.restore_epoch = NEW.restore_epoch AND s.restore_epoch = NEW.restore_epoch
        AND s.definition_generation = NEW.expected_definition_generation
        AND s.closed_generation = NEW.expected_closed_generation)
      AND EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id
        AND k.statement_id = NEW.statement_id AND k.account_id = NEW.account_id
        AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
        AND k.revision = NEW.expected_revision AND k.withdrawal_generation = NEW.expected_withdrawal_generation)
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN NEW.issued_at AND NEW.expires_at
      AND ((NEW.before_json IS NULL AND NOT EXISTS (SELECT 1 FROM user_consent_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id))
        OR EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id
          AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id
          AND jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = (NEW.before_json)::jsonb)) AND ((NEW.definition_json::jsonb ->> 'tenant_id')=NEW.tenant_id AND (NEW.definition_json::jsonb ->> 'statement_id')=NEW.statement_id AND CAST((NEW.definition_json::jsonb ->> 'definition_generation') AS BIGINT)=NEW.expected_definition_generation AND (NEW.definition_json::jsonb ->> 'version_id')=(NEW.after_json::jsonb ->> 'version_id') AND (NEW.definition_json::jsonb ->> 'version')=(NEW.after_json::jsonb ->> 'version') AND ((NEW.definition_json::jsonb ->> 'content_hash') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'content_hash')) AND (NEW.action<>'grant' OR (CAST((NEW.definition_json::jsonb ->> 'is_active') AS BIGINT)=1 AND (NEW.definition_json::jsonb ->> 'version_status')='active')))
      AND (NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = (NEW.history_json::jsonb ->> 'id'))) THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'statement_consent_operation_insert_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_operation_insert_guard BEFORE INSERT ON statement_consent_operations FOR EACH ROW EXECUTE FUNCTION statement_consent_operation_insert_guard_fn();

CREATE FUNCTION statement_consent_operation_finalize_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'executing' OR NOT (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) OR NOT (NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id) OR NOT (NEW.attempt_id IS NOT DISTINCT FROM OLD.attempt_id) OR NOT (NEW.payload_sha256 IS NOT DISTINCT FROM OLD.payload_sha256) OR NOT (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id) OR NOT (NEW.actor_type IS NOT DISTINCT FROM OLD.actor_type) OR NOT (NEW.action IS NOT DISTINCT FROM OLD.action) OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id) OR NOT (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) OR NOT (NEW.physical_id IS NOT DISTINCT FROM OLD.physical_id) OR NOT (NEW.restore_epoch IS NOT DISTINCT FROM OLD.restore_epoch) OR NOT (NEW.expected_revision IS NOT DISTINCT FROM OLD.expected_revision) OR NOT (NEW.expected_withdrawal_generation IS NOT DISTINCT FROM OLD.expected_withdrawal_generation) OR NOT (NEW.expected_definition_generation IS NOT DISTINCT FROM OLD.expected_definition_generation) OR NOT (NEW.expected_closed_generation IS NOT DISTINCT FROM OLD.expected_closed_generation) OR NOT (NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at) OR NOT (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) OR NOT (NEW.effect_at IS NOT DISTINCT FROM OLD.effect_at) OR NOT (NEW.definition_json IS NOT DISTINCT FROM OLD.definition_json) OR NOT (NEW.before_json IS NOT DISTINCT FROM OLD.before_json) OR NOT (NEW.after_json IS NOT DISTINCT FROM OLD.after_json) OR NOT (NEW.history_json IS NOT DISTINCT FROM OLD.history_json) OR NOT (NEW.admitted IS NOT DISTINCT FROM OLD.admitted) OR NOT (NEW.is_noop IS NOT DISTINCT FROM OLD.is_noop) OR NOT (NEW.required_terminal IS NOT DISTINCT FROM OLD.required_terminal) OR NEW.is_terminal <> 1 OR (NEW.admitted = 0 AND NEW.status <> 'rejected') OR (NEW.admitted = 1 AND (NEW.status <> 'applied' OR NOT (CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN NEW.issued_at AND NEW.expires_at) OR NOT (EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id AND k.statement_id = NEW.statement_id
      AND k.account_id = NEW.account_id AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
      AND k.revision = NEW.expected_revision + CASE WHEN NEW.is_noop = 1 THEN 0 ELSE 1 END
      AND k.withdrawal_generation = NEW.expected_withdrawal_generation + CASE WHEN NEW.is_noop = 0 AND NEW.action IN ('deny', 'withdraw') THEN 1 ELSE 0 END
      AND (NEW.is_noop = 1 OR k.last_operation_id = NEW.operation_id)) AND EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id
      AND r.statement_id = NEW.statement_id AND jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = (NEW.after_json)::jsonb) AND ((NEW.is_noop = 1 AND NEW.before_json = NEW.after_json) OR
      (NEW.is_noop = 0 AND EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = (NEW.history_json::jsonb ->> 'id')
        AND h.tenant_id = NEW.tenant_id AND jsonb_build_object('id', h.id, 'tenant_id', h.tenant_id, 'user_id', h.user_id, 'statement_id', h.statement_id, 'action', h.action, 'version_before', h.version_before, 'version_after', h.version_after, 'status_before', h.status_before, 'status_after', h.status_after, 'client_id', h.client_id, 'created_at', h.created_at, 'version_id_before', h.version_id_before, 'version_id_after', h.version_id_after, 'granted_at', h.granted_at, 'withdrawn_at', h.withdrawn_at, 'expires_at', h.expires_at, 'retain_until', h.retain_until, 'consent_settings_snapshot_at', h.consent_settings_snapshot_at, 'record_retention_days_snapshot', h.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', h.reconsent_interval_days_snapshot, 'content_hash_after', h.content_hash_after) = (NEW.history_json)::jsonb))) AND (NEW.before_json IS NULL OR NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h
      WHERE h.tenant_id = NEW.tenant_id AND h.user_id = NEW.user_id AND h.statement_id = NEW.statement_id
        AND (h.retain_until IS NULL OR h.retain_until < CAST((NEW.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NOT (h.retain_until IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'retain_until') AS BIGINT)) OR NOT (h.consent_settings_snapshot_at IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at') AS BIGINT)) OR NOT (h.record_retention_days_snapshot IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'record_retention_days_snapshot') AS BIGINT)) OR NOT (h.reconsent_interval_days_snapshot IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot') AS BIGINT)))))))) THEN RAISE EXCEPTION 'statement_consent_operation_finalize_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_operation_finalize_guard BEFORE UPDATE ON statement_consent_operations FOR EACH ROW EXECUTE FUNCTION statement_consent_operation_finalize_guard_fn();

CREATE FUNCTION statement_consent_operation_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_terminal = 0 THEN RAISE EXCEPTION 'statement_consent_operation_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_operation_delete_guard BEFORE DELETE ON statement_consent_operations FOR EACH ROW EXECUTE FUNCTION statement_consent_operation_delete_guard_fn();

CREATE FUNCTION statement_consent_user_consent_records_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = (o.after_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_insert_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_user_consent_records_insert_guard BEFORE INSERT ON user_consent_records FOR EACH ROW EXECUTE FUNCTION statement_consent_user_consent_records_insert_guard_fn();

CREATE FUNCTION statement_consent_user_consent_records_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = (o.after_json)::jsonb) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id AND o.status = 'executing' AND jsonb_build_object('id', OLD.id, 'tenant_id', OLD.tenant_id, 'user_id', OLD.user_id, 'statement_id', OLD.statement_id, 'version_id', OLD.version_id, 'version', OLD.version, 'status', OLD.status, 'granted_at', OLD.granted_at, 'withdrawn_at', OLD.withdrawn_at, 'expires_at', OLD.expires_at, 'client_id', OLD.client_id, 'receipt_id', OLD.receipt_id, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'retain_until', OLD.retain_until, 'consent_settings_snapshot_at', OLD.consent_settings_snapshot_at, 'record_retention_days_snapshot', OLD.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', OLD.reconsent_interval_days_snapshot, 'content_hash', OLD.content_hash) = (o.before_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_update_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_user_consent_records_update_guard BEFORE UPDATE ON user_consent_records FOR EACH ROW EXECUTE FUNCTION statement_consent_user_consent_records_update_guard_fn();

CREATE FUNCTION statement_consent_user_consent_records_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='record' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)
      AND OLD.status IN ('withdrawn','denied','expired')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.updated_at<p.cutoff_at-p.legacy_retention_days*86400000)))) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_user_consent_records_delete_guard BEFORE DELETE ON user_consent_records FOR EACH ROW EXECUTE FUNCTION statement_consent_user_consent_records_delete_guard_fn();

CREATE FUNCTION statement_consent_consent_item_history_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'action', NEW.action, 'version_before', NEW.version_before, 'version_after', NEW.version_after, 'status_before', NEW.status_before, 'status_after', NEW.status_after, 'client_id', NEW.client_id, 'created_at', NEW.created_at, 'version_id_before', NEW.version_id_before, 'version_id_after', NEW.version_id_after, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash_after', NEW.content_hash_after) = (o.history_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_insert_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_consent_item_history_insert_guard BEFORE INSERT ON consent_item_history FOR EACH ROW EXECUTE FUNCTION statement_consent_consent_item_history_insert_guard_fn();

CREATE FUNCTION statement_consent_consent_item_history_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (((NEW.id IS NOT DISTINCT FROM OLD.id) AND (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) AND (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) AND (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) AND (NEW.action IS NOT DISTINCT FROM OLD.action) AND (NEW.version_before IS NOT DISTINCT FROM OLD.version_before) AND (NEW.version_after IS NOT DISTINCT FROM OLD.version_after) AND (NEW.status_before IS NOT DISTINCT FROM OLD.status_before) AND (NEW.status_after IS NOT DISTINCT FROM OLD.status_after) AND (NEW.client_id IS NOT DISTINCT FROM OLD.client_id) AND (NEW.created_at IS NOT DISTINCT FROM OLD.created_at) AND (NEW.version_id_before IS NOT DISTINCT FROM OLD.version_id_before) AND (NEW.version_id_after IS NOT DISTINCT FROM OLD.version_id_after) AND (NEW.granted_at IS NOT DISTINCT FROM OLD.granted_at) AND (NEW.withdrawn_at IS NOT DISTINCT FROM OLD.withdrawn_at) AND (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) AND (NEW.ip_address_hash IS NOT DISTINCT FROM OLD.ip_address_hash) AND (NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent) AND (NEW.content_hash_after IS NOT DISTINCT FROM OLD.content_hash_after) AND (NEW.metadata_json IS NOT DISTINCT FROM OLD.metadata_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
                  AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.before_json IS NOT NULL AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
                  AND (OLD.retain_until IS NULL OR OLD.retain_until < CAST((o.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NEW.retain_until IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NEW.consent_settings_snapshot_at IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'consent_settings_snapshot_at') AS BIGINT)) AND (NEW.record_retention_days_snapshot IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'record_retention_days_snapshot') AS BIGINT)) AND (NEW.reconsent_interval_days_snapshot IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'reconsent_interval_days_snapshot') AS BIGINT)))) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_update_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_consent_item_history_update_guard BEFORE UPDATE ON consent_item_history FOR EACH ROW EXECUTE FUNCTION statement_consent_consent_item_history_update_guard_fn();

CREATE FUNCTION statement_consent_consent_item_history_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='history' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)
      AND NOT EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id=OLD.tenant_id AND r.user_id=OLD.user_id AND r.statement_id=OLD.statement_id AND r.status='granted')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.created_at<p.cutoff_at-p.legacy_retention_days*86400000)))) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_consent_item_history_delete_guard BEFORE DELETE ON consent_item_history FOR EACH ROW EXECUTE FUNCTION statement_consent_consent_item_history_delete_guard_fn();

CREATE FUNCTION statement_consent_key_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) OR NOT (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id) OR NOT (NEW.physical_id IS NOT DISTINCT FROM OLD.physical_id) OR NOT (NEW.restore_epoch IS NOT DISTINCT FROM OLD.restore_epoch) OR NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
      AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.account_id = OLD.account_id AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
      AND OLD.revision = o.expected_revision AND OLD.withdrawal_generation = o.expected_withdrawal_generation
      AND NEW.revision = OLD.revision + 1 AND NEW.withdrawal_generation = OLD.withdrawal_generation + CASE WHEN o.action IN ('deny','withdraw') THEN 1 ELSE 0 END
      AND NEW.last_operation_id = o.operation_id AND NEW.updated_at >= OLD.updated_at)) THEN RAISE EXCEPTION 'statement_consent_key_update_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_key_update_guard BEFORE UPDATE ON statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION statement_consent_key_update_guard_fn();

CREATE FUNCTION statement_consent_key_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled') THEN RAISE EXCEPTION 'statement_consent_key_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_key_delete_guard BEFORE DELETE ON statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION statement_consent_key_delete_guard_fn();

CREATE FUNCTION statement_consent_guards_replace_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_guards r WHERE r.tenant_id = NEW.tenant_id AND r.scope_kind = NEW.scope_kind AND r.scope_key = NEW.scope_key) THEN RAISE EXCEPTION 'statement_consent_guards_replace_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_guards_replace_guard BEFORE INSERT ON statement_consent_guards FOR EACH ROW EXECUTE FUNCTION statement_consent_guards_replace_guard_fn();

CREATE FUNCTION statement_consent_key_states_replace_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_key_states r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id) THEN RAISE EXCEPTION 'statement_consent_key_states_replace_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_key_states_replace_guard BEFORE INSERT ON statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION statement_consent_key_states_replace_guard_fn();

CREATE FUNCTION statement_consent_admissions_replace_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_admissions r WHERE r.tenant_id = NEW.tenant_id AND r.operation_id = NEW.operation_id) THEN RAISE EXCEPTION 'statement_consent_admissions_replace_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_admissions_replace_guard BEFORE INSERT ON statement_consent_admissions FOR EACH ROW EXECUTE FUNCTION statement_consent_admissions_replace_guard_fn();

CREATE FUNCTION statement_consent_guard_monotonic_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_key <> OLD.scope_key OR NEW.definition_generation < OLD.definition_generation OR NEW.closed_generation < OLD.closed_generation OR NEW.account_id <> OLD.account_id OR NEW.physical_id <> OLD.physical_id OR NEW.restore_epoch <> OLD.restore_epoch OR NEW.updated_at < OLD.updated_at OR (OLD.mode = 'closed' AND NEW.mode <> 'closed' AND NOT (OLD.scope_kind = 'statement' AND NEW.mode = 'enforced' AND NEW.definition_generation > OLD.definition_generation)) OR (OLD.mode = 'enforced' AND NEW.mode = 'disabled') THEN RAISE EXCEPTION 'statement_consent_guard_monotonic'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_guard_monotonic BEFORE UPDATE ON statement_consent_guards FOR EACH ROW EXECUTE FUNCTION statement_consent_guard_monotonic_fn();

CREATE FUNCTION statement_consent_guard_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.mode <> 'disabled' THEN RAISE EXCEPTION 'statement_consent_guard_delete'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_guard_delete BEFORE DELETE ON statement_consent_guards FOR EACH ROW EXECUTE FUNCTION statement_consent_guard_delete_fn();

CREATE FUNCTION statement_consent_admission_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TRUE THEN RAISE EXCEPTION 'statement_consent_admission_immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_admission_immutable BEFORE UPDATE ON statement_consent_admissions FOR EACH ROW EXECUTE FUNCTION statement_consent_admission_immutable_fn();

CREATE FUNCTION statement_consent_retention_permit_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'statement_consent_retention_permit_immutable'; END;
$$;
CREATE TRIGGER statement_consent_retention_permit_immutable BEFORE UPDATE ON statement_consent_retention_permits FOR EACH ROW EXECUTE FUNCTION statement_consent_retention_permit_immutable_fn();
