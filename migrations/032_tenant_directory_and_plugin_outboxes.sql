-- Account directory publication and plugin hook delivery are separate durable outboxes.

ALTER TABLE identity_accounts
  ADD COLUMN directory_publication_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (directory_publication_state IN ('pending', 'active_pending_directory', 'active', 'disabled'));

ALTER TABLE identity_accounts
  ADD COLUMN account_route_generation INTEGER NOT NULL DEFAULT 1
  CHECK (account_route_generation >= 1);

CREATE INDEX IF NOT EXISTS idx_identity_accounts_directory_publication
  ON identity_accounts(tenant_id, directory_publication_state, created_at, id);

CREATE TABLE IF NOT EXISTS account_creation_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  allocation_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN (
      'preparing', 'reserved', 'writing', 'directory_pending',
      'succeeded', 'blocked', 'canceled'
    )),
  publication_json TEXT
    CHECK (publication_json IS NULL OR
      (json_valid(publication_json) AND length(publication_json) <= 16384)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, actor_id, idempotency_key),
  UNIQUE (tenant_id, account_id),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE INDEX IF NOT EXISTS idx_account_creation_operations_status
  ON account_creation_operations(status, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_account_creation_operation_status_transition
BEFORE UPDATE OF status ON account_creation_operations
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'preparing' AND NEW.status IN ('reserved', 'blocked', 'canceled')) OR
  (OLD.status = 'reserved' AND NEW.status IN ('writing', 'blocked', 'canceled')) OR
  (OLD.status = 'writing' AND NEW.status IN ('directory_pending', 'succeeded', 'blocked')) OR
  (OLD.status = 'directory_pending' AND NEW.status IN ('succeeded', 'blocked')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('reserved', 'writing', 'directory_pending', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_creation_operation_status_transition');
END;

CREATE TABLE IF NOT EXISTS account_routing_outbox (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('account_created', 'identifier_added', 'identifier_replaced', 'identifier_removed', 'account_disabled', 'account_deleted')),
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'pending', 'leased', 'retry', 'succeeded', 'blocked', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_account_routing_outbox_due
  ON account_routing_outbox(status, next_attempt_at, created_at);

CREATE TRIGGER IF NOT EXISTS trg_account_routing_outbox_status_transition
BEFORE UPDATE OF status ON account_routing_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'prepared' AND NEW.status IN ('pending', 'blocked')) OR
  (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'blocked')) OR
  (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'blocked', 'dead_letter')) OR
  (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'blocked', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_routing_outbox_status_transition');
END;

CREATE TABLE IF NOT EXISTS plugin_hook_outbox (
  outbox_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  payload_class TEXT NOT NULL DEFAULT 'reference_v1' CHECK (payload_class = 'reference_v1'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'locked', 'waiting_retry', 'succeeded', 'dead_letter', 'canceled')),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  claim_owner TEXT,
  claim_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  dead_lettered_at INTEGER,
  canceled_at INTEGER,
  delete_after INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_installation_id, idempotency_key),
  CHECK (
    (status = 'locked' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL
      AND lease_until IS NOT NULL AND lease_until > updated_at AND attempt_no >= 1) OR
    (status <> 'locked' AND claim_owner IS NULL AND claim_token IS NULL AND lease_until IS NULL)
  ),
  CHECK ((status = 'waiting_retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR status <> 'waiting_retry'),
  CHECK ((status = 'queued' AND attempt_no = 0 AND next_attempt_at IS NULL) OR status <> 'queued'),
  CHECK ((status IN ('succeeded', 'dead_letter') AND attempt_no >= 1)
    OR status NOT IN ('succeeded', 'dead_letter')),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL AND delete_after = succeeded_at + 604800) OR status <> 'succeeded'),
  CHECK ((status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND delete_after = dead_lettered_at + 7776000) OR status <> 'dead_letter'),
  CHECK ((status = 'canceled' AND canceled_at IS NOT NULL) OR status <> 'canceled')
);

CREATE INDEX IF NOT EXISTS idx_plugin_hook_outbox_due
  ON plugin_hook_outbox(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_plugin_hook_outbox_retention
  ON plugin_hook_outbox(delete_after, status);

CREATE TRIGGER IF NOT EXISTS trg_plugin_hook_outbox_initial_state
BEFORE INSERT ON plugin_hook_outbox
WHEN NEW.status <> 'queued'
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_initial_state');
END;

CREATE TRIGGER IF NOT EXISTS trg_plugin_hook_outbox_status_transition
BEFORE UPDATE OF status ON plugin_hook_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('locked', 'canceled')) OR
  (OLD.status = 'locked' AND NEW.status IN ('waiting_retry', 'succeeded', 'dead_letter', 'canceled')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('locked', 'dead_letter', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_status_transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_plugin_hook_outbox_claim_fencing
BEFORE UPDATE ON plugin_hook_outbox
WHEN NEW.status = 'locked' AND (
  (OLD.status IN ('queued', 'waiting_retry') AND NEW.attempt_no <> OLD.attempt_no + 1) OR
  (OLD.status = 'locked' AND (
    NOT (
      (NEW.claim_token = OLD.claim_token AND NEW.attempt_no = OLD.attempt_no) OR
      (OLD.lease_until <= NEW.updated_at AND NEW.claim_token <> OLD.claim_token
        AND NEW.attempt_no = OLD.attempt_no + 1)
    )
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_claim_fencing');
END;

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
