-- Make linked external identities tenant-scoped to align with tenant-scoped accounts.
CREATE TABLE linked_identities_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  email_verified INTEGER DEFAULT 0,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at INTEGER,
  raw_claims TEXT,
  profile_data TEXT,
  linked_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, provider_id, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

INSERT INTO linked_identities_new (
  id, tenant_id, user_id, provider_id, provider_user_id,
  provider_email, email_verified,
  access_token_encrypted, refresh_token_encrypted, token_expires_at,
  raw_claims, profile_data,
  linked_at, last_login_at, updated_at
)
SELECT
  id, tenant_id, user_id, provider_id, provider_user_id,
  provider_email, email_verified,
  access_token_encrypted, refresh_token_encrypted, token_expires_at,
  raw_claims, profile_data,
  linked_at, last_login_at, updated_at
FROM linked_identities;

DROP TABLE linked_identities;
ALTER TABLE linked_identities_new RENAME TO linked_identities;

CREATE INDEX IF NOT EXISTS idx_linked_identities_provider ON linked_identities(provider_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_provider_sub
  ON linked_identities(provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_tenant_provider_user
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_user ON linked_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_tenant_user
  ON linked_identities(tenant_id, user_id);
