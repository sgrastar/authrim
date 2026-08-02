-- Signed registry projection, plugin installation targets, and encrypted host-owned configuration.

CREATE TABLE IF NOT EXISTS plugin_runner_registry_shards (
  tenant_shard_id TEXT PRIMARY KEY,
  binding_ref TEXT NOT NULL UNIQUE,
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/default', 'tenant_core/users')),
  residency_partition TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  registry_generation INTEGER NOT NULL CHECK (registry_generation >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_runner_registry_shards_active
  ON plugin_runner_registry_shards(active, tenant_shard_id);

CREATE TABLE IF NOT EXISTS plugin_runner_registry_state (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'active'),
  active_generation INTEGER NOT NULL DEFAULT 0 CHECK (active_generation >= 0),
  pending_generation INTEGER CHECK (pending_generation IS NULL OR pending_generation >= 1),
  pending_cursor INTEGER NOT NULL DEFAULT 0 CHECK (pending_cursor >= 0),
  pending_shard_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_shard_count >= 0),
  sweep_started_at INTEGER,
  sweep_completed_at INTEGER,
  sweep_overdue INTEGER NOT NULL DEFAULT 0 CHECK (sweep_overdue IN (0, 1)),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (pending_generation IS NULL AND pending_cursor = 0 AND pending_shard_count = 0) OR
    (pending_generation IS NOT NULL AND sweep_started_at IS NOT NULL)
  )
);

INSERT INTO plugin_runner_registry_state (
  singleton_key, active_generation, pending_generation, pending_cursor,
  pending_shard_count, sweep_overdue, updated_at
)
SELECT 'active', 0, NULL, 0, 0, 0, 0
WHERE NOT EXISTS (
  SELECT 1
  FROM plugin_runner_registry_state
  WHERE singleton_key = 'active'
);

CREATE TABLE IF NOT EXISTS plugin_runner_installations (
  installation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN ('dynamic_worker', 'in_process')),
  script_name TEXT,
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled', 'blocked')),
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version >= 1),
  platform_concurrency_cap INTEGER NOT NULL DEFAULT 4
    CHECK (platform_concurrency_cap BETWEEN 1 AND 32),
  platform_rate_per_minute INTEGER NOT NULL DEFAULT 60
    CHECK (platform_rate_per_minute BETWEEN 1 AND 10000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_id),
  CHECK ((backend_kind = 'dynamic_worker' AND script_name IS NOT NULL) OR
         (backend_kind = 'in_process' AND script_name IS NULL))
);

CREATE TABLE IF NOT EXISTS plugin_runner_approved_mutation_scopes (
  plugin_id TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, mutation_scope)
);

CREATE TABLE IF NOT EXISTS plugin_runner_installation_mutation_scopes (
  installation_id TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, mutation_scope),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plugin_runner_encrypted_configs (
  installation_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  injection_kind TEXT NOT NULL CHECK (injection_kind IN ('header', 'bearer')),
  injection_name TEXT NOT NULL,
  destination_host TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL
    CHECK (encryption_key_id NOT GLOB '*[^a-z0-9._-]*' AND length(encryption_key_id) BETWEEN 1 AND 64),
  encrypted_value TEXT NOT NULL CHECK (substr(encrypted_value, 1, 7) = 'enc:v1:'),
  nonce_fingerprint TEXT NOT NULL UNIQUE
    CHECK (nonce_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(nonce_fingerprint) = 64),
  reencrypt_state TEXT NOT NULL DEFAULT 'current'
    CHECK (reencrypt_state IN ('current', 'pending', 'verified')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, config_key, config_version),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  CHECK (injection_name NOT GLOB '*[^A-Za-z0-9-]*' AND length(injection_name) BETWEEN 1 AND 64),
  CHECK (destination_host = lower(destination_host) AND instr(destination_host, '/') = 0
    AND instr(destination_host, ':') = 0),
  CHECK ((injection_kind = 'bearer' AND lower(injection_name) = 'authorization') OR
         injection_kind = 'header')
);

CREATE TABLE IF NOT EXISTS plugin_runner_rate_limit_buckets (
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  destination_host TEXT NOT NULL DEFAULT '',
  window_started_at INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, tenant_id, capability, destination_host),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plugin_runner_dispatch_leases (
  lease_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  destination_host TEXT NOT NULL DEFAULT '',
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_runner_dispatch_leases_scope
  ON plugin_runner_dispatch_leases(
    installation_id, tenant_id, capability, destination_host, lease_expires_at
  );

CREATE TABLE IF NOT EXISTS plugin_runner_egress_audit (
  audit_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  destination_host TEXT NOT NULL,
  credential_injected INTEGER NOT NULL CHECK (credential_injected IN (0, 1)),
  result_code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_runner_egress_audit_created
  ON plugin_runner_egress_audit(created_at, audit_id);

CREATE TABLE IF NOT EXISTS plugin_runner_config_mutations (
  operation_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB '*[^a-z0-9._-]*' AND length(fingerprint_key_id) BETWEEN 1 AND 64),
  target_config_version INTEGER NOT NULL CHECK (target_config_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('applying', 'applied')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  UNIQUE (installation_id, target_config_version),
  CHECK ((state = 'applying' AND applied_at IS NULL) OR
         (state = 'applied' AND applied_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS plugin_runner_config_key_rotations (
  operation_id TEXT PRIMARY KEY,
  active_operation_key TEXT NOT NULL,
  from_key_id TEXT NOT NULL,
  to_key_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reencrypting', 'grace', 'complete', 'blocked')),
  cursor_installation_id TEXT,
  cursor_config_key TEXT,
  cursor_config_version INTEGER,
  source_count INTEGER NOT NULL CHECK (source_count >= 0),
  reencrypted_count INTEGER NOT NULL DEFAULT 0 CHECK (reencrypted_count >= 0),
  grace_until INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (active_operation_key),
  CHECK (from_key_id <> to_key_id),
  CHECK ((state IN ('reencrypting', 'grace', 'blocked') AND active_operation_key = 'active') OR
         (state = 'complete' AND active_operation_key = 'operation:' || operation_id)),
  CHECK ((cursor_installation_id IS NULL AND cursor_config_key IS NULL AND
          cursor_config_version IS NULL) OR
         (cursor_installation_id IS NOT NULL AND cursor_config_key IS NOT NULL AND
          cursor_config_version IS NOT NULL)),
  CHECK ((state = 'grace' AND grace_until IS NOT NULL) OR state <> 'grace'),
  CHECK ((state = 'complete' AND completed_at IS NOT NULL) OR state <> 'complete')
);
