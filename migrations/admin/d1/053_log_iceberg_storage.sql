-- New storage generations only. No SELECT/backfill from legacy log tables.
-- Critical business operations keep these receipts independently of log TTL.
-- No searchable audit metadata or body is copied here.
CREATE TABLE admin_audit_receipts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  recorded_at INTEGER NOT NULL CHECK(recorded_at>=0)
) STRICT;
CREATE INDEX idx_admin_audit_receipts_tenant ON admin_audit_receipts(tenant_id,id);
-- A retry keeps the first observed failure time without copying its log body.
CREATE TABLE log_sign_in_attempt_receipts (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  failed_at INTEGER NOT NULL CHECK(failed_at>=0),
  logical_hmac TEXT NOT NULL CHECK(length(logical_hmac)=64),
  payload_hmac TEXT CHECK(length(payload_hmac)=64),
  state TEXT NOT NULL CHECK(state IN ('reserved','committed')),
  PRIMARY KEY(tenant_id,event_id),
  CHECK(state!='committed' OR payload_hmac IS NOT NULL)
) STRICT;
-- Encrypted bodies are split so no D1 value or bounded read exceeds the value limit.
-- Small logical receipts survive source deletion. They contain no log body or
-- searchable overview; retries cannot reuse an archived ID with changed content.
CREATE TABLE log_iceberg_event_receipts (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  expires_at INTEGER CHECK(expires_at>=0),
  state TEXT NOT NULL CHECK(state IN ('staged','published','erased')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_log_iceberg_event_receipts_tenant ON log_iceberg_event_receipts(tenant_id,id);
CREATE INDEX idx_log_iceberg_event_receipts_expiry ON log_iceberg_event_receipts(expires_at,id);
-- An anonymous subject tombstone has no real user ID/name/email linkage. It
-- prevents delayed Pipeline deliveries and restores from republishing erased PII.
CREATE TABLE log_iceberg_subject_erasures (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sweeping','completed')),
  snapshot_id TEXT,
  scan_cursor_json TEXT,
  mutation_receipt_json TEXT,
  mutation_history_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(mutation_history_json AS BLOB))<=262144),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK(removed_count>=0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id,source_dataset,subject_id)
) STRICT;
-- Physical source-environment GC evidence only. DR rebuilds this state from
-- logical erasure denies and log rows; it never reuses source object paths.
CREATE TABLE log_iceberg_erasure_artifacts (
  erasure_id TEXT NOT NULL REFERENCES log_iceberg_subject_erasures(id) ON DELETE CASCADE,
  table_uuid TEXT NOT NULL,
  path_digest TEXT NOT NULL CHECK(length(path_digest)=64),
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 2048),
  origin TEXT NOT NULL CHECK(origin IN ('committed','root_uncommitted')),
  owner_identity TEXT,
  operation_id TEXT,
  witness_snapshot_id TEXT,
  state TEXT NOT NULL DEFAULT 'found' CHECK(state IN ('found','live_output','removed')),
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(erasure_id,table_uuid,path_digest),
  CHECK((origin='committed' AND witness_snapshot_id IS NOT NULL) OR
    (origin='root_uncommitted' AND owner_identity IS NOT NULL AND operation_id IS NOT NULL))
) STRICT;
CREATE INDEX idx_log_iceberg_erasure_artifacts_pending
  ON log_iceberg_erasure_artifacts(erasure_id,table_uuid,state,path_digest);
-- Table-scoped TTL maintenance is independent of permanent PII subject denies.
-- Cursor/physical artifact state belongs to this environment and is rebuilt on DR.
CREATE TABLE log_iceberg_retention_jobs (
  id TEXT NOT NULL PRIMARY KEY,
  table_uuid TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  cutoff INTEGER NOT NULL CHECK(cutoff>=0),
  state TEXT NOT NULL CHECK(state IN ('pending','sweeping','completed')),
  snapshot_id TEXT,
  scan_cursor_json TEXT,
  mutation_receipt_json TEXT,
  mutation_history_json TEXT NOT NULL DEFAULT '[]' CHECK(length(CAST(mutation_history_json AS BLOB))<=262144),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(table_uuid,storage_generation,tenant_key,source_dataset)
) STRICT;
CREATE INDEX idx_log_iceberg_retention_pending ON log_iceberg_retention_jobs(table_uuid,state,updated_at,id);
CREATE INDEX idx_log_iceberg_retention_scopes ON log_iceberg_retention_jobs(table_uuid,storage_generation,id);
CREATE TABLE log_iceberg_retention_artifacts (
  retention_id TEXT NOT NULL REFERENCES log_iceberg_retention_jobs(id) ON DELETE CASCADE,
  table_uuid TEXT NOT NULL,
  path_digest TEXT NOT NULL CHECK(length(path_digest)=64),
  path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 2048),
  origin TEXT NOT NULL CHECK(origin IN ('committed','root_uncommitted')),
  owner_identity TEXT,
  operation_id TEXT,
  witness_snapshot_id TEXT,
  state TEXT NOT NULL DEFAULT 'found' CHECK(state IN ('found','live_output','removed')),
  removed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(retention_id,table_uuid,path_digest),
  CHECK((origin='committed' AND witness_snapshot_id IS NOT NULL) OR
    (origin='root_uncommitted' AND owner_identity IS NOT NULL AND operation_id IS NOT NULL))
) STRICT;
CREATE INDEX idx_log_iceberg_retention_artifacts_pending
  ON log_iceberg_retention_artifacts(retention_id,table_uuid,state,path_digest);
-- Core CAS preparations stay invisible until their original source commits.
-- The descriptor/token binds the exact source store; no business payload is copied.
CREATE TABLE log_iceberg_publications (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  record_id TEXT NOT NULL UNIQUE CHECK(length(record_id)=64),
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  mode TEXT NOT NULL CHECK(mode IN ('pipeline','scheduled')),
  source_json TEXT NOT NULL CHECK(length(CAST(source_json AS BLOB))<=4096),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','published','aborted')),
  finalized INTEGER NOT NULL DEFAULT 0 CHECK(finalized IN (0,1)),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_log_iceberg_publications_recovery
  ON log_iceberg_publications(finalized,next_attempt_at,updated_at,id);

-- Historical records restored by an unpublished import stay isolated from normal readers,
-- exporters and delivery until activation. Cancelled IDs remain a body-free denial.
-- One operation-level visibility witness avoids publishing historical rows with an unbounded UPDATE.
CREATE TABLE log_iceberg_restore_activations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  plan_digest TEXT CHECK(plan_digest IS NULL OR (length(plan_digest)=64 AND plan_digest NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('pending','active','aborted')),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  activated_at INTEGER CHECK(activated_at>=0),
  CHECK(state='aborted' OR plan_digest IS NOT NULL),
  CHECK((state='active')=(activated_at IS NOT NULL))
) STRICT;

CREATE TABLE log_iceberg_restore_holds (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id)=64),
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  storage_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('holding','aborted')),
  expires_at INTEGER CHECK(expires_at>=0),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  cleanup_completed_at INTEGER CHECK(cleanup_completed_at>=0),
  CHECK(cleanup_completed_at IS NULL OR state='aborted')
) STRICT;
CREATE INDEX idx_log_iceberg_restore_holds_operation ON log_iceberg_restore_holds(operation_id,tenant_id,state,cleanup_completed_at,id);
CREATE INDEX idx_log_iceberg_restore_holds_cleanup ON log_iceberg_restore_holds(operation_id,tenant_id,id) WHERE cleanup_completed_at IS NULL;
CREATE INDEX idx_log_iceberg_restore_holds_expiry ON log_iceberg_restore_holds(state,expires_at,id);

CREATE TABLE log_iceberg_records (
  id TEXT NOT NULL PRIMARY KEY,
  publication_id TEXT REFERENCES log_iceberg_publications(id),
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  event_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  event_at INTEGER NOT NULL CHECK(event_at >= 0),
  ingested_at INTEGER NOT NULL CHECK(ingested_at >= 0),
  expires_at INTEGER CHECK(expires_at >= 0),
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac) = 64),
  envelope_digest TEXT NOT NULL CHECK(length(envelope_digest) = 64),
  header_json TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK(body_bytes BETWEEN 1 AND 4194304),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 64),
  batch_id TEXT,
  UNIQUE(tenant_key, source_dataset, event_id),
  UNIQUE(id, tenant_id)
) STRICT;
CREATE INDEX idx_log_iceberg_records_export
  ON log_iceberg_records(storage_generation, batch_id, ingested_at, id);
CREATE INDEX idx_log_iceberg_records_read
  ON log_iceberg_records(tenant_id, source_dataset, event_at DESC, id DESC);

CREATE TABLE log_iceberg_record_parts (
  id TEXT NOT NULL PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES log_iceberg_records(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 63),
  body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) BETWEEN 1 AND 65536),
  UNIQUE(record_id, part_index),
  FOREIGN KEY(record_id,tenant_id) REFERENCES log_iceberg_records(id,tenant_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX idx_log_iceberg_record_parts_tenant ON log_iceberg_record_parts(tenant_id,record_id,part_index);

CREATE TABLE log_iceberg_export_batches (
  id TEXT NOT NULL PRIMARY KEY,
  storage_generation TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  record_ids_json TEXT NOT NULL,
  checkpoint_json TEXT,
  receipt_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('selected','committed','verified','done')),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_log_iceberg_export_batches_pending
  ON log_iceberg_export_batches(storage_generation, state, next_attempt_at, created_at, id);
CREATE UNIQUE INDEX idx_log_iceberg_export_scope_active
  ON log_iceberg_export_batches(storage_generation, tenant_key, source_dataset)
  WHERE state != 'done';

-- Updated in the SAME atomic batch as the source DELETE. A reader must reject
-- a catalog snapshot older than this revision rather than silently omit a row.
CREATE TABLE log_iceberg_read_watermarks (
  id TEXT NOT NULL PRIMARY KEY,
  table_uuid TEXT NOT NULL,
  minimum_sequence_number INTEGER NOT NULL CHECK(minimum_sequence_number >= 0),
  snapshot_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- A metadata-only preparing intent is committed before any retry R2 PUT. The
-- business batch promotes only a confirmed first-envelope pointer to pending.
-- These rows are delivery state, never a searchable copy of the log body.
CREATE TABLE log_iceberg_outbox (
  id TEXT NOT NULL PRIMARY KEY,
  publication_id TEXT REFERENCES log_iceberg_publications(id),
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  source_dataset TEXT NOT NULL,
  subject_id TEXT,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  payload_key TEXT NOT NULL,
  payload_digest TEXT CHECK(payload_digest IS NULL OR length(payload_digest)=64),
  payload_bytes INTEGER CHECK(payload_bytes IS NULL OR payload_bytes BETWEEN 1 AND 4194304),
  expires_at INTEGER CHECK(expires_at>=0),
  state TEXT NOT NULL CHECK(state IN ('preparing','pending','queued','ingested','erased')),
  payload_erased_at INTEGER CHECK(payload_erased_at>=0),
  stream_obligation_at INTEGER CHECK(stream_obligation_at>=0),
  stream_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(stream_attempt_count>=0),
  stream_observed_count INTEGER NOT NULL DEFAULT 0 CHECK(stream_observed_count>=0),
  stream_acknowledged_at INTEGER CHECK(stream_acknowledged_at>=0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK((payload_digest IS NULL) = (payload_bytes IS NULL)),
  CHECK(state IN ('preparing','erased') OR payload_digest IS NOT NULL),
  CHECK(payload_erased_at IS NULL OR state='erased'),
  CHECK((stream_attempt_count=0 AND stream_obligation_at IS NULL AND stream_acknowledged_at IS NULL)
    OR (stream_attempt_count>0 AND stream_obligation_at IS NOT NULL
      AND (stream_acknowledged_at IS NULL OR stream_acknowledged_at>=stream_obligation_at)))
) STRICT;
CREATE INDEX idx_log_iceberg_outbox_delivery
  ON log_iceberg_outbox(storage_generation, state, next_attempt_at, created_at, id);
CREATE INDEX idx_log_iceberg_outbox_subject ON log_iceberg_outbox(tenant_id,source_dataset,subject_id,state,id);

-- Backup-scoped logical duplicate witness only; bodies use encrypted DR pages.
CREATE TABLE log_iceberg_backup_seen (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK(length(record_id)=64),
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  page_ordinal INTEGER NOT NULL CHECK(page_ordinal>=0),
  PRIMARY KEY(operation_id,resource_id,record_id),
  FOREIGN KEY(operation_id,tenant_id) REFERENCES tenant_backup_operations(id,tenant_id)
) STRICT;

-- Bounded PII resumption enumerates metadata scopes without scanning other datasets.
CREATE INDEX idx_log_iceberg_retention_source_scope ON log_iceberg_retention_jobs(table_uuid,storage_generation,source_dataset,id);
