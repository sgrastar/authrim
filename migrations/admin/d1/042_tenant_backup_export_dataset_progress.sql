-- Checkpointed v2 exports span many invocations. Stats of finished non-empty datasets wait here
-- until the authenticated metadata frame is written; empty datasets are derived, not stored.
-- The digest is sealed with a key derived from the backup key: a bare SHA-256 of a small
-- dataset could confirm guessed plaintext.
CREATE TABLE tenant_backup_export_datasets (
  attempt_id TEXT NOT NULL REFERENCES tenant_backup_artifact_attempts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<=65535),
  dataset_id TEXT NOT NULL CHECK(length(dataset_id) BETWEEN 1 AND 256),
  row_count INTEGER NOT NULL CHECK(row_count>0),
  byte_count INTEGER NOT NULL CHECK(byte_count>0),
  byte_offset INTEGER NOT NULL CHECK(byte_offset>=0),
  sealed_sha256 TEXT NOT NULL CHECK(length(sealed_sha256) BETWEEN 56 AND 512
    AND length(sealed_sha256)%2=0 AND sealed_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(attempt_id,ordinal)
);
CREATE TRIGGER tenant_backup_export_dataset_immutable
BEFORE UPDATE ON tenant_backup_export_datasets
BEGIN SELECT RAISE(ABORT,'backup_export_dataset_immutable'); END;
