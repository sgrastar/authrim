-- External Core baselines did not previously contain webhook subscription configuration.
CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT 'tenant',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
);
-- Explicit per-destination account data selection. Existing subscriptions retain identifiers only.
ALTER TABLE webhook_configs ADD COLUMN payload_fields TEXT NOT NULL DEFAULT '[]';
ALTER TABLE webhook_configs ADD COLUMN registration_states TEXT NOT NULL DEFAULT '[]';
