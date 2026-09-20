-- Immutable request intent is written atomically with operation creation.
ALTER TABLE tenant_backup_operations ADD COLUMN request_json TEXT
  CHECK (request_json IS NULL OR (length(request_json) <= 32768 AND json_valid(request_json)));
CREATE TRIGGER tenant_backup_request_immutable
BEFORE UPDATE OF request_json, request_digest, tenant_id, kind, created_by, idempotency_key
ON tenant_backup_operations
WHEN OLD.request_json IS NOT NEW.request_json OR OLD.request_digest IS NOT NEW.request_digest
  OR OLD.tenant_id IS NOT NEW.tenant_id OR OLD.kind IS NOT NEW.kind
  OR OLD.created_by IS NOT NEW.created_by OR OLD.idempotency_key IS NOT NEW.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'backup request intent is immutable');
END;
