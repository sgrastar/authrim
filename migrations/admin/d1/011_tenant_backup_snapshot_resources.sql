-- Reserve before contacting a source database, so cancellation can find even an uncertain start.
CREATE TABLE tenant_backup_snapshot_resources (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE,
  cleaned INTEGER NOT NULL DEFAULT 0 CHECK(cleaned IN (0,1)),
  PRIMARY KEY(operation_id,resource_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
);
CREATE TRIGGER tenant_backup_snapshot_resource_identity
BEFORE UPDATE OF operation_id,tenant_id,resource_id,snapshot_id ON tenant_backup_snapshot_resources
BEGIN SELECT RAISE(ABORT,'backup_snapshot_resource_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_resource_monotonic
BEFORE UPDATE OF cleaned ON tenant_backup_snapshot_resources WHEN OLD.cleaned=1 AND NEW.cleaned!=1
BEGIN SELECT RAISE(ABORT,'backup_snapshot_resource_regression'); END;
