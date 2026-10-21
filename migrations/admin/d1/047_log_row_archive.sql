-- Log rows older than the D1 retention are moved to R2 in chunks of whole rows. Such a chunk has no
-- per-record index: its catalog row names the source table and carries the chunk id, the event
-- range (Unix ms) and when its last row expires. never_expires is 1 when any row has no expiry.
ALTER TABLE log_object_catalog ADD COLUMN source_table TEXT;
ALTER TABLE log_object_catalog ADD COLUMN chunk_id TEXT;
ALTER TABLE log_object_catalog ADD COLUMN first_event_at INTEGER;
ALTER TABLE log_object_catalog ADD COLUMN last_event_at INTEGER;
ALTER TABLE log_object_catalog ADD COLUMN max_expires_at INTEGER;
ALTER TABLE log_object_catalog ADD COLUMN never_expires INTEGER CHECK (never_expires IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_log_object_catalog_source_range
  ON log_object_catalog (tenant_key, source_table, last_event_at)
  WHERE source_table IS NOT NULL;

-- One row per archive batch: the row ids it moves and the chunk it writes them to, recorded before
-- the chunk is written so that a retry writes the same chunk and deletes exactly these rows.
CREATE TABLE log_archive_batches (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  -- Binding of the D1 database the rows are in (core rows can be in several).
  source_store TEXT NOT NULL,
  -- Dataset id of the source table, e.g. core.audit_log.
  source_table TEXT NOT NULL,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  row_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_archive_batches_pending
  ON log_archive_batches (tenant_id, source_table, state);

-- The archiver reads a tenant's oldest rows in (event time, id) order.
CREATE INDEX IF NOT EXISTS idx_federation_selected_entity_import_events_tenant_created
  ON federation_selected_entity_import_events(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_key_access_events_tenant_created
  ON key_access_events(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_mapping_events_tenant_created
  ON mapping_events(tenant_id, created_at, id);
