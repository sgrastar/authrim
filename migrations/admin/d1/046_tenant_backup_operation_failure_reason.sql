-- A backup that can never succeed (it exceeds what import accepts) is cleaned up like a
-- cancellation and finishes as 'failed'. This keeps the reason; retries and cleanup never clear it.
ALTER TABLE tenant_backup_operations ADD COLUMN failure_reason TEXT CHECK (
  failure_reason IS NULL OR failure_reason IN (
    'backup_export_too_large',
    'backup_artifact_too_large',
    'backup_sqlite_row_too_large'
  )
);
