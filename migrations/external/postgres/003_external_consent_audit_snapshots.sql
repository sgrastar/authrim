-- Persist consent audit snapshot deadlines for external durable core storage.

ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS retain_until BIGINT;
ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS consent_settings_snapshot_at BIGINT;
ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS record_retention_days_snapshot BIGINT;
ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS reconsent_interval_days_snapshot BIGINT;

CREATE INDEX IF NOT EXISTS idx_user_consent_records_retain_until
  ON user_consent_records(retain_until);

CREATE TABLE IF NOT EXISTS consent_item_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  granted_at BIGINT,
  withdrawn_at BIGINT,
  expires_at BIGINT,
  retain_until BIGINT,
  consent_settings_snapshot_at BIGINT,
  record_retention_days_snapshot BIGINT,
  reconsent_interval_days_snapshot BIGINT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL
);

ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS version_id_before TEXT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS version_id_after TEXT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS granted_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS withdrawn_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS retain_until BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS consent_settings_snapshot_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS record_retention_days_snapshot BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS reconsent_interval_days_snapshot BIGINT;

CREATE INDEX IF NOT EXISTS idx_consent_item_history_user
  ON consent_item_history(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_statement
  ON consent_item_history(statement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_retain_until
  ON consent_item_history(retain_until);
