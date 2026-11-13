-- The portal's own registry of the tenants it created. Timestamps are epoch seconds.
-- Only hashes are stored: the SHA-256 of the visitor's ticket and the HMAC of the visitor's IP.
CREATE TABLE IF NOT EXISTS demo_tenants (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('provisioning', 'inviting', 'handed_off', 'failed', 'deleting', 'deleted')
  ),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_demo_tenants_ip_created ON demo_tenants (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_demo_tenants_state_expires ON demo_tenants (state, expires_at);
