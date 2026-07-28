-- Account directory publication and plugin hook delivery are separate durable outboxes.

ALTER TABLE identity_accounts
  ADD COLUMN directory_publication_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (directory_publication_state IN ('pending', 'active_pending_directory', 'active', 'disabled'));

ALTER TABLE identity_accounts
  ADD COLUMN account_route_generation INTEGER NOT NULL DEFAULT 1
  CHECK (account_route_generation >= 1);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_directory_publication
  ON identity_accounts(tenant_id, directory_publication_state, created_at, id);

CREATE TABLE IF NOT EXISTS account_routing_outbox (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('account_created', 'identifier_added', 'identifier_replaced', 'account_disabled', 'account_deleted')),
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'blocked', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, account_id, event_kind, route_generation),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_routing_outbox_due
  ON account_routing_outbox(status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS plugin_hook_outbox (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  dead_lettered_at INTEGER,
  delete_after INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_installation_id, idempotency_key),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL AND delete_after = succeeded_at + 604800) OR status <> 'succeeded'),
  CHECK ((status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND delete_after = dead_lettered_at + 7776000) OR status <> 'dead_letter')
);

CREATE INDEX IF NOT EXISTS idx_plugin_hook_outbox_due
  ON plugin_hook_outbox(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_hook_outbox_retention
  ON plugin_hook_outbox(delete_after, status);

CREATE TABLE IF NOT EXISTS identifier_change_notification_outbox (
  notification_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  replacement_id TEXT NOT NULL,
  destination_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'sent', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, replacement_id)
);
