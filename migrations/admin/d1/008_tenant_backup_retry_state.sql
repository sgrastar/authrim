ALTER TABLE tenant_backup_operations ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0);
ALTER TABLE tenant_backup_operations ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0);
ALTER TABLE tenant_backup_operations ADD COLUMN last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code='backup_operation_slice_failed');
CREATE INDEX idx_tenant_backup_operations_due ON tenant_backup_operations(state, next_attempt_at, updated_at, id);
