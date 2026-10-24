-- Mapping choice history. Pending client intents are internal durable retry state;
-- only committed rows are displayed, archived, or exported as audit history.
CREATE TABLE identity_mapping_level_history (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('tenant_default', 'client')),
  client_id TEXT,
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  via TEXT NOT NULL CHECK (via IN ('settings', 'client', 'bulk_apply', 'restore')),
  bulk_id TEXT,
  source_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'aborted')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  committed_at INTEGER,
  last_reconciled_at INTEGER NOT NULL DEFAULT 0 CHECK (last_reconciled_at >= 0),
  receipt_acknowledged_at INTEGER CHECK (receipt_acknowledged_at >= 0),
  CHECK ((tier = 'tenant_default' AND client_id IS NULL) OR
         (tier = 'client' AND client_id IS NOT NULL AND length(client_id) > 0)),
  CHECK ((status = 'committed' AND committed_at IS NOT NULL AND committed_at >= created_at) OR
         (status <> 'committed' AND committed_at IS NULL)),
  CHECK ((tier = 'tenant_default' AND json_type(before_json) IN ('text', 'null') AND
           json_type(after_json) IN ('text', 'null')) OR
         (tier = 'client' AND json_type(before_json) IN ('object', 'null') AND
           json_type(after_json) IN ('object', 'null')))
);
CREATE INDEX idx_identity_mapping_level_history_level
  ON identity_mapping_level_history(tenant_id, tier, client_id, status, created_at DESC, id DESC);
CREATE INDEX idx_identity_mapping_level_history_pending
  ON identity_mapping_level_history(status, tier, last_reconciled_at, created_at, id);
-- Allocate the next per-level timestamp without scanning that level's full history.
CREATE INDEX idx_identity_mapping_level_history_order
  ON identity_mapping_level_history(tenant_id, tier, client_id, created_at DESC);
