-- Backup coordination is operational state, never restored as runnable source work.
CREATE TABLE tenant_backup_operations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'import')),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'waiting', 'ready', 'completed', 'failed', 'cancelling', 'cancelled')),
  phase TEXT NOT NULL DEFAULT 'prepare',
  cursor_json TEXT CHECK (cursor_json IS NULL OR (length(cursor_json) <= 16384 AND json_valid(cursor_json))),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > updated_at)),
  CHECK (lease_owner IS NULL OR state IN ('running', 'cancelling')),
  CHECK (state <> 'running' OR lease_owner IS NOT NULL)
);
CREATE INDEX idx_tenant_backup_operations_queue
  ON tenant_backup_operations(state, lease_expires_at, created_at);
CREATE INDEX idx_tenant_backup_operations_tenant
  ON tenant_backup_operations(tenant_id, created_at, id);
