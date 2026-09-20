-- Keep Admin mapping approval scoped to the current import. The same source Admin ID may appear
-- in validation history for older operations and must not make a complete current mapping fail.
DROP TRIGGER tenant_backup_admin_mapping_freeze_complete;

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
    LEFT JOIN admin_users u
      ON u.id=m.target_admin_id AND u.tenant_id=m.tenant_id
      AND u.is_active=1 AND u.status='active'
    WHERE m.operation_id=OLD.operation_id AND m.tenant_id=OLD.tenant_id
      AND (
        u.id IS NULL OR NOT EXISTS (
          SELECT 1 FROM tenant_backup_validation_records r
          JOIN tenant_backup_input_validations v
            ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
          WHERE v.operation_id=m.operation_id AND v.tenant_id=m.tenant_id
            AND r.collection='admin.admin_users'
            AND r.record_id=json_array(json_array('text',m.source_admin_id))
        )
      )
  )
)
BEGIN SELECT RAISE(ABORT,'backup_admin_mapping_incomplete'); END;
