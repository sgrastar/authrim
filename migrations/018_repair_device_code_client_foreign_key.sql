-- =============================================================================
-- Authrim Core Migration 018: Repair Device Code Client Foreign Key
-- =============================================================================
-- device_codes was created with a reference to the removed legacy clients
-- table. Runtime clients are tenant-scoped rows in oauth_clients, so rebuild
-- the table with the matching composite foreign key. Device codes without a
-- current client cannot be redeemed and are intentionally not carried over.

CREATE TABLE device_codes_repaired (
  device_code TEXT PRIMARY KEY,
  user_code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  user_id TEXT,
  sub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (tenant_id, client_id)
    REFERENCES oauth_clients(tenant_id, client_id)
    ON DELETE CASCADE
);

INSERT INTO device_codes_repaired (
  device_code,
  user_code,
  client_id,
  scope,
  status,
  user_id,
  sub,
  created_at,
  expires_at,
  last_poll_at,
  token_issued,
  token_issued_at,
  poll_count,
  tenant_id
)
SELECT
  dc.device_code,
  dc.user_code,
  dc.client_id,
  dc.scope,
  dc.status,
  dc.user_id,
  dc.sub,
  dc.created_at,
  dc.expires_at,
  dc.last_poll_at,
  dc.token_issued,
  dc.token_issued_at,
  dc.poll_count,
  dc.tenant_id
FROM device_codes AS dc
WHERE EXISTS (
  SELECT 1
  FROM oauth_clients AS client
  WHERE client.tenant_id = dc.tenant_id
    AND client.client_id = dc.client_id
);

DROP TABLE device_codes;
ALTER TABLE device_codes_repaired RENAME TO device_codes;

CREATE INDEX idx_device_codes_client_id ON device_codes(tenant_id, client_id);
CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);
CREATE INDEX idx_device_codes_status ON device_codes(tenant_id, status);
CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);
