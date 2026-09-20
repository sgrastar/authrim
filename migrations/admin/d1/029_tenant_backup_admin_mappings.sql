-- Source administrator identities are mapped to existing target administrators before restore.
-- The mapping is operation-owned, mutable only while approval is pending, and frozen atomically
-- with the transition back to the durable import queue.
CREATE TABLE tenant_backup_admin_mapping_heads (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','frozen')),
  sealed_digest TEXT CHECK(sealed_digest IS NULL OR
    (length(sealed_digest)=64 AND sealed_digest NOT GLOB '*[^0-9a-f]*')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  approved_by TEXT,
  approved_at INTEGER,
  approval_operation_revision INTEGER CHECK(
    approval_operation_revision IS NULL OR approval_operation_revision>=0
  ),
  UNIQUE(operation_id,tenant_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id),
  CHECK(
    (state='open' AND sealed_digest IS NULL AND approved_by IS NULL AND approved_at IS NULL
      AND approval_operation_revision IS NULL)
    OR
    (state='frozen' AND sealed_digest IS NOT NULL AND approved_by IS NOT NULL
      AND approved_at IS NOT NULL AND approval_operation_revision IS NOT NULL)
  )
);

CREATE TABLE tenant_backup_admin_mappings (
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  source_admin_id TEXT NOT NULL CHECK(length(source_admin_id) BETWEEN 1 AND 256),
  target_admin_id TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  PRIMARY KEY(operation_id,source_admin_id),
  UNIQUE(operation_id,target_admin_id),
  FOREIGN KEY(operation_id,tenant_id)
    REFERENCES tenant_backup_admin_mapping_heads(operation_id,tenant_id) ON DELETE CASCADE,
  FOREIGN KEY(target_admin_id) REFERENCES admin_users(id)
);

CREATE INDEX tenant_backup_admin_mappings_target
  ON tenant_backup_admin_mappings(tenant_id,target_admin_id,operation_id);

CREATE TRIGGER tenant_backup_admin_mapping_head_authorized
BEFORE INSERT ON tenant_backup_admin_mapping_heads
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_operations o
  WHERE o.id=NEW.operation_id AND o.tenant_id=NEW.tenant_id AND o.kind='import'
    AND o.state='waiting' AND o.phase='await_restore_approval'
    AND o.lease_owner IS NULL AND o.lease_expires_at IS NULL
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_not_waiting'); END;

CREATE TRIGGER tenant_backup_admin_mapping_insert_authorized
BEFORE INSERT ON tenant_backup_admin_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_admin_mapping_heads h
  JOIN tenant_backup_operations o ON o.id=h.operation_id AND o.tenant_id=h.tenant_id
  WHERE h.operation_id=NEW.operation_id AND h.tenant_id=NEW.tenant_id AND h.state='open'
    AND o.kind='import' AND o.state='waiting' AND o.phase='await_restore_approval'
) OR NOT EXISTS (
  SELECT 1 FROM tenant_backup_validation_records r
  JOIN tenant_backup_input_validations v
    ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
  WHERE v.operation_id=NEW.operation_id AND v.tenant_id=NEW.tenant_id
    AND r.collection='admin.admin_users'
    AND r.record_id=json_array(json_array('text',NEW.source_admin_id))
) OR NOT EXISTS (
  SELECT 1 FROM admin_users u
  WHERE u.id=NEW.target_admin_id AND u.tenant_id=NEW.tenant_id
    AND u.is_active=1 AND u.status='active'
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_invalid'); END;

CREATE TRIGGER tenant_backup_admin_mapping_update_authorized
BEFORE UPDATE ON tenant_backup_admin_mappings
WHEN OLD.operation_id<>NEW.operation_id OR OLD.tenant_id<>NEW.tenant_id
  OR OLD.source_admin_id<>NEW.source_admin_id
  OR NOT EXISTS (
    SELECT 1 FROM tenant_backup_admin_mapping_heads h
    JOIN tenant_backup_operations o ON o.id=h.operation_id AND o.tenant_id=h.tenant_id
    WHERE h.operation_id=OLD.operation_id AND h.tenant_id=OLD.tenant_id AND h.state='open'
      AND o.kind='import' AND o.state='waiting' AND o.phase='await_restore_approval'
  ) OR NOT EXISTS (
    SELECT 1 FROM admin_users u
    WHERE u.id=NEW.target_admin_id AND u.tenant_id=NEW.tenant_id
      AND u.is_active=1 AND u.status='active'
  )
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_invalid'); END;

CREATE TRIGGER tenant_backup_admin_mapping_delete_authorized
BEFORE DELETE ON tenant_backup_admin_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM tenant_backup_admin_mapping_heads h
  JOIN tenant_backup_operations o ON o.id=h.operation_id AND o.tenant_id=h.tenant_id
  WHERE h.operation_id=OLD.operation_id AND h.tenant_id=OLD.tenant_id AND h.state='open'
    AND o.kind='import' AND o.state='waiting' AND o.phase='await_restore_approval'
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_invalid'); END;

CREATE TRIGGER tenant_backup_admin_mapping_insert_revision
AFTER INSERT ON tenant_backup_admin_mappings
BEGIN
  UPDATE tenant_backup_admin_mapping_heads
  SET revision=revision+1,updated_by=NEW.updated_by,updated_at=NEW.updated_at
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND state='open';
END;

CREATE TRIGGER tenant_backup_admin_mapping_update_revision
AFTER UPDATE OF target_admin_id ON tenant_backup_admin_mappings
BEGIN
  UPDATE tenant_backup_admin_mapping_heads
  SET revision=revision+1,updated_by=NEW.updated_by,updated_at=NEW.updated_at
  WHERE operation_id=NEW.operation_id AND tenant_id=NEW.tenant_id AND state='open';
END;

CREATE TRIGGER tenant_backup_admin_mapping_delete_revision
AFTER DELETE ON tenant_backup_admin_mappings
BEGIN
  UPDATE tenant_backup_admin_mapping_heads
  SET revision=revision+1,updated_by=OLD.updated_by,updated_at=OLD.updated_at
  WHERE operation_id=OLD.operation_id AND tenant_id=OLD.tenant_id AND state='open';
END;

CREATE TRIGGER tenant_backup_admin_mapping_freeze_complete
BEFORE UPDATE OF state ON tenant_backup_admin_mapping_heads
WHEN OLD.state='open' AND NEW.state='frozen' AND (
  NEW.revision<>OLD.revision OR NEW.tenant_id<>OLD.tenant_id
  OR EXISTS (
    SELECT 1 FROM tenant_backup_validation_records r
    JOIN tenant_backup_input_validations v
      ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
    WHERE v.operation_id=OLD.operation_id AND v.tenant_id=OLD.tenant_id
      AND r.collection='admin.admin_users'
      AND NOT EXISTS (
        SELECT 1 FROM tenant_backup_admin_mappings m
        WHERE m.operation_id=OLD.operation_id AND m.tenant_id=OLD.tenant_id
          AND json_array(json_array('text',m.source_admin_id))=r.record_id
      )
  ) OR EXISTS (
    SELECT 1 FROM tenant_backup_admin_mappings m
    LEFT JOIN tenant_backup_validation_records r
      ON r.collection='admin.admin_users'
      AND r.record_id=json_array(json_array('text',m.source_admin_id))
    LEFT JOIN tenant_backup_input_validations v
      ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
      AND v.operation_id=m.operation_id
    LEFT JOIN admin_users u
      ON u.id=m.target_admin_id AND u.tenant_id=m.tenant_id
      AND u.is_active=1 AND u.status='active'
    WHERE m.operation_id=OLD.operation_id AND m.tenant_id=OLD.tenant_id
      AND (v.operation_id IS NULL OR u.id IS NULL)
  )
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_incomplete'); END;

CREATE TRIGGER tenant_backup_admin_mapping_freeze_resume
AFTER UPDATE OF state ON tenant_backup_admin_mapping_heads
WHEN OLD.state='open' AND NEW.state='frozen'
BEGIN
  UPDATE tenant_backup_operations
  SET state='queued',revision=revision+1,fencing_token=fencing_token+1,updated_at=NEW.approved_at,
    next_attempt_at=0,failure_count=0,last_error_code=NULL
  WHERE id=NEW.operation_id AND tenant_id=NEW.tenant_id AND kind='import'
    AND state='waiting' AND phase='await_restore_approval'
    AND revision=NEW.approval_operation_revision
    AND lease_owner IS NULL AND lease_expires_at IS NULL AND updated_at<=NEW.approved_at;
  SELECT RAISE(ABORT,'backup_admin_mapping_approval_stale') WHERE changes()<>1;
END;

CREATE TRIGGER tenant_backup_admin_mapping_head_immutable
BEFORE UPDATE ON tenant_backup_admin_mapping_heads
WHEN OLD.state='frozen'
  OR NEW.operation_id<>OLD.operation_id OR NEW.tenant_id<>OLD.tenant_id
  OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_immutable'); END;
