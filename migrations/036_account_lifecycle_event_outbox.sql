-- Durable post-activation events. Payloads contain stable references only, never raw identifiers.

CREATE TABLE IF NOT EXISTS account_lifecycle_event_outbox (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'account.created'),
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
  plugin_targets_json TEXT
    CHECK (plugin_targets_json IS NULL OR
      (json_valid(plugin_targets_json) AND length(plugin_targets_json) <= 4096)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_id, event_type),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id) REFERENCES account_creation_operations(operation_id) ON DELETE CASCADE,
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL) OR
         status <> 'retry'),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE INDEX IF NOT EXISTS idx_account_lifecycle_event_outbox_due
  ON account_lifecycle_event_outbox(status, next_attempt_at, created_at, event_id);

CREATE TRIGGER IF NOT EXISTS trg_account_lifecycle_event_outbox_initial_state
BEFORE INSERT ON account_lifecycle_event_outbox
WHEN NEW.status <> 'pending' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_lifecycle_event_initial_state');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_lifecycle_event_outbox_status_transition
BEFORE UPDATE OF status ON account_lifecycle_event_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'dead_letter')) OR
  (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'dead_letter')) OR
  (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_lifecycle_event_status_transition');
END;
