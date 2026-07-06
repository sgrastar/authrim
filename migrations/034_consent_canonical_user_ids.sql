-- Allow consent records to use canonical runtime user IDs.
--
-- Runtime users now live in identity_accounts / identity_subjects. The user_id stored in
-- consent tables remains the stable runtime legacy_user_id, but users_core rows may no longer
-- exist. Rebuild the SQLite tables to remove legacy users_core foreign keys while preserving
-- client and consent statement constraints.

PRAGMA foreign_keys = OFF;

CREATE TABLE oauth_client_consents_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  selected_scopes TEXT,
  privacy_policy_version TEXT,
  tos_version TEXT,
  consent_version INTEGER DEFAULT 1,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, client_id)
);

INSERT INTO oauth_client_consents_new (
  id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at, tenant_id,
  selected_scopes, privacy_policy_version, tos_version, consent_version
)
SELECT
  id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at, tenant_id,
  selected_scopes, privacy_policy_version, tos_version, consent_version
FROM oauth_client_consents;

DROP TABLE oauth_client_consents;
ALTER TABLE oauth_client_consents_new RENAME TO oauth_client_consents;

CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id);
CREATE INDEX idx_consents_expires_at_active ON oauth_client_consents(expires_at);
CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id);

CREATE TABLE user_consent_records_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  client_id TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  receipt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id),
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id),
  UNIQUE (tenant_id, user_id, statement_id)
);

INSERT INTO user_consent_records_new (
  id, tenant_id, user_id, statement_id, version_id, version, status, granted_at, withdrawn_at,
  expires_at, client_id, ip_address_hash, user_agent, receipt_id, created_at, updated_at,
  retain_until, consent_settings_snapshot_at, record_retention_days_snapshot,
  reconsent_interval_days_snapshot
)
SELECT
  id, tenant_id, user_id, statement_id, version_id, version, status, granted_at, withdrawn_at,
  expires_at, client_id, ip_address_hash, user_agent, receipt_id, created_at, updated_at,
  retain_until, consent_settings_snapshot_at, record_retention_days_snapshot,
  reconsent_interval_days_snapshot
FROM user_consent_records;

DROP TABLE user_consent_records;
ALTER TABLE user_consent_records_new RENAME TO user_consent_records;

CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at);
CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until);
CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);
CREATE INDEX idx_ucr_status ON user_consent_records(status);
CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id);

CREATE TABLE consent_item_history_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER
);

INSERT INTO consent_item_history_new (
  id, tenant_id, user_id, statement_id, action, version_before, version_after, status_before,
  status_after, ip_address_hash, user_agent, client_id, metadata_json, created_at,
  version_id_before, version_id_after, granted_at, withdrawn_at, expires_at, retain_until,
  consent_settings_snapshot_at, record_retention_days_snapshot, reconsent_interval_days_snapshot
)
SELECT
  id, tenant_id, user_id, statement_id, action, version_before, version_after, status_before,
  status_after, ip_address_hash, user_agent, client_id, metadata_json, created_at,
  version_id_before, version_id_after, granted_at, withdrawn_at, expires_at, retain_until,
  consent_settings_snapshot_at, record_retention_days_snapshot, reconsent_interval_days_snapshot
FROM consent_item_history;

DROP TABLE consent_item_history;
ALTER TABLE consent_item_history_new RENAME TO consent_item_history;

CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until);
CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at);
CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at);
CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at);

PRAGMA foreign_keys = ON;
