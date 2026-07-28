-- Plugin Runner owns scan cursors and scheduling cache only. Provider credentials are prohibited.

CREATE TABLE IF NOT EXISTS plugin_runner_shard_cursors (
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

CREATE INDEX IF NOT EXISTS idx_plugin_runner_shards_due
  ON plugin_runner_shard_cursors(next_due_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS plugin_runner_full_sweep_state (
  sweep_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed')),
  started_at INTEGER,
  target_completed_at INTEGER,
  completed_at INTEGER,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  scanned_shard_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_shard_count >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_runner_one_active_sweep
  ON plugin_runner_full_sweep_state(state)
  WHERE state IN ('pending', 'running');

CREATE TABLE IF NOT EXISTS plugin_runner_hook_policies (
  plugin_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1 AND 30000),
  failure_policy TEXT NOT NULL CHECK (failure_policy IN ('fail_open', 'fail_closed', 'retry_async')),
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 100),
  circuit_breaker_threshold INTEGER NOT NULL CHECK (circuit_breaker_threshold BETWEEN 1 AND 1000),
  circuit_breaker_cooldown_seconds INTEGER NOT NULL
    CHECK (circuit_breaker_cooldown_seconds BETWEEN 1 AND 86400),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, capability)
);

CREATE TABLE IF NOT EXISTS plugin_runner_egress_allowed_hosts (
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

CREATE TABLE IF NOT EXISTS plugin_runner_circuit_breakers (
  plugin_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  opened_at INTEGER,
  retry_after INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin_id, tenant_id, capability)
);

CREATE TABLE IF NOT EXISTS plugin_runner_migration_state (
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
