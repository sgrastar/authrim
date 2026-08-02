-- Sticky tenant-level route allocation for tenant_core/default.
-- Account-level allocations remain in control_tenant_shard_allocations.

CREATE TABLE IF NOT EXISTS control_tenant_default_allocations (
  allocation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  residency_policy_id TEXT NOT NULL,
  residency_partition TEXT NOT NULL,
  selected_shard_id TEXT NOT NULL,
  reservation_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (reservation_state IN ('reserved', 'committed', 'released')),
  idempotency_key TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  capacity_counted_at INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  released_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, tenant_id, residency_partition),
  UNIQUE (environment_id, idempotency_key),
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (selected_shard_id, environment_id)
    REFERENCES control_tenant_shards(shard_id, environment_id),
  FOREIGN KEY (environment_id, residency_policy_id, residency_partition)
    REFERENCES control_residency_partitions(environment_id, residency_policy_id, residency_partition),
  CHECK ((reservation_state = 'committed' AND committed_at IS NOT NULL AND released_at IS NULL) OR
         (reservation_state = 'released' AND released_at IS NOT NULL) OR
         (reservation_state = 'reserved' AND committed_at IS NULL AND released_at IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_control_tenant_default_allocations_shard
  ON control_tenant_default_allocations(selected_shard_id, reservation_state, updated_at);
