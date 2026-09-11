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
