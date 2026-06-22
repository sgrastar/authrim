-- Persist consent audit snapshot deadlines at the time of each user decision.

ALTER TABLE user_consent_records ADD COLUMN retain_until INTEGER;
ALTER TABLE user_consent_records ADD COLUMN consent_settings_snapshot_at INTEGER;
ALTER TABLE user_consent_records ADD COLUMN record_retention_days_snapshot INTEGER;
ALTER TABLE user_consent_records ADD COLUMN reconsent_interval_days_snapshot INTEGER;

ALTER TABLE consent_item_history ADD COLUMN version_id_before TEXT;
ALTER TABLE consent_item_history ADD COLUMN version_id_after TEXT;
ALTER TABLE consent_item_history ADD COLUMN granted_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN expires_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN retain_until INTEGER;
ALTER TABLE consent_item_history ADD COLUMN consent_settings_snapshot_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN record_retention_days_snapshot INTEGER;
ALTER TABLE consent_item_history ADD COLUMN reconsent_interval_days_snapshot INTEGER;

CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until);
CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until);
