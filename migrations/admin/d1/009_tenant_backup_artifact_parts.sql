-- Ciphertext-only staging. Sealed is not yet authorized for public download.
CREATE TABLE tenant_backup_artifact_attempts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN ('writing','sealed','deleting')),
  created_at INTEGER NOT NULL,
  part_count INTEGER,
  byte_count INTEGER,
  UNIQUE (id,tenant_id),
  FOREIGN KEY (operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  CHECK ((state='writing' AND part_count IS NULL AND byte_count IS NULL) OR
    (state='sealed' AND part_count>0 AND byte_count>0) OR state='deleting')
);
CREATE INDEX idx_tenant_backup_artifact_attempts_operation ON tenant_backup_artifact_attempts(tenant_id,operation_id);
CREATE TABLE tenant_backup_artifact_parts (
  attempt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal>=0),
  object_key TEXT NOT NULL UNIQUE,
  byte_count INTEGER NOT NULL CHECK (byte_count>0 AND byte_count<=4194304),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  uploaded INTEGER NOT NULL DEFAULT 0 CHECK (uploaded IN (0,1)),
  PRIMARY KEY (attempt_id,ordinal),
  FOREIGN KEY (attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);
