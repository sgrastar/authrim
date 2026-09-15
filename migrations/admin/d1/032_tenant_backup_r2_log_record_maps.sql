-- Rebuilt log chunks need durable target offsets before their restored catalog can be activated.
ALTER TABLE tenant_backup_r2_restore_objects
  ADD COLUMN log_records_json TEXT
  CHECK(log_records_json IS NULL OR (
    json_valid(log_records_json)
    AND json_type(log_records_json)='array'
    AND length(log_records_json) BETWEEN 2 AND 2097152
  ));

CREATE TRIGGER tenant_backup_r2_restore_log_records_immutable
BEFORE UPDATE OF log_records_json ON tenant_backup_r2_restore_objects
WHEN OLD.log_records_json IS NOT NULL AND NEW.log_records_json IS NOT OLD.log_records_json
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_identity'); END;

CREATE TRIGGER tenant_backup_r2_restore_log_records_encoding_insert
BEFORE INSERT ON tenant_backup_r2_restore_objects
WHEN NEW.log_records_json IS NOT NULL
  AND NEW.source_encoding<>'log_chunk_records_v1'
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_encoding'); END;

CREATE TRIGGER tenant_backup_r2_restore_log_records_encoding_update
BEFORE UPDATE OF log_records_json ON tenant_backup_r2_restore_objects
WHEN NEW.log_records_json IS NOT NULL
  AND NEW.source_encoding<>'log_chunk_records_v1'
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_encoding'); END;

CREATE TRIGGER tenant_backup_r2_restore_log_records_completed
BEFORE UPDATE OF state ON tenant_backup_r2_restore_objects
WHEN NEW.state='completed'
  AND NEW.source_encoding='log_chunk_records_v1'
  AND NEW.log_records_json IS NULL
BEGIN SELECT RAISE(ABORT,'backup_r2_restore_log_records_required'); END;
