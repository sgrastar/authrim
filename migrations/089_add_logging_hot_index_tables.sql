-- Logging hot indexes for tenant-local D1 data planes.

CREATE TABLE IF NOT EXISTS log_object_catalog (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest', 'dlq_payload', 'export_artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'orphan_candidate', 'deleted')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN ('none', 'gzip_block')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);

CREATE INDEX IF NOT EXISTS idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_record_index (
  record_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  line_number INTEGER,
  block_offset INTEGER,
  block_length INTEGER,
  record_offset INTEGER,
  record_length INTEGER,
  event_at INTEGER NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_key, log_type, plane, record_id)
);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);

CREATE INDEX IF NOT EXISTS idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);

CREATE TABLE IF NOT EXISTS log_chunk_manifests (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);
