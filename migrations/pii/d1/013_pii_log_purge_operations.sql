-- Pending PII audit erasure keeps the old anonymous subject while the live mapping rotates.
-- Delete the operation, including its real-user association, only after physical erasure completes.
CREATE TABLE pii_log_purge_operations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  old_anonymized_user_id TEXT NOT NULL,
  new_anonymized_user_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX idx_pii_log_purge_operations_tenant_created
  ON pii_log_purge_operations (tenant_id, created_at, id);
