CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_releases (
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

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_manifests (
  plugin_id TEXT PRIMARY KEY,
  active_version_digest TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'staging' CHECK (state IN ('staging', 'active', 'revoked')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (plugin_id, active_version_digest)
    REFERENCES plugin_runner_dynamic_worker_releases(plugin_id, version_digest)
);

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_hook_policies (
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

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_egress_allowed_hosts (
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

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_credential_slots (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_runner_dynamic_credential_target
  ON plugin_runner_dynamic_worker_credential_slots(
    plugin_id, version_digest, destination_host, injection_name
  );

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_rollouts (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_runner_dynamic_rollout_active_plugin
  ON plugin_runner_dynamic_worker_rollouts(plugin_id)
  WHERE state = 'running';

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_rollout_results (
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

CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_artifacts (
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

CREATE INDEX IF NOT EXISTS idx_plugin_runner_worker_artifact_state
  ON plugin_runner_dynamic_worker_artifacts(installation_id, state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_runner_worker_artifact_version
  ON plugin_runner_dynamic_worker_artifacts(installation_id, version_digest);

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_dynamic_artifact_installation
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

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_dynamic_artifact_activate
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

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_dynamic_artifact_update
BEFORE UPDATE OF artifact_id, installation_id, plugin_id, version_digest
ON plugin_runner_dynamic_worker_artifacts
BEGIN
  SELECT RAISE(ABORT, 'plugin_worker_artifact_identity_immutable');
END;
