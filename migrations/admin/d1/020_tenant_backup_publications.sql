CREATE TABLE tenant_backup_publications (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  inventory_digest TEXT NOT NULL CHECK(length(inventory_digest)=64),
  published_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at=published_at+604800000),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);
CREATE INDEX idx_tenant_backup_publications_expiry ON tenant_backup_publications(expires_at,operation_id);
CREATE TRIGGER tenant_backup_publication_immutable
BEFORE UPDATE ON tenant_backup_publications
BEGIN SELECT RAISE(ABORT,'backup_publication_immutable'); END;
