-- Per-Worker evidence for candidate signing keys. This table stores only public metadata and
-- redacted error codes; private JWKs and signed test-vector payloads are never persisted.

CREATE TABLE IF NOT EXISTS control_signing_key_verifications (
  environment_id TEXT NOT NULL,
  key_purpose TEXT NOT NULL CHECK (key_purpose IN ('runtime_registry', 'smoke_rpc')),
  key_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('a', 'b')),
  worker_script_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1 CHECK (attempt_count >= 1),
  last_error_code TEXT,
  verified_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, key_purpose, key_id, worker_script_name),
  FOREIGN KEY (environment_id, key_purpose, key_id)
    REFERENCES control_signing_key_metadata(environment_id, key_purpose, key_id)
    ON DELETE CASCADE,
  CHECK ((status = 'succeeded' AND verified_at IS NOT NULL AND last_error_code IS NULL) OR
         (status = 'failed' AND verified_at IS NULL AND last_error_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_control_signing_key_verifications_pending
  ON control_signing_key_verifications(environment_id, key_purpose, key_id, status, updated_at);
