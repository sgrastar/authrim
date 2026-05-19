-- Control-plane tables for tenant discovery indexes and runtime registry cache metadata.
-- These tables intentionally store hashed/blind-indexed routing identifiers only.

CREATE TABLE IF NOT EXISTS tenant_discovery_indexes (
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (
    index_kind IN (
      'email_domain',
      'email_exact',
      'external_subject',
      'global_subject'
    )
  ),
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  key_version INTEGER NOT NULL DEFAULT 1,
  source_updated_at TEXT,
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'stale', 'rotating', 'disabled', 'deleted')
  ),
  metadata_json TEXT,
  PRIMARY KEY (
    index_kind,
    index_value,
    tenant_id,
    subject_id,
    index_version,
    key_version
  )
);

CREATE INDEX IF NOT EXISTS idx_tenant_discovery_indexes_subject
  ON tenant_discovery_indexes(tenant_id, subject_id, index_kind);

CREATE INDEX IF NOT EXISTS idx_tenant_discovery_indexes_freshness
  ON tenant_discovery_indexes(status, indexed_at, source_updated_at);

CREATE TABLE IF NOT EXISTS tenant_runtime_cache_generations (
  tenant_id TEXT NOT NULL,
  cache_namespace TEXT NOT NULL CHECK (
    cache_namespace IN (
      'settings',
      'policy',
      'runtime_registry',
      'users_core',
      'users_pii',
      'clients',
      'consent',
      'rebac'
    )
  ),
  generation INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  metadata_json TEXT,
  PRIMARY KEY (tenant_id, cache_namespace)
);

CREATE TABLE IF NOT EXISTS tenant_runtime_registry_snapshots (
  tenant_id TEXT NOT NULL,
  snapshot_scope TEXT NOT NULL DEFAULT 'tenant' CHECK (
    snapshot_scope IN ('tenant', 'deployment_target')
  ),
  deployment_target TEXT NOT NULL DEFAULT 'default',
  runtime_generation INTEGER NOT NULL,
  storage_profile_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL DEFAULT 1,
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

CREATE INDEX IF NOT EXISTS idx_tenant_runtime_registry_snapshots_active
  ON tenant_runtime_registry_snapshots(status, expires_at, storage_profile_id);
