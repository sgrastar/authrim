CREATE UNIQUE INDEX idx_tenant_backup_operations_identity
  ON tenant_backup_operations(id, tenant_id);
CREATE TABLE tenant_backup_validation_sessions (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'sealed', 'deleting')),
  created_at INTEGER NOT NULL,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (operation_id, tenant_id) REFERENCES tenant_backup_operations(id, tenant_id)
);
CREATE INDEX idx_tenant_backup_validation_cleanup ON tenant_backup_validation_sessions(state, created_at, id);
CREATE TABLE tenant_backup_validation_records (
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  module TEXT NOT NULL,
  collection TEXT NOT NULL,
  record_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  PRIMARY KEY (session_id, module, collection, record_id),
  FOREIGN KEY (session_id, tenant_id) REFERENCES tenant_backup_validation_sessions(id, tenant_id)
);
CREATE TABLE tenant_backup_validation_references (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  dependency_json TEXT NOT NULL CHECK (json_valid(dependency_json) AND length(dependency_json) <= 20000),
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id, tenant_id) REFERENCES tenant_backup_validation_sessions(id, tenant_id)
);
