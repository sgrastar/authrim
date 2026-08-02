-- Control publishes a signed, aggregate tenant-core shard inventory for Plugin Runner.

CREATE TABLE IF NOT EXISTS control_plugin_runner_registry_publications (
  environment_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  inventory_digest TEXT NOT NULL
    CHECK (inventory_digest NOT GLOB '*[^0-9a-f]*' AND length(inventory_digest) = 64),
  snapshot_jws TEXT NOT NULL CHECK (length(snapshot_jws) BETWEEN 64 AND 1048576),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  status TEXT NOT NULL CHECK (status IN ('publishing', 'active')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_control_plugin_runner_registry_due
  ON control_plugin_runner_registry_publications(status, expires_at, environment_id);
