-- Consent records are stored with account-scoped user data, while OAuth client
-- metadata is stored in the tenant metadata database.  A SQLite foreign key from
-- oauth_client_consents to oauth_clients therefore points at a table that is not
-- present in account-core databases and makes an otherwise valid consent insert
-- fail.  Client existence and tenant ownership are validated by the authorization
-- flow before this write; the cross-database relationship must not be represented
-- as a local SQLite foreign key.

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
