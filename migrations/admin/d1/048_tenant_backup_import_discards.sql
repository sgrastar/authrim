-- An import cancelled or failed for good after it began writing its SQL restore targets discards
-- the restored tenant. One row per such operation records the cleanup's decision, when cleanup
-- first saw the operation (restore leases granted before it must expire before deciding), the
-- schemas it planned the discard against, when it removed the tenant's settings documents (their
-- KV keys are swept once no projection can still write one) and, while cleanup is stopped, why.
CREATE TABLE tenant_backup_import_discards (
  operation_id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  decision TEXT CHECK (decision IS NULL OR decision IN ('none', 'discard')),
  decided_at INTEGER CHECK (decided_at IS NULL OR decided_at >= first_seen_at),
  schema_digests_json TEXT CHECK (
    schema_digests_json IS NULL OR (json_valid(schema_digests_json) AND length(schema_digests_json) <= 16384)
  ),
  -- When the discarded tenant's settings documents were deleted: a projection that read one
  -- before may still write its KV key until the longest scheduled run has ended.
  settings_deleted_at INTEGER CHECK (settings_deleted_at IS NULL OR settings_deleted_at >= first_seen_at),
  -- Progress of the final KV sweep per key prefix: where the listing continues, how many keys
  -- the current pass deleted, and whether one complete pass found nothing left.
  kv_sweep_json TEXT CHECK (
    kv_sweep_json IS NULL OR (json_valid(kv_sweep_json) AND length(kv_sweep_json) <= 8192)
  ),
  blocker_kind TEXT CHECK (
    blocker_kind IS NULL OR blocker_kind IN ('legal_hold', 'blocked_rows', 'schema_changed')
  ),
  blocker_json TEXT CHECK (
    blocker_json IS NULL OR (json_valid(blocker_json) AND length(blocker_json) <= 8192)
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= first_seen_at),
  FOREIGN KEY (operation_id, tenant_id) REFERENCES tenant_backup_operations(id, tenant_id),
  CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CHECK (decision = 'discard' OR (
    schema_digests_json IS NULL AND settings_deleted_at IS NULL AND kv_sweep_json IS NULL
  )),
  CHECK ((blocker_kind IS NULL) = (blocker_json IS NULL)),
  CHECK (blocker_kind IS NULL OR decision = 'discard')
);

-- The decision and the schema it was made against are final once recorded.
CREATE TRIGGER tenant_backup_import_discard_decision_final
BEFORE UPDATE OF operation_id, tenant_id, first_seen_at, decision, decided_at, schema_digests_json
ON tenant_backup_import_discards
WHEN OLD.decision IS NOT NULL OR NEW.operation_id <> OLD.operation_id
  OR NEW.tenant_id <> OLD.tenant_id OR NEW.first_seen_at <> OLD.first_seen_at
BEGIN SELECT RAISE(ABORT, 'backup_import_discard_final'); END;

-- The shared Admin database holds every tenant's restore receipt. One receipt per tenant keeps a
-- restore exclusive for its tenant without letting one tenant's finished, cancelled or failed
-- import block every later import into the environment.
DROP INDEX tenant_backup_restore_target_exclusive;
CREATE UNIQUE INDEX tenant_backup_restore_target_exclusive
  ON tenant_backup_restore_targets(tenant_id);
