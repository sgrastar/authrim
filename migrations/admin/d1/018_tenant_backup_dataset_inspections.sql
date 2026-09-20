CREATE TABLE tenant_backup_dataset_inspections (
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_sha256 TEXT NOT NULL CHECK(length(policy_sha256)=64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_count INTEGER NOT NULL CHECK(record_count>=0),
  PRIMARY KEY(session_id,bundle_id,dataset_id),
  FOREIGN KEY(session_id,tenant_id) REFERENCES tenant_backup_validation_sessions(id,tenant_id) ON DELETE CASCADE
);
CREATE TRIGGER tenant_backup_dataset_inspection_immutable
BEFORE UPDATE ON tenant_backup_dataset_inspections
BEGIN SELECT RAISE(ABORT,'backup_dataset_inspection_immutable'); END;
