-- Stable input positions distinguish an uncertain-write retry from a duplicate imported identity.
ALTER TABLE tenant_backup_validation_records ADD COLUMN source_id TEXT
  CHECK(source_id IS NULL OR (length(source_id)>0 AND length(source_id)<=128));
CREATE UNIQUE INDEX idx_tenant_backup_validation_record_source
  ON tenant_backup_validation_records(session_id,bundle_id,source_id)
  WHERE source_id IS NOT NULL;
