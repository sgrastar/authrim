-- Make PII linked identities tenant-scoped.
CREATE TABLE linked_identities_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_name TEXT,
  raw_attributes TEXT,
  linked_at INTEGER NOT NULL,
  last_used_at INTEGER
);

INSERT INTO linked_identities_new (
  id, tenant_id, user_id, provider_id, provider_user_id,
  provider_email, provider_name, raw_attributes, linked_at, last_used_at
)
SELECT
  id, 'default', user_id, provider_id, provider_user_id,
  provider_email, provider_name, raw_attributes, linked_at, last_used_at
FROM linked_identities;

DROP TABLE linked_identities;
ALTER TABLE linked_identities_new RENAME TO linked_identities;

CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_ids_provider
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_user ON linked_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_tenant_user
  ON linked_identities(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_provider_sub
  ON linked_identities(provider_id, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_linked_ids_email ON linked_identities(provider_email);
