-- Preserve ordinary account-creation bookkeeping in SAML/passkey replication.
-- Text JSON preserves the source bytes; checks and relational keys follow Core D1.

CREATE TABLE account_creation_operations (
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
      ((publication_json IS JSON) AND length(publication_json) <= 16384)),
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  completed_at BIGINT,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, actor_id, idempotency_key),
  UNIQUE (tenant_id, account_id),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE TABLE "account_lifecycle_event_outbox" (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'account.created'),
  event_version BIGINT NOT NULL DEFAULT 1 CHECK (event_version = 1),
  payload_json TEXT NOT NULL CHECK ((payload_json IS JSON) AND length(payload_json) <= 4096),
  plugin_targets_json TEXT
    CHECK (plugin_targets_json IS NULL OR
      ((plugin_targets_json IS JSON) AND length(plugin_targets_json) <= 4096)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at BIGINT,
  next_attempt_at BIGINT,
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  succeeded_at BIGINT,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, operation_id, event_type),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL) OR
         status <> 'retry'),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY,          -- Composite: tenant_id:actor_id:method:path:resource_id:key
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,       -- admin_id who made the request
    method TEXT NOT NULL,         -- HTTP method (POST, PUT, DELETE)
    path TEXT NOT NULL,           -- API path pattern
    resource_id TEXT,             -- Target resource ID (if applicable)
    idempotency_key TEXT NOT NULL,-- The Idempotency-Key header value
    body_hash TEXT NOT NULL,      -- SHA-256 hash of request body
    response_status BIGINT NOT NULL,
    response_body TEXT NOT NULL,  -- Sanitized response (PII removed)
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE INDEX idx_account_creation_operations_status
  ON account_creation_operations(status, updated_at);

CREATE INDEX idx_account_lifecycle_event_outbox_due
  ON account_lifecycle_event_outbox(status, next_attempt_at, created_at, event_id);

CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);

CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);

CREATE FUNCTION authrim_account_creation_operation_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'preparing' AND NEW.status IN ('reserved', 'blocked', 'canceled')) OR
    (OLD.status = 'reserved' AND NEW.status IN ('writing', 'blocked', 'canceled')) OR
    (OLD.status = 'writing' AND NEW.status IN ('directory_pending', 'succeeded', 'blocked')) OR
    (OLD.status = 'directory_pending' AND NEW.status IN ('succeeded', 'blocked')) OR
    (OLD.status = 'blocked' AND NEW.status IN ('reserved', 'writing', 'directory_pending', 'canceled'))
  ) THEN RAISE EXCEPTION 'invalid_account_creation_operation_status_transition'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_account_creation_operation_status_transition
  BEFORE UPDATE OF status ON account_creation_operations FOR EACH ROW
  EXECUTE FUNCTION authrim_account_creation_operation_status_transition();

CREATE FUNCTION authrim_account_lifecycle_event_outbox_initial_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 THEN
    RAISE EXCEPTION 'invalid_account_lifecycle_event_initial_state';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_account_lifecycle_event_outbox_initial_state
  BEFORE INSERT ON account_lifecycle_event_outbox FOR EACH ROW
  EXECUTE FUNCTION authrim_account_lifecycle_event_outbox_initial_state();

CREATE FUNCTION authrim_account_lifecycle_event_outbox_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'dead_letter')) OR
    (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'dead_letter')) OR
    (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'dead_letter'))
  ) THEN RAISE EXCEPTION 'invalid_account_lifecycle_event_status_transition'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_account_lifecycle_event_outbox_status_transition
  BEFORE UPDATE OF status ON account_lifecycle_event_outbox FOR EACH ROW
  EXECUTE FUNCTION authrim_account_lifecycle_event_outbox_status_transition();
