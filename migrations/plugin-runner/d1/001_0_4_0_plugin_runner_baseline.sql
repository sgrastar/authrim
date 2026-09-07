-- Authrim 0.4.0 semantic fresh-install baseline.
-- Logical stream: plugin-runner-d1.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
PRAGMA foreign_keys = OFF;

CREATE TABLE plugin_runner_shard_cursors (
  tenant_shard_id TEXT PRIMARY KEY,
  next_due_at INTEGER,
  last_scan_at INTEGER,
  last_generation INTEGER NOT NULL DEFAULT 0 CHECK (last_generation >= 0),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  scheduler_error_code TEXT,
  consecutive_error_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_error_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE plugin_runner_full_sweep_state (
  sweep_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed')),
  active_sweep_key TEXT NOT NULL,
  started_at INTEGER,
  target_completed_at INTEGER,
  completed_at INTEGER,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  scanned_shard_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_shard_count >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state IN ('pending', 'running') AND active_sweep_key = 'active') OR
         (state IN ('completed', 'failed') AND active_sweep_key = 'sweep:' || sweep_id))
);
CREATE TABLE plugin_runner_hook_policies (
  plugin_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 30000),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('fail_open', 'fail_closed', 'retry_async')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  async_retry_budget_seconds INTEGER NOT NULL DEFAULT 86400
    CHECK (async_retry_budget_seconds BETWEEN 60 AND 604800),
  circuit_breaker_threshold INTEGER NOT NULL CHECK (circuit_breaker_threshold BETWEEN 1 AND 1000),
  circuit_breaker_cooldown_seconds INTEGER NOT NULL
    CHECK (circuit_breaker_cooldown_seconds BETWEEN 1 AND 86400),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, capability)
);
CREATE TABLE plugin_runner_egress_allowed_hosts (
  plugin_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'suffix_wildcard')),
  host_pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, rule_id),
  CHECK (host_pattern = lower(host_pattern)),
  CHECK (instr(host_pattern, '/') = 0),
  CHECK (instr(host_pattern, ':') = 0),
  CHECK ((match_kind = 'exact' AND instr(host_pattern, '*') = 0) OR
         (match_kind = 'suffix_wildcard' AND
          substr(host_pattern, 1, 2) = '*.' AND
          instr(substr(host_pattern, 3), '.') > 0))
);
CREATE TABLE plugin_runner_circuit_breakers (
  plugin_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  opened_at INTEGER,
  retry_after INTEGER,
  updated_at INTEGER NOT NULL, probe_token TEXT, probe_until INTEGER,
  PRIMARY KEY (plugin_id, tenant_id, capability)
);
CREATE TABLE plugin_runner_migration_state (
  stream_id TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  sql_digest TEXT NOT NULL CHECK (length(sql_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'failed')),
  operation_id TEXT NOT NULL,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, migration_id)
);
CREATE TABLE plugin_runner_registry_shards (
  tenant_shard_id TEXT PRIMARY KEY,
  binding_ref TEXT NOT NULL UNIQUE,
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/default', 'tenant_core/users')),
  residency_partition TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  registry_generation INTEGER NOT NULL CHECK (registry_generation >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);
CREATE TABLE plugin_runner_registry_state (
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
INSERT INTO plugin_runner_registry_state VALUES('active',0,NULL,0,0,NULL,NULL,0,NULL,0);
CREATE TABLE plugin_runner_installations (
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
  updated_at INTEGER NOT NULL, pending_activation_request_id TEXT
    CHECK (
      pending_activation_request_id IS NULL OR (
        length(pending_activation_request_id) BETWEEN 1 AND 256 AND
        pending_activation_request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
      )
    ),
  UNIQUE (tenant_id, plugin_id),
  CHECK ((backend_kind = 'dynamic_worker' AND script_name IS NOT NULL) OR
         (backend_kind = 'in_process' AND script_name IS NULL))
);
CREATE TABLE plugin_runner_approved_mutation_scopes (
  plugin_id TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  approved_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, mutation_scope)
);
CREATE TABLE plugin_runner_installation_mutation_scopes (
  installation_id TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, mutation_scope),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);
CREATE TABLE plugin_runner_rate_limit_buckets (
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
CREATE TABLE plugin_runner_dispatch_leases (
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
CREATE TABLE plugin_runner_egress_audit (
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
CREATE TABLE plugin_runner_config_mutations (
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
CREATE TABLE plugin_runner_config_key_rotations (
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
CREATE TABLE plugin_runner_notification_route_sets (
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  state TEXT NOT NULL CHECK (state IN ('enabled', 'disabled')),
  last_operation_id TEXT NOT NULL UNIQUE,
  order_fingerprint TEXT NOT NULL
    CHECK (order_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(order_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, channel),
  UNIQUE (tenant_id, channel, config_version),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(last_operation_id) BETWEEN 1 AND 256)
);
CREATE TABLE plugin_runner_notification_route_entries (
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 7),
  installation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, channel, priority),
  UNIQUE (tenant_id, channel, installation_id),
  FOREIGN KEY (tenant_id, channel, config_version)
    REFERENCES plugin_runner_notification_route_sets(tenant_id, channel, config_version)
    ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, installation_id)
    REFERENCES plugin_runner_installations(tenant_id, installation_id)
    ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS "plugin_runner_encrypted_configs" (
  installation_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  injection_kind TEXT NOT NULL
    CHECK (injection_kind IN ('header', 'bearer', 'json_field', 'form_field')),
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
  CHECK (injection_name NOT GLOB '*[^A-Za-z0-9_.-]*' AND length(injection_name) BETWEEN 1 AND 64),
  CHECK (destination_host = lower(destination_host) AND instr(destination_host, '/') = 0
    AND instr(destination_host, ':') = 0),
  CHECK ((injection_kind = 'bearer' AND lower(injection_name) = 'authorization') OR
         injection_kind <> 'bearer')
);
CREATE TABLE plugin_runner_human_verification_configs (
  installation_id TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('turnstile', 'hcaptcha', 'recaptcha')),
  site_key TEXT NOT NULL CHECK (length(site_key) BETWEEN 1 AND 2048),
  expected_hostname TEXT,
  widget_mode TEXT NOT NULL CHECK (widget_mode IN ('managed', 'checkbox', 'invisible', 'score')),
  score_threshold REAL NOT NULL CHECK (score_threshold >= 0 AND score_threshold <= 1),
  config_fingerprint TEXT NOT NULL
    CHECK (config_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(config_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, config_version),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  CHECK (expected_hostname IS NULL OR (
    expected_hostname = lower(expected_hostname) AND
    length(expected_hostname) BETWEEN 1 AND 253 AND
    instr(expected_hostname, '/') = 0 AND instr(expected_hostname, ':') = 0
  ))
);
CREATE TABLE plugin_runner_dynamic_worker_releases (
  plugin_id TEXT NOT NULL,
  version_digest TEXT NOT NULL
    CHECK (length(version_digest) = 64 AND version_digest NOT GLOB '*[^0-9a-f]*'),
  code_sha256 TEXT NOT NULL
    CHECK (length(code_sha256) = 64 AND code_sha256 NOT GLOB '*[^0-9a-f]*'),
  code_object_key TEXT NOT NULL
    CHECK (code_object_key GLOB 'plugins/*.json' AND length(code_object_key) BETWEEN 14 AND 512),
  source_manifest_hash TEXT NOT NULL
    CHECK (length(source_manifest_hash) = 64 AND source_manifest_hash NOT GLOB '*[^0-9a-f]*'),
  capability_manifest_digest TEXT NOT NULL
    CHECK (length(capability_manifest_digest) = 64
      AND capability_manifest_digest NOT GLOB '*[^0-9a-f]*'),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  state TEXT NOT NULL DEFAULT 'published'
    CHECK (state IN ('published', 'revoked')),
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version_digest),
  UNIQUE (plugin_id, version_digest, code_sha256, code_object_key)
);
CREATE TABLE plugin_runner_dynamic_worker_manifests (
  plugin_id TEXT PRIMARY KEY,
  active_version_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'active', 'revoked')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_id, active_version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
);
CREATE TABLE plugin_runner_dynamic_worker_hook_policies (
  plugin_id TEXT NOT NULL,
  version_digest TEXT NOT NULL,
  capability TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 30000),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('fail_open', 'fail_closed', 'retry_async')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  async_retry_budget_seconds INTEGER NOT NULL
    CHECK (async_retry_budget_seconds BETWEEN 60 AND 604800),
  circuit_breaker_threshold INTEGER NOT NULL CHECK (circuit_breaker_threshold BETWEEN 1 AND 1000),
  circuit_breaker_cooldown_seconds INTEGER NOT NULL
    CHECK (circuit_breaker_cooldown_seconds BETWEEN 1 AND 86400),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version_digest, capability),
  FOREIGN KEY (plugin_id, version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
    ON DELETE CASCADE
);
CREATE TABLE plugin_runner_dynamic_worker_egress_allowed_hosts (
  plugin_id TEXT NOT NULL,
  version_digest TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  match_kind TEXT NOT NULL CHECK (match_kind IN ('exact', 'suffix_wildcard')),
  host_pattern TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version_digest, rule_id),
  FOREIGN KEY (plugin_id, version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
    ON DELETE CASCADE,
  CHECK (host_pattern = lower(host_pattern)),
  CHECK (instr(host_pattern, '/') = 0),
  CHECK (instr(host_pattern, ':') = 0),
  CHECK ((match_kind = 'exact' AND instr(host_pattern, '*') = 0) OR
         (match_kind = 'suffix_wildcard' AND
          substr(host_pattern, 1, 2) = '*.' AND
          instr(substr(host_pattern, 3), '.') > 0))
);
CREATE TABLE plugin_runner_dynamic_worker_credential_slots (
  plugin_id TEXT NOT NULL,
  version_digest TEXT NOT NULL,
  config_key TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  destination_host TEXT NOT NULL,
  injection_kind TEXT NOT NULL CHECK (injection_kind IN ('header', 'bearer')),
  injection_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, version_digest, config_key),
  FOREIGN KEY (plugin_id, version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
    ON DELETE CASCADE,
  CHECK (destination_host = lower(destination_host) AND instr(destination_host, '/') = 0
    AND instr(destination_host, ':') = 0),
  CHECK (injection_name NOT GLOB '*[^A-Za-z0-9-]*' AND length(injection_name) BETWEEN 1 AND 64),
  CHECK ((injection_kind = 'bearer' AND lower(injection_name) = 'authorization') OR
         (injection_kind = 'header' AND lower(injection_name) <> 'authorization'))
);
CREATE TABLE plugin_runner_dynamic_worker_rollouts (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
  plugin_id TEXT NOT NULL,
  target_version_digest TEXT NOT NULL
    CHECK (length(target_version_digest) = 64
      AND target_version_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running', 'completed', 'completed_with_errors', 'blocked')),
  cursor_installation_id TEXT,
  succeeded_count INTEGER NOT NULL DEFAULT 0 CHECK (succeeded_count >= 0),
  blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_until INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_id, target_version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest),
  CHECK ((lease_owner IS NULL AND lease_until IS NULL) OR
         (lease_owner IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE TABLE plugin_runner_dynamic_worker_rollout_results (
  operation_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('succeeded', 'blocked', 'failed')),
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, installation_id),
  FOREIGN KEY (operation_id)
    REFERENCES plugin_runner_dynamic_worker_rollouts(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id)
    REFERENCES plugin_runner_installations(installation_id) ON DELETE CASCADE,
  CHECK ((state = 'succeeded' AND error_code IS NULL) OR
         (state <> 'succeeded' AND error_code IS NOT NULL))
);
CREATE TABLE plugin_runner_dynamic_worker_artifacts (
  artifact_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version_digest TEXT NOT NULL
    CHECK (length(version_digest) = 64 AND version_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'active', 'blocked', 'retired')),
  activated_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (plugin_id, version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest),
  CHECK ((state = 'active' AND activated_at IS NOT NULL) OR
         (state <> 'active' AND activated_at IS NULL))
);
CREATE TABLE plugin_runner_dynamic_worker_resources (
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  logical_resource_id TEXT NOT NULL,
  logical_binding_name TEXT NOT NULL,
  host_binding_ref TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv_namespace', 'r2_bucket')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only', 'read_write')),
  ownership_fingerprint TEXT NOT NULL
    CHECK (length(ownership_fingerprint) = 64
      AND ownership_fingerprint NOT GLOB '*[^0-9a-f]*'),
  control_operation_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, logical_resource_id),
  UNIQUE (host_binding_ref),
  UNIQUE (installation_id, logical_binding_name),
  CHECK (length(installation_id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_id) BETWEEN 1 AND 128
    AND plugin_id GLOB '[a-z0-9]*' AND plugin_id NOT GLOB '*[^a-z0-9._-]*'),
  CHECK (length(logical_resource_id) BETWEEN 1 AND 128
    AND logical_resource_id GLOB '[a-z0-9]*'
    AND logical_resource_id NOT GLOB '*[^a-z0-9._-]*'),
  CHECK (length(logical_binding_name) BETWEEN 1 AND 128
    AND logical_binding_name GLOB '[A-Z]*'
    AND logical_binding_name NOT GLOB '*[^A-Z0-9_]*'),
  CHECK (length(host_binding_ref) = 32
    AND substr(host_binding_ref, 9) NOT GLOB '*[^A-F0-9]*'
    AND ((resource_kind = 'd1' AND host_binding_ref GLOB 'PRES_D1_*')
      OR (resource_kind = 'kv_namespace' AND host_binding_ref GLOB 'PRES_KV_*')
      OR (resource_kind = 'r2_bucket' AND host_binding_ref GLOB 'PRES_R2_*'))),
  CHECK (length(control_operation_id) BETWEEN 1 AND 256)
);
CREATE TABLE plugin_runner_r2_metric_scan_state (
  binding TEXT PRIMARY KEY CHECK (binding = 'PLUGIN_BUNDLES'),
  accumulator_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TRIGGER trg_plugin_runner_notification_route_entry_enabled
BEFORE INSERT ON plugin_runner_notification_route_entries
WHEN NOT EXISTS (
  SELECT 1
    FROM plugin_runner_installations installation
   WHERE installation.tenant_id = NEW.tenant_id
     AND installation.installation_id = NEW.installation_id
     AND installation.state = 'enabled'
)
BEGIN
  SELECT RAISE(ABORT, 'notification_provider_installation_unavailable');
END;
CREATE TRIGGER trg_plugin_runner_dynamic_artifact_installation
BEFORE INSERT ON plugin_runner_dynamic_worker_artifacts
BEGIN
  SELECT RAISE(ABORT, 'plugin_worker_artifact_installation_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_installations
     WHERE installation_id = NEW.installation_id
       AND plugin_id = NEW.plugin_id
       AND backend_kind = 'dynamic_worker'
       AND state <> 'blocked'
  );
  SELECT RAISE(ABORT, 'plugin_worker_artifact_release_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_releases
     WHERE plugin_id = NEW.plugin_id
       AND version_digest = NEW.version_digest
       AND state = 'published'
  );
  SELECT RAISE(ABORT, 'plugin_worker_manifest_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_manifests
     WHERE plugin_id = NEW.plugin_id
       AND active_version_digest = NEW.version_digest
       AND state = 'active'
  );
  SELECT RAISE(ABORT, 'plugin_worker_artifact_active_conflict')
  WHERE NEW.state = 'active' AND EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_artifacts
     WHERE installation_id = NEW.installation_id
       AND state = 'active'
  );
END;
CREATE TRIGGER trg_plugin_runner_dynamic_artifact_activate
BEFORE UPDATE OF state ON plugin_runner_dynamic_worker_artifacts
WHEN NEW.state = 'active'
BEGIN
  SELECT RAISE(ABORT, 'plugin_worker_artifact_active_conflict')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_artifacts
     WHERE installation_id = NEW.installation_id
       AND artifact_id <> NEW.artifact_id
       AND state = 'active'
  );
  SELECT RAISE(ABORT, 'plugin_worker_artifact_release_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_releases
     WHERE plugin_id = NEW.plugin_id
       AND version_digest = NEW.version_digest
       AND state = 'published'
  );
  SELECT RAISE(ABORT, 'plugin_worker_manifest_unavailable')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_manifests
     WHERE plugin_id = NEW.plugin_id
       AND active_version_digest = NEW.version_digest
       AND state = 'active'
  );
END;
CREATE TRIGGER trg_plugin_runner_dynamic_artifact_update
BEFORE UPDATE OF artifact_id, installation_id, plugin_id, version_digest
ON plugin_runner_dynamic_worker_artifacts
BEGIN
  SELECT RAISE(ABORT, 'plugin_worker_artifact_identity_immutable');
END;
CREATE TRIGGER trg_plugin_runner_dynamic_rollout_running_insert
BEFORE INSERT ON plugin_runner_dynamic_worker_rollouts
WHEN NEW.state = 'running'
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_rollout_in_progress')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_rollouts
     WHERE plugin_id = NEW.plugin_id AND state = 'running'
  );
END;
CREATE TRIGGER trg_plugin_runner_dynamic_rollout_running_update
BEFORE UPDATE OF plugin_id, state ON plugin_runner_dynamic_worker_rollouts
WHEN NEW.state = 'running'
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_rollout_in_progress')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_rollouts
     WHERE plugin_id = NEW.plugin_id
       AND state = 'running'
       AND operation_id <> OLD.operation_id
  );
END;
CREATE TRIGGER trg_plugin_runner_dynamic_resource_identity_immutable
BEFORE UPDATE OF installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name,
  host_binding_ref, resource_kind, access_mode, ownership_fingerprint
ON plugin_runner_dynamic_worker_resources
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_resource_identity_immutable');
END;
CREATE TRIGGER trg_plugin_runner_dynamic_resource_operation_fenced
BEFORE UPDATE OF control_operation_id
ON plugin_runner_dynamic_worker_resources
WHEN OLD.control_operation_id <> NEW.control_operation_id
  AND NOT (OLD.state = 'disabled' AND NEW.state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_resource_operation_fenced');
END;
CREATE INDEX idx_plugin_runner_shards_due
  ON plugin_runner_shard_cursors(next_due_at, lease_expires_at);
CREATE UNIQUE INDEX idx_plugin_runner_one_active_sweep
  ON plugin_runner_full_sweep_state(active_sweep_key);
CREATE INDEX idx_plugin_runner_registry_shards_active
  ON plugin_runner_registry_shards(active, tenant_shard_id);
CREATE INDEX idx_plugin_runner_dispatch_leases_scope
  ON plugin_runner_dispatch_leases(
    installation_id, tenant_id, capability, destination_host, lease_expires_at
  );
CREATE INDEX idx_plugin_runner_egress_audit_created
  ON plugin_runner_egress_audit(created_at, audit_id);
CREATE INDEX idx_plugin_runner_circuit_breakers_retry
  ON plugin_runner_circuit_breakers(state, retry_after, probe_until);
CREATE UNIQUE INDEX uq_plugin_runner_installation_tenant_identity
  ON plugin_runner_installations(tenant_id, installation_id);
CREATE INDEX idx_plugin_runner_notification_route_entries_installation
  ON plugin_runner_notification_route_entries(installation_id, tenant_id, channel);
CREATE UNIQUE INDEX idx_plugin_runner_dynamic_credential_target
  ON plugin_runner_dynamic_worker_credential_slots(
    plugin_id, version_digest, destination_host, injection_name
  );
CREATE INDEX idx_plugin_runner_worker_artifact_state
  ON plugin_runner_dynamic_worker_artifacts(installation_id, state);
CREATE UNIQUE INDEX idx_plugin_runner_worker_artifact_version
  ON plugin_runner_dynamic_worker_artifacts(installation_id, version_digest);
CREATE INDEX idx_plugin_runner_dynamic_resource_active
  ON plugin_runner_dynamic_worker_resources(installation_id, tenant_id, state);
CREATE UNIQUE INDEX idx_plugin_runner_pending_activation_request
  ON plugin_runner_installations(pending_activation_request_id);

PRAGMA foreign_keys = ON;
