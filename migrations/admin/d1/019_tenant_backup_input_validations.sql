CREATE TABLE tenant_backup_input_validations (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  input_inventory_digest TEXT NOT NULL,
  examined_references INTEGER NOT NULL CHECK(examined_references>=0),
  unresolved_provenance INTEGER NOT NULL CHECK(unresolved_provenance>=0 AND unresolved_provenance<=examined_references),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  FOREIGN KEY(session_id,tenant_id) REFERENCES tenant_backup_validation_sessions(id,tenant_id) ON DELETE CASCADE
);
CREATE TRIGGER tenant_backup_input_validation_immutable
BEFORE UPDATE ON tenant_backup_input_validations
BEGIN SELECT RAISE(ABORT,'backup_input_validation_immutable'); END;
