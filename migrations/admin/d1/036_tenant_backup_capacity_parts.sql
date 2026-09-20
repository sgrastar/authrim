-- Backup v2 checkpoints only completed capacity parts. Normal backups remain one object.
CREATE TABLE tenant_backup_artifact_parts_v2 (
  attempt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal>=0),
  object_key TEXT NOT NULL UNIQUE,
  byte_count INTEGER NOT NULL CHECK (byte_count>0 AND byte_count<=16777216),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  uploaded INTEGER NOT NULL DEFAULT 0 CHECK (uploaded IN (0,1)),
  PRIMARY KEY (attempt_id,ordinal),
  FOREIGN KEY (attempt_id,tenant_id) REFERENCES tenant_backup_artifact_attempts(id,tenant_id)
);

INSERT INTO tenant_backup_artifact_parts_v2
  (attempt_id,tenant_id,ordinal,object_key,byte_count,sha256,uploaded)
SELECT attempt_id,tenant_id,ordinal,object_key,byte_count,sha256,uploaded
FROM tenant_backup_artifact_parts;

DROP TABLE tenant_backup_artifact_parts;
ALTER TABLE tenant_backup_artifact_parts_v2 RENAME TO tenant_backup_artifact_parts;
