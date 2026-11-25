-- Wallet provider device registry (design section 6). One row per App Attest key.
CREATE TABLE devices (
  key_id TEXT PRIMARY KEY,
  public_key_jwk TEXT NOT NULL,
  counter INTEGER NOT NULL,
  environment TEXT NOT NULL,
  validation_category INTEGER,
  bundle_version TEXT,
  app_id_hash TEXT NOT NULL,
  attestation_sha256 TEXT NOT NULL,
  challenge_sha256 TEXT NOT NULL,
  receipt TEXT NOT NULL,
  last_bundle_version TEXT,
  last_validation_category INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT
);

-- A challenge can be claimed by one registration only (atomic with the insert).
CREATE UNIQUE INDEX devices_challenge_sha256 ON devices (challenge_sha256);
CREATE INDEX devices_created_at ON devices (created_at);
