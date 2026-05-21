-- Tenant database registry for deployment-level tenant-d1 / external-durable storage routing.
-- The control DB is the source of truth; runtime snapshots and generated bindings are derived.

CREATE TABLE IF NOT EXISTS tenant_database_registry (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL DEFAULT 1,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL CHECK (
    provider IN ('d1', 'hyperdrive', 'postgres', 'mysql', 'custom')
  ),
  database_id TEXT,
  database_name TEXT,
  binding_ref TEXT,
  connection_ref TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN (
      'requested',
      'provisioning',
      'ready',
      'active',
      'degraded',
      'degraded_pending_snapshot',
      'restored_pending',
      'failed',
      'disabled',
      'retired',
      'deleting',
      'deleted'
    )
  ),
  shard_count INTEGER NOT NULL DEFAULT 1,
  shard_key_strategy TEXT NOT NULL DEFAULT 'none',
  worker_shard TEXT,
  deployment_target TEXT,
  region_hint TEXT,
  jurisdiction TEXT,
  signature TEXT,
  signature_key_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  updated_by TEXT,
  PRIMARY KEY (tenant_id, role, generation, shard_group, shard_index)
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_registry_status
  ON tenant_database_registry(status, provider, role);

CREATE INDEX IF NOT EXISTS idx_tenant_database_registry_binding_ref
  ON tenant_database_registry(binding_ref)
  WHERE binding_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_database_registry_deployment_target
  ON tenant_database_registry(deployment_target, worker_shard)
  WHERE deployment_target IS NOT NULL OR worker_shard IS NOT NULL;

CREATE TABLE IF NOT EXISTS tenant_database_active_pointers (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  shard_group TEXT NOT NULL DEFAULT 'default',
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL DEFAULT 1,
  shard_key_strategy TEXT NOT NULL DEFAULT 'none',
  runtime_generation INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'degraded_pending_snapshot', 'disabled')
  ),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, role, shard_group)
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_active_pointers_generation
  ON tenant_database_active_pointers(tenant_id, generation);

CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (
    role IN ('tenant_core', 'tenant_pii', 'tenant_audit', 'tenant_custom')
  ),
  generation INTEGER NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  migration_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'applied', 'failed', 'skipped')
  ),
  started_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  metadata_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    tenant_id,
    role,
    generation,
    shard_group,
    shard_index,
    migration_version
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_database_migration_state_status
  ON tenant_database_migration_state(status, role, migration_version);
