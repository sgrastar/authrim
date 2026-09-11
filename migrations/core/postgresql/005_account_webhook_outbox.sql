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
