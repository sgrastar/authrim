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
