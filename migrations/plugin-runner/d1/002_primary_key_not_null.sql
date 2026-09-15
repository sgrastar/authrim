CREATE TABLE IF NOT EXISTS authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
);

CREATE TABLE IF NOT EXISTS authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'global',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    );

-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_migrations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_migrations' AND sql IN ('CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)','CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_migrations', (SELECT count(*) FROM "authrim_migrations" WHERE "filename" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_runtime_probes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_runtime_probes' AND sql IN ('CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )','CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_runtime_probes', (SELECT count(*) FROM "authrim_runtime_probes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:migration_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migration_metadata' AND sql IN ('CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)','CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:migration_metadata', (SELECT count(*) FROM "migration_metadata" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_config_key_rotations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_config_key_rotations' AND sql IN ('CREATE TABLE plugin_runner_config_key_rotations (
  operation_id TEXT PRIMARY KEY,
  active_operation_key TEXT NOT NULL,
  from_key_id TEXT NOT NULL,
  to_key_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (''reencrypting'', ''grace'', ''complete'', ''blocked'')),
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
  CHECK ((state IN (''reencrypting'', ''grace'', ''blocked'') AND active_operation_key = ''active'') OR
         (state = ''complete'' AND active_operation_key = ''operation:'' || operation_id)),
  CHECK ((cursor_installation_id IS NULL AND cursor_config_key IS NULL AND
          cursor_config_version IS NULL) OR
         (cursor_installation_id IS NOT NULL AND cursor_config_key IS NOT NULL AND
          cursor_config_version IS NOT NULL)),
  CHECK ((state = ''grace'' AND grace_until IS NOT NULL) OR state <> ''grace''),
  CHECK ((state = ''complete'' AND completed_at IS NOT NULL) OR state <> ''complete'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_config_key_rotations', (SELECT count(*) FROM "plugin_runner_config_key_rotations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_config_mutations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_config_mutations' AND sql IN ('CREATE TABLE plugin_runner_config_mutations (
  operation_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB ''*[^0-9a-f]*'' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB ''*[^a-z0-9._-]*'' AND length(fingerprint_key_id) BETWEEN 1 AND 64),
  target_config_version INTEGER NOT NULL CHECK (target_config_version >= 1),
  state TEXT NOT NULL CHECK (state IN (''applying'', ''applied'')),
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  UNIQUE (installation_id, target_config_version),
  CHECK ((state = ''applying'' AND applied_at IS NULL) OR
         (state = ''applied'' AND applied_at IS NOT NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_config_mutations', (SELECT count(*) FROM "plugin_runner_config_mutations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_dispatch_leases', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_dispatch_leases' AND sql IN ('CREATE TABLE plugin_runner_dispatch_leases (
  lease_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  destination_host TEXT NOT NULL DEFAULT '''',
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_dispatch_leases', (SELECT count(*) FROM "plugin_runner_dispatch_leases" WHERE "lease_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_dynamic_worker_artifacts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_dynamic_worker_artifacts' AND sql IN ('CREATE TABLE plugin_runner_dynamic_worker_artifacts (
  artifact_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  version_digest TEXT NOT NULL
    CHECK (length(version_digest) = 64 AND version_digest NOT GLOB ''*[^0-9a-f]*''),
  state TEXT NOT NULL DEFAULT ''pending''
    CHECK (state IN (''pending'', ''active'', ''blocked'', ''retired'')),
  activated_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  FOREIGN KEY (plugin_id, version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest),
  CHECK ((state = ''active'' AND activated_at IS NOT NULL) OR
         (state <> ''active'' AND activated_at IS NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_dynamic_worker_artifacts', (SELECT count(*) FROM "plugin_runner_dynamic_worker_artifacts" WHERE "artifact_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_dynamic_worker_manifests', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_dynamic_worker_manifests' AND sql IN ('CREATE TABLE plugin_runner_dynamic_worker_manifests (
  plugin_id TEXT PRIMARY KEY,
  active_version_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT ''staging'' CHECK (state IN (''staging'', ''active'', ''revoked'')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_id, active_version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_dynamic_worker_manifests', (SELECT count(*) FROM "plugin_runner_dynamic_worker_manifests" WHERE "plugin_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_dynamic_worker_rollout_results', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_dynamic_worker_rollout_results' AND sql IN ('CREATE TABLE plugin_runner_dynamic_worker_rollout_results (
  operation_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (''succeeded'', ''blocked'', ''failed'')),
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, installation_id),
  FOREIGN KEY (operation_id)
    REFERENCES plugin_runner_dynamic_worker_rollouts(operation_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id)
    REFERENCES plugin_runner_installations(installation_id) ON DELETE CASCADE,
  CHECK ((state = ''succeeded'' AND error_code IS NULL) OR
         (state <> ''succeeded'' AND error_code IS NOT NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_dynamic_worker_rollouts', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_dynamic_worker_rollouts' AND sql IN ('CREATE TABLE plugin_runner_dynamic_worker_rollouts (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256),
  plugin_id TEXT NOT NULL,
  target_version_digest TEXT NOT NULL
    CHECK (length(target_version_digest) = 64
      AND target_version_digest NOT GLOB ''*[^0-9a-f]*''),
  state TEXT NOT NULL DEFAULT ''running''
    CHECK (state IN (''running'', ''completed'', ''completed_with_errors'', ''blocked'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_dynamic_worker_rollouts', (SELECT count(*) FROM "plugin_runner_dynamic_worker_rollouts" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_egress_audit', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_egress_audit' AND sql IN ('CREATE TABLE plugin_runner_egress_audit (
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_egress_audit', (SELECT count(*) FROM "plugin_runner_egress_audit" WHERE "audit_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_encrypted_configs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_encrypted_configs' AND sql IN ('CREATE TABLE "plugin_runner_encrypted_configs" (
  installation_id TEXT NOT NULL,
  config_key TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  injection_kind TEXT NOT NULL
    CHECK (injection_kind IN (''header'', ''bearer'', ''json_field'', ''form_field'')),
  injection_name TEXT NOT NULL,
  destination_host TEXT NOT NULL,
  encryption_key_id TEXT NOT NULL
    CHECK (encryption_key_id NOT GLOB ''*[^a-z0-9._-]*'' AND length(encryption_key_id) BETWEEN 1 AND 64),
  encrypted_value TEXT NOT NULL CHECK (substr(encrypted_value, 1, 7) = ''enc:v1:''),
  nonce_fingerprint TEXT NOT NULL UNIQUE
    CHECK (nonce_fingerprint NOT GLOB ''*[^0-9a-f]*'' AND length(nonce_fingerprint) = 64),
  reencrypt_state TEXT NOT NULL DEFAULT ''current''
    CHECK (reencrypt_state IN (''current'', ''pending'', ''verified'')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, config_key, config_version),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  CHECK (injection_name NOT GLOB ''*[^A-Za-z0-9_.-]*'' AND length(injection_name) BETWEEN 1 AND 64),
  CHECK (destination_host = lower(destination_host) AND instr(destination_host, ''/'') = 0
    AND instr(destination_host, '':'') = 0),
  CHECK ((injection_kind = ''bearer'' AND lower(injection_name) = ''authorization'') OR
         injection_kind <> ''bearer'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_full_sweep_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_full_sweep_state' AND sql IN ('CREATE TABLE plugin_runner_full_sweep_state (
  sweep_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (''pending'', ''running'', ''completed'', ''failed'')),
  active_sweep_key TEXT NOT NULL,
  started_at INTEGER,
  target_completed_at INTEGER,
  completed_at INTEGER,
  cursor_json TEXT NOT NULL DEFAULT ''{}'',
  scanned_shard_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_shard_count >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state IN (''pending'', ''running'') AND active_sweep_key = ''active'') OR
         (state IN (''completed'', ''failed'') AND active_sweep_key = ''sweep:'' || sweep_id))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_full_sweep_state', (SELECT count(*) FROM "plugin_runner_full_sweep_state" WHERE "sweep_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_human_verification_configs', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_human_verification_configs' AND sql IN ('CREATE TABLE plugin_runner_human_verification_configs (
  installation_id TEXT NOT NULL,
  config_version INTEGER NOT NULL CHECK (config_version >= 1),
  provider TEXT NOT NULL CHECK (provider IN (''turnstile'', ''hcaptcha'', ''recaptcha'')),
  site_key TEXT NOT NULL CHECK (length(site_key) BETWEEN 1 AND 2048),
  expected_hostname TEXT,
  widget_mode TEXT NOT NULL CHECK (widget_mode IN (''managed'', ''checkbox'', ''invisible'', ''score'')),
  score_threshold REAL NOT NULL CHECK (score_threshold >= 0 AND score_threshold <= 1),
  config_fingerprint TEXT NOT NULL
    CHECK (config_fingerprint NOT GLOB ''*[^0-9a-f]*'' AND length(config_fingerprint) = 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, config_version),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE,
  CHECK (expected_hostname IS NULL OR (
    expected_hostname = lower(expected_hostname) AND
    length(expected_hostname) BETWEEN 1 AND 253 AND
    instr(expected_hostname, ''/'') = 0 AND instr(expected_hostname, '':'') = 0
  ))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_installation_mutation_scopes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_installation_mutation_scopes' AND sql IN ('CREATE TABLE plugin_runner_installation_mutation_scopes (
  installation_id TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = ''account.metadata.write''),
  state TEXT NOT NULL DEFAULT ''disabled'' CHECK (state IN (''disabled'', ''enabled'')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, mutation_scope),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_installations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_installations' AND sql IN ('CREATE TABLE plugin_runner_installations (
  installation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  backend_kind TEXT NOT NULL CHECK (backend_kind IN (''dynamic_worker'', ''in_process'')),
  script_name TEXT,
  state TEXT NOT NULL DEFAULT ''disabled'' CHECK (state IN (''disabled'', ''enabled'', ''blocked'')),
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
        pending_activation_request_id NOT GLOB ''*[^A-Za-z0-9._:-]*''
      )
    ),
  UNIQUE (tenant_id, plugin_id),
  CHECK ((backend_kind = ''dynamic_worker'' AND script_name IS NOT NULL) OR
         (backend_kind = ''in_process'' AND script_name IS NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_installations', (SELECT count(*) FROM "plugin_runner_installations" WHERE "installation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_notification_route_entries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_notification_route_entries' AND sql IN ('CREATE TABLE plugin_runner_notification_route_entries (
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN (''email'', ''sms'', ''push'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_r2_metric_scan_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_r2_metric_scan_state' AND sql IN ('CREATE TABLE plugin_runner_r2_metric_scan_state (
  binding TEXT PRIMARY KEY CHECK (binding = ''PLUGIN_BUNDLES''),
  accumulator_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_r2_metric_scan_state', (SELECT count(*) FROM "plugin_runner_r2_metric_scan_state" WHERE "binding" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_rate_limit_buckets', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_rate_limit_buckets' AND sql IN ('CREATE TABLE plugin_runner_rate_limit_buckets (
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  destination_host TEXT NOT NULL DEFAULT '''',
  window_started_at INTEGER NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, tenant_id, capability, destination_host),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_registry_shards', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_registry_shards' AND sql IN ('CREATE TABLE plugin_runner_registry_shards (
  tenant_shard_id TEXT PRIMARY KEY,
  binding_ref TEXT NOT NULL UNIQUE,
  data_role TEXT NOT NULL CHECK (data_role IN (''tenant_core/default'', ''tenant_core/users'')),
  residency_partition TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  registry_generation INTEGER NOT NULL CHECK (registry_generation >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_registry_shards', (SELECT count(*) FROM "plugin_runner_registry_shards" WHERE "tenant_shard_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_registry_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_registry_state' AND sql IN ('CREATE TABLE plugin_runner_registry_state (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = ''active''),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_registry_state', (SELECT count(*) FROM "plugin_runner_registry_state" WHERE "singleton_key" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:plugin_runner_shard_cursors', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='plugin_runner_shard_cursors' AND sql IN ('CREATE TABLE plugin_runner_shard_cursors (
  tenant_shard_id TEXT PRIMARY KEY,
  next_due_at INTEGER,
  last_scan_at INTEGER,
  last_generation INTEGER NOT NULL DEFAULT 0 CHECK (last_generation >= 0),
  cursor_json TEXT NOT NULL DEFAULT ''{}'',
  scheduler_error_code TEXT,
  consecutive_error_count INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_error_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:plugin_runner_shard_cursors', (SELECT count(*) FROM "plugin_runner_shard_cursors" WHERE "tenant_shard_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_database_migration_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_database_migration_state' AND sql IN ('CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )','CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_database_migration_state', (SELECT count(*) FROM "tenant_database_migration_state" WHERE "stream_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_dispatch_leases_scope', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_dispatch_leases_scope' AND sql='CREATE INDEX idx_plugin_runner_dispatch_leases_scope
  ON plugin_runner_dispatch_leases(
    installation_id, tenant_id, capability, destination_host, lease_expires_at
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_egress_audit_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_egress_audit_created' AND sql='CREATE INDEX idx_plugin_runner_egress_audit_created
  ON plugin_runner_egress_audit(created_at, audit_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_notification_route_entries_installation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_notification_route_entries_installation' AND sql='CREATE INDEX idx_plugin_runner_notification_route_entries_installation
  ON plugin_runner_notification_route_entries(installation_id, tenant_id, channel)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_one_active_sweep', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_one_active_sweep' AND sql='CREATE UNIQUE INDEX idx_plugin_runner_one_active_sweep
  ON plugin_runner_full_sweep_state(active_sweep_key)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_pending_activation_request', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_pending_activation_request' AND sql='CREATE UNIQUE INDEX idx_plugin_runner_pending_activation_request
  ON plugin_runner_installations(pending_activation_request_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_registry_shards_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_registry_shards_active' AND sql='CREATE INDEX idx_plugin_runner_registry_shards_active
  ON plugin_runner_registry_shards(active, tenant_shard_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_shards_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_shards_due' AND sql='CREATE INDEX idx_plugin_runner_shards_due
  ON plugin_runner_shard_cursors(next_due_at, lease_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_worker_artifact_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_worker_artifact_state' AND sql='CREATE INDEX idx_plugin_runner_worker_artifact_state
  ON plugin_runner_dynamic_worker_artifacts(installation_id, state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_plugin_runner_worker_artifact_version', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_plugin_runner_worker_artifact_version' AND sql='CREATE UNIQUE INDEX idx_plugin_runner_worker_artifact_version
  ON plugin_runner_dynamic_worker_artifacts(installation_id, version_digest)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:uq_plugin_runner_installation_tenant_identity', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='uq_plugin_runner_installation_tenant_identity' AND sql='CREATE UNIQUE INDEX uq_plugin_runner_installation_tenant_identity
  ON plugin_runner_installations(tenant_id, installation_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_runner_dynamic_artifact_activate', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_runner_dynamic_artifact_activate' AND sql='CREATE TRIGGER trg_plugin_runner_dynamic_artifact_activate
BEFORE UPDATE OF state ON plugin_runner_dynamic_worker_artifacts
WHEN NEW.state = ''active''
BEGIN
  SELECT RAISE(ABORT, ''plugin_worker_artifact_active_conflict'')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_artifacts
     WHERE installation_id = NEW.installation_id
       AND artifact_id <> NEW.artifact_id
       AND state = ''active''
  );
  SELECT RAISE(ABORT, ''plugin_worker_artifact_release_unavailable'')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_releases
     WHERE plugin_id = NEW.plugin_id
       AND version_digest = NEW.version_digest
       AND state = ''published''
  );
  SELECT RAISE(ABORT, ''plugin_worker_manifest_unavailable'')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_manifests
     WHERE plugin_id = NEW.plugin_id
       AND active_version_digest = NEW.version_digest
       AND state = ''active''
  );
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_runner_dynamic_artifact_installation', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_runner_dynamic_artifact_installation' AND sql='CREATE TRIGGER trg_plugin_runner_dynamic_artifact_installation
BEFORE INSERT ON plugin_runner_dynamic_worker_artifacts
BEGIN
  SELECT RAISE(ABORT, ''plugin_worker_artifact_installation_mismatch'')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_installations
     WHERE installation_id = NEW.installation_id
       AND plugin_id = NEW.plugin_id
       AND backend_kind = ''dynamic_worker''
       AND state <> ''blocked''
  );
  SELECT RAISE(ABORT, ''plugin_worker_artifact_release_unavailable'')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_releases
     WHERE plugin_id = NEW.plugin_id
       AND version_digest = NEW.version_digest
       AND state = ''published''
  );
  SELECT RAISE(ABORT, ''plugin_worker_manifest_unavailable'')
  WHERE NOT EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_manifests
     WHERE plugin_id = NEW.plugin_id
       AND active_version_digest = NEW.version_digest
       AND state = ''active''
  );
  SELECT RAISE(ABORT, ''plugin_worker_artifact_active_conflict'')
  WHERE NEW.state = ''active'' AND EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_artifacts
     WHERE installation_id = NEW.installation_id
       AND state = ''active''
  );
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_runner_dynamic_artifact_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_runner_dynamic_artifact_update' AND sql='CREATE TRIGGER trg_plugin_runner_dynamic_artifact_update
BEFORE UPDATE OF artifact_id, installation_id, plugin_id, version_digest
ON plugin_runner_dynamic_worker_artifacts
BEGIN
  SELECT RAISE(ABORT, ''plugin_worker_artifact_identity_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_runner_dynamic_rollout_running_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_runner_dynamic_rollout_running_insert' AND sql='CREATE TRIGGER trg_plugin_runner_dynamic_rollout_running_insert
BEFORE INSERT ON plugin_runner_dynamic_worker_rollouts
WHEN NEW.state = ''running''
BEGIN
  SELECT RAISE(ABORT, ''plugin_dynamic_rollout_in_progress'')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_rollouts
     WHERE plugin_id = NEW.plugin_id AND state = ''running''
  );
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_runner_dynamic_rollout_running_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_runner_dynamic_rollout_running_update' AND sql='CREATE TRIGGER trg_plugin_runner_dynamic_rollout_running_update
BEFORE UPDATE OF plugin_id, state ON plugin_runner_dynamic_worker_rollouts
WHEN NEW.state = ''running''
BEGIN
  SELECT RAISE(ABORT, ''plugin_dynamic_rollout_in_progress'')
  WHERE EXISTS (
    SELECT 1 FROM plugin_runner_dynamic_worker_rollouts
     WHERE plugin_id = NEW.plugin_id
       AND state = ''running''
       AND operation_id <> OLD.operation_id
  );
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_plugin_runner_notification_route_entry_enabled', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_plugin_runner_notification_route_entry_enabled' AND sql='CREATE TRIGGER trg_plugin_runner_notification_route_entry_enabled
BEFORE INSERT ON plugin_runner_notification_route_entries
WHEN NOT EXISTS (
  SELECT 1
    FROM plugin_runner_installations installation
   WHERE installation.tenant_id = NEW.tenant_id
     AND installation.installation_id = NEW.installation_id
     AND installation.state = ''enabled''
)
BEGIN
  SELECT RAISE(ABORT, ''notification_provider_installation_unavailable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('authrim_migrations','authrim_runtime_probes','migration_metadata','plugin_runner_config_key_rotations','plugin_runner_config_mutations','plugin_runner_dispatch_leases','plugin_runner_dynamic_worker_artifacts','plugin_runner_dynamic_worker_manifests','plugin_runner_dynamic_worker_rollout_results','plugin_runner_dynamic_worker_rollouts','plugin_runner_egress_audit','plugin_runner_encrypted_configs','plugin_runner_full_sweep_state','plugin_runner_human_verification_configs','plugin_runner_installation_mutation_scopes','plugin_runner_installations','plugin_runner_notification_route_entries','plugin_runner_r2_metric_scan_state','plugin_runner_rate_limit_buckets','plugin_runner_registry_shards','plugin_runner_registry_state','plugin_runner_shard_cursors','tenant_database_migration_state'))) AND name NOT IN ('idx_plugin_runner_dispatch_leases_scope','idx_plugin_runner_egress_audit_created','idx_plugin_runner_notification_route_entries_installation','idx_plugin_runner_one_active_sweep','idx_plugin_runner_pending_activation_request','idx_plugin_runner_registry_shards_active','idx_plugin_runner_shards_due','idx_plugin_runner_worker_artifact_state','idx_plugin_runner_worker_artifact_version','uq_plugin_runner_installation_tenant_identity','trg_plugin_runner_dynamic_artifact_activate','trg_plugin_runner_dynamic_artifact_installation','trg_plugin_runner_dynamic_artifact_update','trg_plugin_runner_dynamic_rollout_running_insert','trg_plugin_runner_dynamic_rollout_running_update','trg_plugin_runner_notification_route_entry_enabled')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('authrim_migrations','authrim_runtime_probes','migration_metadata','plugin_runner_config_key_rotations','plugin_runner_config_mutations','plugin_runner_dispatch_leases','plugin_runner_dynamic_worker_artifacts','plugin_runner_dynamic_worker_manifests','plugin_runner_dynamic_worker_rollout_results','plugin_runner_dynamic_worker_rollouts','plugin_runner_egress_audit','plugin_runner_encrypted_configs','plugin_runner_full_sweep_state','plugin_runner_human_verification_configs','plugin_runner_installation_mutation_scopes','plugin_runner_installations','plugin_runner_notification_route_entries','plugin_runner_r2_metric_scan_state','plugin_runner_rate_limit_buckets','plugin_runner_registry_shards','plugin_runner_registry_state','plugin_runner_shard_cursors','tenant_database_migration_state')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('authrim_migrations','authrim_runtime_probes','migration_metadata','plugin_runner_config_key_rotations','plugin_runner_config_mutations','plugin_runner_dispatch_leases','plugin_runner_dynamic_worker_artifacts','plugin_runner_dynamic_worker_manifests','plugin_runner_dynamic_worker_rollout_results','plugin_runner_dynamic_worker_rollouts','plugin_runner_egress_audit','plugin_runner_encrypted_configs','plugin_runner_full_sweep_state','plugin_runner_human_verification_configs','plugin_runner_installation_mutation_scopes','plugin_runner_installations','plugin_runner_notification_route_entries','plugin_runner_r2_metric_scan_state','plugin_runner_rate_limit_buckets','plugin_runner_registry_shards','plugin_runner_registry_state','plugin_runner_shard_cursors','tenant_database_migration_state')));

CREATE TABLE "__authrim_pk_copy_authrim_migrations" AS SELECT "rowid" AS "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "authrim_migrations";

CREATE TABLE "__authrim_pk_copy_authrim_runtime_probes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "authrim_runtime_probes";

CREATE TABLE "__authrim_pk_copy_migration_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "migration_metadata";

CREATE TABLE "__authrim_pk_copy_plugin_runner_config_key_rotations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","active_operation_key","from_key_id","to_key_id","state","cursor_installation_id","cursor_config_key","cursor_config_version","source_count","reencrypted_count","grace_until","last_error_code","created_at","updated_at","completed_at" FROM "plugin_runner_config_key_rotations";

CREATE TABLE "__authrim_pk_copy_plugin_runner_config_mutations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","installation_id","tenant_id","request_fingerprint","fingerprint_key_id","target_config_version","state","created_at","applied_at","updated_at" FROM "plugin_runner_config_mutations";

CREATE TABLE "__authrim_pk_copy_plugin_runner_dispatch_leases" AS SELECT "rowid" AS "__authrim_original_rowid","lease_id","installation_id","tenant_id","capability","destination_host","lease_expires_at","created_at" FROM "plugin_runner_dispatch_leases";

CREATE TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_artifacts" AS SELECT "rowid" AS "__authrim_original_rowid","artifact_id","installation_id","plugin_id","version_digest","state","activated_at","updated_at" FROM "plugin_runner_dynamic_worker_artifacts";

CREATE TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_manifests" AS SELECT "rowid" AS "__authrim_original_rowid","plugin_id","active_version_digest","state","updated_at" FROM "plugin_runner_dynamic_worker_manifests";

CREATE TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_rollout_results" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","installation_id","tenant_id","state","error_code","updated_at" FROM "plugin_runner_dynamic_worker_rollout_results";

CREATE TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_rollouts" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","plugin_id","target_version_digest","state","cursor_installation_id","succeeded_count","blocked_count","failed_count","lease_owner","lease_fence","lease_until","last_error_code","created_at","updated_at" FROM "plugin_runner_dynamic_worker_rollouts";

CREATE TABLE "__authrim_pk_copy_plugin_runner_egress_audit" AS SELECT "rowid" AS "__authrim_original_rowid","audit_id","installation_id","tenant_id","request_id","capability","destination_host","credential_injected","result_code","created_at","updated_at" FROM "plugin_runner_egress_audit";

CREATE TABLE "__authrim_pk_copy_plugin_runner_encrypted_configs" AS SELECT "rowid" AS "__authrim_original_rowid","installation_id","config_key","config_version","injection_kind","injection_name","destination_host","encryption_key_id","encrypted_value","nonce_fingerprint","reencrypt_state","created_at","updated_at" FROM "plugin_runner_encrypted_configs";

CREATE TABLE "__authrim_pk_copy_plugin_runner_full_sweep_state" AS SELECT "rowid" AS "__authrim_original_rowid","sweep_id","state","active_sweep_key","started_at","target_completed_at","completed_at","cursor_json","scanned_shard_count","error_code","created_at","updated_at" FROM "plugin_runner_full_sweep_state";

CREATE TABLE "__authrim_pk_copy_plugin_runner_human_verification_configs" AS SELECT "rowid" AS "__authrim_original_rowid","installation_id","config_version","provider","site_key","expected_hostname","widget_mode","score_threshold","config_fingerprint","created_at","updated_at" FROM "plugin_runner_human_verification_configs";

CREATE TABLE "__authrim_pk_copy_plugin_runner_installation_mutation_scopes" AS SELECT "rowid" AS "__authrim_original_rowid","installation_id","mutation_scope","state","updated_at" FROM "plugin_runner_installation_mutation_scopes";

CREATE TABLE "__authrim_pk_copy_plugin_runner_installations" AS SELECT "rowid" AS "__authrim_original_rowid","installation_id","tenant_id","plugin_id","backend_kind","script_name","state","config_version","platform_concurrency_cap","platform_rate_per_minute","created_at","updated_at","pending_activation_request_id" FROM "plugin_runner_installations";

CREATE TABLE "__authrim_pk_copy_plugin_runner_notification_route_entries" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_id","channel","config_version","priority","installation_id","created_at" FROM "plugin_runner_notification_route_entries";

CREATE TABLE "__authrim_pk_copy_plugin_runner_r2_metric_scan_state" AS SELECT "rowid" AS "__authrim_original_rowid","binding","accumulator_json","updated_at" FROM "plugin_runner_r2_metric_scan_state";

CREATE TABLE "__authrim_pk_copy_plugin_runner_rate_limit_buckets" AS SELECT "rowid" AS "__authrim_original_rowid","installation_id","tenant_id","capability","destination_host","window_started_at","used_count","updated_at" FROM "plugin_runner_rate_limit_buckets";

CREATE TABLE "__authrim_pk_copy_plugin_runner_registry_shards" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_shard_id","binding_ref","data_role","residency_partition","route_generation","registry_generation","active","updated_at" FROM "plugin_runner_registry_shards";

CREATE TABLE "__authrim_pk_copy_plugin_runner_registry_state" AS SELECT "rowid" AS "__authrim_original_rowid","singleton_key","active_generation","pending_generation","pending_cursor","pending_shard_count","sweep_started_at","sweep_completed_at","sweep_overdue","last_error_code","updated_at" FROM "plugin_runner_registry_state";

CREATE TABLE "__authrim_pk_copy_plugin_runner_shard_cursors" AS SELECT "rowid" AS "__authrim_original_rowid","tenant_shard_id","next_due_at","last_scan_at","last_generation","cursor_json","scheduler_error_code","consecutive_error_count","lease_owner","lease_expires_at","fencing_token","updated_at" FROM "plugin_runner_shard_cursors";

CREATE TABLE "__authrim_pk_copy_tenant_database_migration_state" AS SELECT "rowid" AS "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "tenant_database_migration_state";

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "trg_plugin_runner_dynamic_artifact_activate";

DROP TRIGGER "trg_plugin_runner_dynamic_artifact_installation";

DROP TRIGGER "trg_plugin_runner_dynamic_artifact_update";

DROP TRIGGER "trg_plugin_runner_dynamic_rollout_running_insert";

DROP TRIGGER "trg_plugin_runner_dynamic_rollout_running_update";

DROP TRIGGER "trg_plugin_runner_notification_route_entry_enabled";

DROP TABLE "authrim_migrations";

DROP TABLE "authrim_runtime_probes";

DROP TABLE "migration_metadata";

DROP TABLE "plugin_runner_config_key_rotations";

DROP TABLE "plugin_runner_config_mutations";

DROP TABLE "plugin_runner_dispatch_leases";

DROP TABLE "plugin_runner_dynamic_worker_artifacts";

DROP TABLE "plugin_runner_dynamic_worker_manifests";

DROP TABLE "plugin_runner_dynamic_worker_rollout_results";

DROP TABLE "plugin_runner_egress_audit";

DROP TABLE "plugin_runner_encrypted_configs";

DROP TABLE "plugin_runner_full_sweep_state";

DROP TABLE "plugin_runner_human_verification_configs";

DROP TABLE "plugin_runner_installation_mutation_scopes";

DROP TABLE "plugin_runner_notification_route_entries";

DROP TABLE "plugin_runner_r2_metric_scan_state";

DROP TABLE "plugin_runner_rate_limit_buckets";

DROP TABLE "plugin_runner_registry_shards";

DROP TABLE "plugin_runner_registry_state";

DROP TABLE "plugin_runner_shard_cursors";

DROP TABLE "tenant_database_migration_state";

DROP TABLE "plugin_runner_dynamic_worker_rollouts";

DROP TABLE "plugin_runner_installations";

CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY
 NOT NULL
,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
);

CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global'
 NOT NULL
,
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

CREATE TABLE plugin_runner_config_key_rotations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE plugin_runner_config_mutations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE plugin_runner_dispatch_leases (
  lease_id TEXT PRIMARY KEY
 NOT NULL
,
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  destination_host TEXT NOT NULL DEFAULT '',
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);

CREATE TABLE plugin_runner_dynamic_worker_artifacts (
  artifact_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE plugin_runner_dynamic_worker_manifests (
  plugin_id TEXT PRIMARY KEY
 NOT NULL
,
  active_version_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'active', 'revoked')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_id, active_version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
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

CREATE TABLE plugin_runner_dynamic_worker_rollouts (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 256)
 NOT NULL
,
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

CREATE TABLE plugin_runner_egress_audit (
  audit_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE "plugin_runner_encrypted_configs" (
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

CREATE TABLE plugin_runner_full_sweep_state (
  sweep_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE plugin_runner_installation_mutation_scopes (
  installation_id TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, mutation_scope),
  FOREIGN KEY (installation_id) REFERENCES plugin_runner_installations(installation_id)
    ON DELETE CASCADE
);

CREATE TABLE plugin_runner_installations (
  installation_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE plugin_runner_r2_metric_scan_state (
  binding TEXT PRIMARY KEY CHECK (binding = 'PLUGIN_BUNDLES')
 NOT NULL
,
  accumulator_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
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

CREATE TABLE plugin_runner_registry_shards (
  tenant_shard_id TEXT PRIMARY KEY
 NOT NULL
,
  binding_ref TEXT NOT NULL UNIQUE,
  data_role TEXT NOT NULL CHECK (data_role IN ('tenant_core/default', 'tenant_core/users')),
  residency_partition TEXT NOT NULL,
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  registry_generation INTEGER NOT NULL CHECK (registry_generation >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE plugin_runner_registry_state (
  singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'active')
 NOT NULL
,
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

CREATE TABLE plugin_runner_shard_cursors (
  tenant_shard_id TEXT PRIMARY KEY
 NOT NULL
,
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

CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY
 NOT NULL
,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    );

CREATE INDEX idx_plugin_runner_dispatch_leases_scope
  ON plugin_runner_dispatch_leases(
    installation_id, tenant_id, capability, destination_host, lease_expires_at
  );

CREATE INDEX idx_plugin_runner_egress_audit_created
  ON plugin_runner_egress_audit(created_at, audit_id);

CREATE INDEX idx_plugin_runner_notification_route_entries_installation
  ON plugin_runner_notification_route_entries(installation_id, tenant_id, channel);

CREATE UNIQUE INDEX idx_plugin_runner_one_active_sweep
  ON plugin_runner_full_sweep_state(active_sweep_key);

CREATE UNIQUE INDEX idx_plugin_runner_pending_activation_request
  ON plugin_runner_installations(pending_activation_request_id);

CREATE INDEX idx_plugin_runner_registry_shards_active
  ON plugin_runner_registry_shards(active, tenant_shard_id);

CREATE INDEX idx_plugin_runner_shards_due
  ON plugin_runner_shard_cursors(next_due_at, lease_expires_at);

CREATE INDEX idx_plugin_runner_worker_artifact_state
  ON plugin_runner_dynamic_worker_artifacts(installation_id, state);

CREATE UNIQUE INDEX idx_plugin_runner_worker_artifact_version
  ON plugin_runner_dynamic_worker_artifacts(installation_id, version_digest);

CREATE UNIQUE INDEX uq_plugin_runner_installation_tenant_identity
  ON plugin_runner_installations(tenant_id, installation_id);

INSERT INTO "authrim_migrations" ("rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version") SELECT "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "__authrim_pk_copy_authrim_migrations";

INSERT INTO "authrim_runtime_probes" ("rowid","id","tenant_id","role","probe_kind","nonce","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "__authrim_pk_copy_authrim_runtime_probes";

INSERT INTO "migration_metadata" ("rowid","id","current_version","last_migration_at","environment","metadata_json") SELECT "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "__authrim_pk_copy_migration_metadata";

INSERT INTO "plugin_runner_config_key_rotations" ("rowid","operation_id","active_operation_key","from_key_id","to_key_id","state","cursor_installation_id","cursor_config_key","cursor_config_version","source_count","reencrypted_count","grace_until","last_error_code","created_at","updated_at","completed_at") SELECT "__authrim_original_rowid","operation_id","active_operation_key","from_key_id","to_key_id","state","cursor_installation_id","cursor_config_key","cursor_config_version","source_count","reencrypted_count","grace_until","last_error_code","created_at","updated_at","completed_at" FROM "__authrim_pk_copy_plugin_runner_config_key_rotations";

INSERT INTO "plugin_runner_config_mutations" ("rowid","operation_id","installation_id","tenant_id","request_fingerprint","fingerprint_key_id","target_config_version","state","created_at","applied_at","updated_at") SELECT "__authrim_original_rowid","operation_id","installation_id","tenant_id","request_fingerprint","fingerprint_key_id","target_config_version","state","created_at","applied_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_config_mutations";

INSERT INTO "plugin_runner_dispatch_leases" ("rowid","lease_id","installation_id","tenant_id","capability","destination_host","lease_expires_at","created_at") SELECT "__authrim_original_rowid","lease_id","installation_id","tenant_id","capability","destination_host","lease_expires_at","created_at" FROM "__authrim_pk_copy_plugin_runner_dispatch_leases";

INSERT INTO "plugin_runner_dynamic_worker_artifacts" ("rowid","artifact_id","installation_id","plugin_id","version_digest","state","activated_at","updated_at") SELECT "__authrim_original_rowid","artifact_id","installation_id","plugin_id","version_digest","state","activated_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_dynamic_worker_artifacts";

INSERT INTO "plugin_runner_dynamic_worker_manifests" ("rowid","plugin_id","active_version_digest","state","updated_at") SELECT "__authrim_original_rowid","plugin_id","active_version_digest","state","updated_at" FROM "__authrim_pk_copy_plugin_runner_dynamic_worker_manifests";

INSERT INTO "plugin_runner_dynamic_worker_rollout_results" ("rowid","operation_id","installation_id","tenant_id","state","error_code","updated_at") SELECT "__authrim_original_rowid","operation_id","installation_id","tenant_id","state","error_code","updated_at" FROM "__authrim_pk_copy_plugin_runner_dynamic_worker_rollout_results";

INSERT INTO "plugin_runner_dynamic_worker_rollouts" ("rowid","operation_id","plugin_id","target_version_digest","state","cursor_installation_id","succeeded_count","blocked_count","failed_count","lease_owner","lease_fence","lease_until","last_error_code","created_at","updated_at") SELECT "__authrim_original_rowid","operation_id","plugin_id","target_version_digest","state","cursor_installation_id","succeeded_count","blocked_count","failed_count","lease_owner","lease_fence","lease_until","last_error_code","created_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_dynamic_worker_rollouts";

INSERT INTO "plugin_runner_egress_audit" ("rowid","audit_id","installation_id","tenant_id","request_id","capability","destination_host","credential_injected","result_code","created_at","updated_at") SELECT "__authrim_original_rowid","audit_id","installation_id","tenant_id","request_id","capability","destination_host","credential_injected","result_code","created_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_egress_audit";

INSERT INTO "plugin_runner_encrypted_configs" ("rowid","installation_id","config_key","config_version","injection_kind","injection_name","destination_host","encryption_key_id","encrypted_value","nonce_fingerprint","reencrypt_state","created_at","updated_at") SELECT "__authrim_original_rowid","installation_id","config_key","config_version","injection_kind","injection_name","destination_host","encryption_key_id","encrypted_value","nonce_fingerprint","reencrypt_state","created_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_encrypted_configs";

INSERT INTO "plugin_runner_full_sweep_state" ("rowid","sweep_id","state","active_sweep_key","started_at","target_completed_at","completed_at","cursor_json","scanned_shard_count","error_code","created_at","updated_at") SELECT "__authrim_original_rowid","sweep_id","state","active_sweep_key","started_at","target_completed_at","completed_at","cursor_json","scanned_shard_count","error_code","created_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_full_sweep_state";

INSERT INTO "plugin_runner_human_verification_configs" ("rowid","installation_id","config_version","provider","site_key","expected_hostname","widget_mode","score_threshold","config_fingerprint","created_at","updated_at") SELECT "__authrim_original_rowid","installation_id","config_version","provider","site_key","expected_hostname","widget_mode","score_threshold","config_fingerprint","created_at","updated_at" FROM "__authrim_pk_copy_plugin_runner_human_verification_configs";

INSERT INTO "plugin_runner_installation_mutation_scopes" ("rowid","installation_id","mutation_scope","state","updated_at") SELECT "__authrim_original_rowid","installation_id","mutation_scope","state","updated_at" FROM "__authrim_pk_copy_plugin_runner_installation_mutation_scopes";

INSERT INTO "plugin_runner_installations" ("rowid","installation_id","tenant_id","plugin_id","backend_kind","script_name","state","config_version","platform_concurrency_cap","platform_rate_per_minute","created_at","updated_at","pending_activation_request_id") SELECT "__authrim_original_rowid","installation_id","tenant_id","plugin_id","backend_kind","script_name","state","config_version","platform_concurrency_cap","platform_rate_per_minute","created_at","updated_at","pending_activation_request_id" FROM "__authrim_pk_copy_plugin_runner_installations";

INSERT INTO "plugin_runner_notification_route_entries" ("rowid","tenant_id","channel","config_version","priority","installation_id","created_at") SELECT "__authrim_original_rowid","tenant_id","channel","config_version","priority","installation_id","created_at" FROM "__authrim_pk_copy_plugin_runner_notification_route_entries";

INSERT INTO "plugin_runner_r2_metric_scan_state" ("rowid","binding","accumulator_json","updated_at") SELECT "__authrim_original_rowid","binding","accumulator_json","updated_at" FROM "__authrim_pk_copy_plugin_runner_r2_metric_scan_state";

INSERT INTO "plugin_runner_rate_limit_buckets" ("rowid","installation_id","tenant_id","capability","destination_host","window_started_at","used_count","updated_at") SELECT "__authrim_original_rowid","installation_id","tenant_id","capability","destination_host","window_started_at","used_count","updated_at" FROM "__authrim_pk_copy_plugin_runner_rate_limit_buckets";

INSERT INTO "plugin_runner_registry_shards" ("rowid","tenant_shard_id","binding_ref","data_role","residency_partition","route_generation","registry_generation","active","updated_at") SELECT "__authrim_original_rowid","tenant_shard_id","binding_ref","data_role","residency_partition","route_generation","registry_generation","active","updated_at" FROM "__authrim_pk_copy_plugin_runner_registry_shards";

INSERT INTO "plugin_runner_registry_state" ("rowid","singleton_key","active_generation","pending_generation","pending_cursor","pending_shard_count","sweep_started_at","sweep_completed_at","sweep_overdue","last_error_code","updated_at") SELECT "__authrim_original_rowid","singleton_key","active_generation","pending_generation","pending_cursor","pending_shard_count","sweep_started_at","sweep_completed_at","sweep_overdue","last_error_code","updated_at" FROM "__authrim_pk_copy_plugin_runner_registry_state";

INSERT INTO "plugin_runner_shard_cursors" ("rowid","tenant_shard_id","next_due_at","last_scan_at","last_generation","cursor_json","scheduler_error_code","consecutive_error_count","lease_owner","lease_expires_at","fencing_token","updated_at") SELECT "__authrim_original_rowid","tenant_shard_id","next_due_at","last_scan_at","last_generation","cursor_json","scheduler_error_code","consecutive_error_count","lease_owner","lease_expires_at","fencing_token","updated_at" FROM "__authrim_pk_copy_plugin_runner_shard_cursors";

INSERT INTO "tenant_database_migration_state" ("rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at") SELECT "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "__authrim_pk_copy_tenant_database_migration_state";

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

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_authrim_migrations";

DROP TABLE "__authrim_pk_copy_authrim_runtime_probes";

DROP TABLE "__authrim_pk_copy_migration_metadata";

DROP TABLE "__authrim_pk_copy_plugin_runner_config_key_rotations";

DROP TABLE "__authrim_pk_copy_plugin_runner_config_mutations";

DROP TABLE "__authrim_pk_copy_plugin_runner_dispatch_leases";

DROP TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_artifacts";

DROP TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_manifests";

DROP TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_rollout_results";

DROP TABLE "__authrim_pk_copy_plugin_runner_dynamic_worker_rollouts";

DROP TABLE "__authrim_pk_copy_plugin_runner_egress_audit";

DROP TABLE "__authrim_pk_copy_plugin_runner_encrypted_configs";

DROP TABLE "__authrim_pk_copy_plugin_runner_full_sweep_state";

DROP TABLE "__authrim_pk_copy_plugin_runner_human_verification_configs";

DROP TABLE "__authrim_pk_copy_plugin_runner_installation_mutation_scopes";

DROP TABLE "__authrim_pk_copy_plugin_runner_installations";

DROP TABLE "__authrim_pk_copy_plugin_runner_notification_route_entries";

DROP TABLE "__authrim_pk_copy_plugin_runner_r2_metric_scan_state";

DROP TABLE "__authrim_pk_copy_plugin_runner_rate_limit_buckets";

DROP TABLE "__authrim_pk_copy_plugin_runner_registry_shards";

DROP TABLE "__authrim_pk_copy_plugin_runner_registry_state";

DROP TABLE "__authrim_pk_copy_plugin_runner_shard_cursors";

DROP TABLE "__authrim_pk_copy_tenant_database_migration_state";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
