-- Migration: 051_account_support_context_and_legal_holds.sql
-- Description: Add account-scoped legal hold authority and bounded Admin support context.
-- Author: Authrim
-- Date: 2026-08-18

-- =============================================================================
-- Up Migration (Forward)
-- =============================================================================

CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'account' CHECK (subject_type = 'account'),
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'released', 'expired')),
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_by TEXT,
  released_at INTEGER,
  release_reason TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(subject_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (released_by IS NULL OR length(released_by) BETWEEN 1 AND 256),
  CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 256),
  CHECK (expires_at IS NULL OR expires_at >= created_at),
  CHECK (
    (state = 'active' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (state IN ('released', 'expired') AND released_by IS NOT NULL AND released_at IS NOT NULL AND
      release_reason IS NOT NULL)
  ),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_account_history
  ON legal_holds(tenant_id, subject_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_legal_holds_expiry
  ON legal_holds(state, expires_at, tenant_id, id);

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_account_tenant_insert
BEFORE INSERT ON legal_holds
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.subject_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_account_not_found');
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_account_tenant_update
BEFORE UPDATE OF tenant_id, subject_type, subject_id ON legal_holds
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.subject_type <> NEW.subject_type OR
     OLD.subject_id <> NEW.subject_id
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_subject_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_one_active_account_insert
BEFORE INSERT ON legal_holds
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = NEW.tenant_id AND hold.subject_type = NEW.subject_type
     AND hold.subject_id = NEW.subject_id AND hold.state = 'active' AND hold.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_active_conflict');
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_transition
BEFORE UPDATE ON legal_holds
WHEN NOT (
  OLD.state = 'active' AND NEW.state IN ('active', 'released', 'expired') AND
  NEW.version = OLD.version + 1 AND NEW.created_by = OLD.created_by AND
  NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_immutable_delete
BEFORE DELETE ON legal_holds
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_delete_forbidden');
END;

CREATE TABLE IF NOT EXISTS legal_hold_events (
  event_id TEXT PRIMARY KEY,
  hold_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'extended', 'released', 'expired')),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  effective_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(event_id) BETWEEN 1 AND 256),
  CHECK (length(actor_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (created_at >= effective_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);

CREATE INDEX IF NOT EXISTS idx_legal_hold_events_account
  ON legal_hold_events(tenant_id, account_id, created_at DESC, event_id DESC);

CREATE TRIGGER IF NOT EXISTS trg_legal_hold_events_immutable_update
BEFORE UPDATE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_event_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_hold_events_immutable_delete
BEFORE DELETE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_event_immutable');
END;

CREATE TABLE IF NOT EXISTS account_legal_hold_states (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  active_hold_id TEXT,
  projection_state TEXT NOT NULL DEFAULT 'inactive'
    CHECK (projection_state IN ('active', 'inactive')),
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  CHECK ((projection_state = 'active' AND active_hold_id IS NOT NULL) OR
         (projection_state = 'inactive' AND active_hold_id IS NULL))
);

INSERT INTO account_legal_hold_states (
  tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
)
SELECT tenant_id, id, NULL, 'inactive', 1, updated_at FROM identity_accounts WHERE 1 = 1
ON CONFLICT (tenant_id, account_id) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS trg_identity_accounts_legal_hold_state_insert
AFTER INSERT ON identity_accounts
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.id, NULL, 'inactive', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_projection_state_insert
AFTER INSERT ON legal_holds
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.subject_id, NEW.id, 'active', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO UPDATE SET
    active_hold_id = excluded.active_hold_id,
    projection_state = 'active',
    projection_generation = account_legal_hold_states.projection_generation + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_legal_holds_projection_state_update
AFTER UPDATE OF state ON legal_holds
WHEN OLD.state = 'active' AND NEW.state IN ('released', 'expired')
BEGIN
  UPDATE account_legal_hold_states
     SET active_hold_id = NULL, projection_state = 'inactive',
         projection_generation = projection_generation + 1, updated_at = NEW.updated_at
   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.subject_id
     AND active_hold_id = NEW.id AND projection_state = 'active';
END;

CREATE TABLE IF NOT EXISTS legal_hold_projection_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_state TEXT NOT NULL CHECK (projection_state IN ('active', 'inactive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK (updated_at >= created_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);

CREATE INDEX IF NOT EXISTS idx_legal_hold_projection_outbox_runnable
  ON legal_hold_projection_outbox(status, next_attempt_at, tenant_id, operation_id);

CREATE TABLE IF NOT EXISTS lookup_retention_policies (
  tenant_id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 3650),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);

INSERT INTO lookup_retention_policies (
  tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
)
SELECT id, 180, 1, 'migration:051', created_at, updated_at FROM tenants WHERE 1 = 1
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lookup_retention_policy_projection_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, policy_generation)
);

CREATE INDEX IF NOT EXISTS idx_lookup_retention_policy_projection_outbox_runnable
  ON lookup_retention_policy_projection_outbox(
    status, next_attempt_at, tenant_id, policy_generation
  );

INSERT INTO lookup_retention_policy_projection_outbox (
  operation_id, tenant_id, policy_generation, retention_days,
  next_attempt_at, created_at, updated_at
)
SELECT 'lookup-retention-policy:init:' || lower(hex(randomblob(16))),
       tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
  FROM lookup_retention_policies WHERE 1 = 1
ON CONFLICT (tenant_id, policy_generation) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS trg_tenants_lookup_retention_policy_insert
AFTER INSERT ON tenants
BEGIN
  INSERT INTO lookup_retention_policies (
    tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
  ) VALUES (NEW.id, 180, 1, 'tenant-default', NEW.created_at, NEW.updated_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO lookup_retention_policy_projection_outbox (
    operation_id, tenant_id, policy_generation, retention_days,
    next_attempt_at, created_at, updated_at
  )
  SELECT 'lookup-retention-policy:init:' || lower(hex(randomblob(16))),
         tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
    FROM lookup_retention_policies WHERE tenant_id = NEW.id
  ON CONFLICT (tenant_id, policy_generation) DO NOTHING;
END;

CREATE TRIGGER IF NOT EXISTS trg_identity_accounts_active_hold_delete
BEFORE DELETE ON identity_accounts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
     AND hold.subject_id = OLD.id AND hold.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'account_legal_hold_active');
END;

CREATE TABLE IF NOT EXISTS account_support_contexts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{"schema_version":1}'
    CHECK (json_valid(context_json) AND json_type(context_json) = 'object' AND
           length(context_json) BETWEEN 20 AND 32768),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(account_id) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);

CREATE TRIGGER IF NOT EXISTS trg_account_support_context_account_tenant_insert
BEFORE INSERT ON account_support_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_account_not_found');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_support_context_account_immutable
BEFORE UPDATE OF tenant_id, account_id ON account_support_contexts
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.account_id <> NEW.account_id
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_account_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_support_context_version
BEFORE UPDATE ON account_support_contexts
WHEN NEW.version <> OLD.version + 1 OR NEW.created_by <> OLD.created_by OR
     NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_version_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_account_support_context_active_hold_delete
BEFORE DELETE ON account_support_contexts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
     AND hold.subject_id = OLD.account_id AND hold.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_legal_hold_active');
END;

-- =============================================================================
-- Down Migration (Rollback) - COMMENTED OUT
-- =============================================================================
-- This section documents how to rollback this migration if needed.
-- Uncomment and execute manually if rollback is required.

-- DROP TRIGGER IF EXISTS trg_account_support_context_active_hold_delete;
-- DROP TRIGGER IF EXISTS trg_account_support_context_version;
-- DROP TRIGGER IF EXISTS trg_account_support_context_account_immutable;
-- DROP TRIGGER IF EXISTS trg_account_support_context_account_tenant_insert;
-- DROP TABLE IF EXISTS account_support_contexts;
-- DROP TRIGGER IF EXISTS trg_identity_accounts_active_hold_delete;
-- DROP TABLE IF EXISTS lookup_retention_policy_projection_outbox;
-- DROP TRIGGER IF EXISTS trg_tenants_lookup_retention_policy_insert;
-- DROP TABLE IF EXISTS lookup_retention_policies;
-- DROP TABLE IF EXISTS legal_hold_projection_outbox;
-- DROP TRIGGER IF EXISTS trg_legal_hold_events_immutable_delete;
-- DROP TRIGGER IF EXISTS trg_legal_hold_events_immutable_update;
-- DROP TABLE IF EXISTS legal_hold_events;
-- DROP TABLE IF EXISTS account_legal_hold_states;
-- DROP TRIGGER IF EXISTS trg_legal_holds_immutable_delete;
-- DROP TRIGGER IF EXISTS trg_legal_holds_transition;
-- DROP TRIGGER IF EXISTS trg_legal_holds_one_active_account_insert;
-- DROP TRIGGER IF EXISTS trg_legal_holds_account_tenant_update;
-- DROP TRIGGER IF EXISTS trg_legal_holds_account_tenant_insert;
-- DROP TABLE IF EXISTS legal_holds;
-- DELETE FROM schema_migrations WHERE version = 51;

-- =============================================================================
-- Migration Complete
-- =============================================================================
-- Version: 051
-- =============================================================================
