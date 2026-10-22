-- Account webhook triggers on profile and contact changes looked up the changed subject's
-- account without an index on identity_accounts.primary_subject_id, and the profile attribute
-- and contact point forms could not use one at all (a correlated EXISTS, an OR with the primary
-- key). Each firing read every active account of the tenant, so creating a user read the tenant's
-- accounts several times over. The same rows are selected now through indexed lookups.
CREATE INDEX IF NOT EXISTS idx_identity_accounts_primary_subject
  ON identity_accounts(tenant_id, primary_subject_id);

DROP TRIGGER IF EXISTS account_webhook_profile_attribute_values_insert;
CREATE TRIGGER account_webhook_profile_attribute_values_insert AFTER INSERT ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

DROP TRIGGER IF EXISTS account_webhook_profile_attribute_values_update;
CREATE TRIGGER account_webhook_profile_attribute_values_update AFTER UPDATE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

DROP TRIGGER IF EXISTS account_webhook_profile_attribute_values_delete;
CREATE TRIGGER account_webhook_profile_attribute_values_delete AFTER DELETE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

DROP TRIGGER IF EXISTS account_webhook_contact_points_insert;
CREATE TRIGGER account_webhook_contact_points_insert AFTER INSERT ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS NOT NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

DROP TRIGGER IF EXISTS account_webhook_contact_points_update;
CREATE TRIGGER account_webhook_contact_points_update AFTER UPDATE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS NOT NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;

DROP TRIGGER IF EXISTS account_webhook_contact_points_delete;
CREATE TRIGGER account_webhook_contact_points_delete AFTER DELETE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.id = OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = OLD.subject_id AND a.id IS NOT OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
