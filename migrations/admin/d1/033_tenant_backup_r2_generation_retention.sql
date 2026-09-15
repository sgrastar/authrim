-- Preserve superseded R2 keys until every SQL snapshot that could reference them has finished.
-- R2 object version identifiers cannot be used to fetch an older generation through the Workers API.
CREATE TABLE tenant_backup_r2_retired_generations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_key TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN (
    'AUDIT_ARCHIVE', 'DIAGNOSTIC_LOGS', 'SENSITIVE_DETAILS',
    'EXPORT_ARTIFACTS', 'IMPORT_ARTIFACTS'
  )),
  object_catalog_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  replacement_object_key TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('rewrap', 'catalog_delete')),
  key_registry_id TEXT,
  previous_key_version INTEGER,
  replacement_key_version INTEGER,
  record_count INTEGER,
  accounting_applied INTEGER NOT NULL DEFAULT 0 CHECK (accounting_applied IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK (
    (reason = 'rewrap' AND replacement_object_key IS NOT NULL
      AND key_registry_id IS NOT NULL
      AND previous_key_version IS NOT NULL AND previous_key_version > 0
      AND replacement_key_version IS NOT NULL AND replacement_key_version > 0
      AND previous_key_version <> replacement_key_version
      AND record_count IS NOT NULL AND record_count >= 0)
    OR
    (reason = 'catalog_delete' AND replacement_object_key IS NULL
      AND key_registry_id IS NULL AND previous_key_version IS NULL
      AND replacement_key_version IS NULL AND record_count IS NULL
      AND accounting_applied = 1)
  ),
  UNIQUE (bucket_binding, object_key, object_catalog_id)
);

CREATE INDEX idx_tenant_backup_r2_retired_generations_created
  ON tenant_backup_r2_retired_generations(created_at, id);

CREATE TRIGGER tenant_backup_r2_retired_generations_identity_immutable
BEFORE UPDATE OF id, tenant_key, bucket_binding, object_catalog_id, object_key,
  replacement_object_key, reason, key_registry_id, previous_key_version,
  replacement_key_version, record_count, created_at
ON tenant_backup_r2_retired_generations
BEGIN
  SELECT RAISE(ABORT, 'tenant_backup_r2_retired_generation_immutable');
END;

CREATE TRIGGER tenant_backup_r2_retired_generations_accounting_monotonic
BEFORE UPDATE OF accounting_applied ON tenant_backup_r2_retired_generations
WHEN NOT (OLD.accounting_applied = 0 AND NEW.accounting_applied = 1)
BEGIN
  SELECT RAISE(ABORT, 'tenant_backup_r2_retired_generation_accounting');
END;
