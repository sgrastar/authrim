-- Migration: 013_passkeys_canonical_user_binding
-- Description: Align end-user passkeys with canonical runtime users.
--
-- Runtime users are now stored in the canonical identity graph, not users_core.
-- Passkeys still belong to an Authrim runtime user id, but that id is no longer
-- guaranteed to exist in users_core. Keep deletion explicit in application code.

CREATE TABLE IF NOT EXISTS passkeys_canonical (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  UNIQUE(tenant_id, credential_id)
);

INSERT INTO passkeys_canonical (
  id,
  user_id,
  credential_id,
  public_key,
  counter,
  transports,
  device_name,
  created_at,
  last_used_at,
  tenant_id
)
SELECT
  id,
  user_id,
  credential_id,
  public_key,
  counter,
  transports,
  device_name,
  created_at,
  last_used_at,
  tenant_id
FROM passkeys;

DROP TABLE passkeys;
ALTER TABLE passkeys_canonical RENAME TO passkeys;

CREATE INDEX IF NOT EXISTS idx_passkeys_tenant ON passkeys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkeys(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_passkeys_credential ON passkeys(tenant_id, credential_id);
