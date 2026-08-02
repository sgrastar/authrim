-- Explicit tenant notification provider order and response-loss-safe projection state.

CREATE UNIQUE INDEX IF NOT EXISTS uq_plugin_runner_installation_tenant_identity
  ON plugin_runner_installations(tenant_id, installation_id);

CREATE TABLE IF NOT EXISTS plugin_runner_notification_route_sets (
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

CREATE TABLE IF NOT EXISTS plugin_runner_notification_route_entries (
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

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_notification_route_entry_enabled
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

CREATE INDEX IF NOT EXISTS idx_plugin_runner_notification_route_entries_installation
  ON plugin_runner_notification_route_entries(installation_id, tenant_id, channel);
