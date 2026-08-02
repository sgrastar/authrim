-- Runtime-only sentinel used by the signed Control Worker binding smoke RPC.
-- It contains topology identifiers only and never stores tenant or account data.
CREATE TABLE IF NOT EXISTS authrim_control_plane_shard_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  binding_ref TEXT NOT NULL CHECK (binding_ref GLOB 'TDB_[A-Z0-9_]*'),
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users')),
  residency_partition TEXT NOT NULL
    CHECK (length(residency_partition) BETWEEN 1 AND 63),
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 1 AND 128),
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  expected_file_count INTEGER NOT NULL CHECK (expected_file_count >= 1),
  last_filename TEXT NOT NULL CHECK (length(last_filename) BETWEEN 1 AND 255),
  updated_at INTEGER NOT NULL
);
