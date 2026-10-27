-- Business-atomic publication receipts contain no plaintext or encrypted log body.
CREATE TABLE log_iceberg_core_publications (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK(length(record_id)=64),
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','committed','published','aborted')),
  body_prepared INTEGER NOT NULL DEFAULT 0 CHECK(body_prepared IN (0,1)),
  admission_expires_at INTEGER NOT NULL DEFAULT 0 CHECK(admission_expires_at>=0),
  admission_completed_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(state NOT IN ('committed','published') OR (body_prepared=1 AND admission_expires_at>0)),
  CHECK(admission_completed_at IS NULL OR state IN ('published','aborted')),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
) STRICT;
CREATE INDEX idx_log_iceberg_core_publications_pending
  ON log_iceberg_core_publications(tenant_id,state,updated_at,id);
