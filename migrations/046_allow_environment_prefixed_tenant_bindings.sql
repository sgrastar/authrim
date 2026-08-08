-- Replace the legacy TDB_* constraint with the environment-prefixed tenant
-- binding convention. Legacy environments must be recreated before applying
-- this migration; accepting their binding shape would weaken the contract.
CREATE TABLE authrim_control_plane_shard_metadata_v046 (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  binding_ref TEXT NOT NULL CHECK (
    binding_ref GLOB '[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]*'
  ),
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

INSERT INTO authrim_control_plane_shard_metadata_v046 (
  singleton_id, binding_ref, data_role, residency_partition, migration_generation,
  release_id, manifest_digest, expected_file_count, last_filename, updated_at
)
SELECT
  singleton_id, binding_ref, data_role, residency_partition, migration_generation,
  release_id, manifest_digest, expected_file_count, last_filename, updated_at
FROM authrim_control_plane_shard_metadata;

DROP TABLE authrim_control_plane_shard_metadata;
ALTER TABLE authrim_control_plane_shard_metadata_v046
  RENAME TO authrim_control_plane_shard_metadata;
