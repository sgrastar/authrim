-- Fresh-install-only runtime registry contract. Existing profile-based snapshot rows are not
-- migrated because this architecture does not provide an in-place upgrade path.
DROP INDEX IF EXISTS idx_tenant_runtime_registry_snapshots_active;
DROP TABLE IF EXISTS tenant_runtime_registry_snapshots;

CREATE TABLE tenant_runtime_registry_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (
    snapshot_scope IN ('tenant', 'deployment_target')
  ),
  deployment_target TEXT NOT NULL DEFAULT 'default',
  runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 1),
  backend_provider TEXT NOT NULL CHECK (backend_provider = 'd1'),
  placement_policy TEXT NOT NULL CHECK (
    placement_policy IN ('shared_pool', 'tenant_exclusive')
  ),
  placement_policy_generation INTEGER NOT NULL CHECK (placement_policy_generation >= 1),
  snapshot_version INTEGER NOT NULL DEFAULT 3 CHECK (snapshot_version >= 3),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'superseded', 'expired', 'invalid')
  ),
  object_ref TEXT,
  published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  signature TEXT,
  signature_key_id TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, snapshot_scope, deployment_target, runtime_generation)
);

CREATE INDEX idx_tenant_runtime_registry_snapshots_active
  ON tenant_runtime_registry_snapshots(
    status,
    expires_at,
    backend_provider,
    placement_policy
  );
