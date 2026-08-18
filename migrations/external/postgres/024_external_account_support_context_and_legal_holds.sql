-- Account-scoped legal hold authority and bounded Admin support context for external PostgreSQL.

CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'account' CHECK (subject_type = 'account'),
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'released', 'expired')),
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  expires_at BIGINT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  released_by TEXT,
  released_at BIGINT,
  release_reason TEXT,
  updated_at BIGINT NOT NULL,
  CHECK (char_length(id) BETWEEN 1 AND 256),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 256),
  CHECK (char_length(subject_id) BETWEEN 1 AND 256),
  CHECK (char_length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR char_length(case_reference) BETWEEN 1 AND 256),
  CHECK (char_length(created_by) BETWEEN 1 AND 256),
  CHECK (released_by IS NULL OR char_length(released_by) BETWEEN 1 AND 256),
  CHECK (release_reason IS NULL OR char_length(release_reason) BETWEEN 1 AND 256),
  CHECK (expires_at IS NULL OR expires_at >= created_at),
  CHECK (
    (state = 'active' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (state IN ('released', 'expired') AND released_by IS NOT NULL AND released_at IS NOT NULL AND
      release_reason IS NOT NULL)
  ),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_holds_one_active_account
  ON legal_holds(tenant_id, subject_type, subject_id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_legal_holds_account_history
  ON legal_holds(tenant_id, subject_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_legal_holds_expiry
  ON legal_holds(state, expires_at, tenant_id, id)
  WHERE state = 'active' AND expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION authrim_legal_hold_validate_account()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_accounts account
     WHERE account.id = NEW.subject_id AND account.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'legal_hold_account_not_found';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_holds_account_tenant_insert ON legal_holds;
CREATE TRIGGER trg_legal_holds_account_tenant_insert
BEFORE INSERT ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_validate_account();

CREATE OR REPLACE FUNCTION authrim_legal_hold_validate_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.tenant_id <> NEW.tenant_id OR OLD.subject_type <> NEW.subject_type OR
     OLD.subject_id <> NEW.subject_id THEN
    RAISE EXCEPTION 'legal_hold_subject_immutable';
  END IF;
  IF NOT (
    OLD.state = 'active' AND NEW.state IN ('active', 'released', 'expired') AND
    NEW.version = OLD.version + 1 AND NEW.created_by = OLD.created_by AND
    NEW.created_at = OLD.created_at
  ) THEN
    RAISE EXCEPTION 'legal_hold_transition_invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_holds_transition ON legal_holds;
CREATE TRIGGER trg_legal_holds_transition
BEFORE UPDATE ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_validate_update();

CREATE OR REPLACE FUNCTION authrim_legal_hold_forbid_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'legal_hold_delete_forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_holds_immutable_delete ON legal_holds;
CREATE TRIGGER trg_legal_holds_immutable_delete
BEFORE DELETE ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_forbid_delete();

CREATE TABLE IF NOT EXISTS legal_hold_events (
  event_id TEXT PRIMARY KEY,
  hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'extended', 'released', 'expired')),
  hold_version BIGINT NOT NULL CHECK (hold_version >= 1),
  projection_generation BIGINT NOT NULL CHECK (projection_generation >= 1),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  effective_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  CHECK (char_length(event_id) BETWEEN 1 AND 256),
  CHECK (char_length(actor_id) BETWEEN 1 AND 256),
  CHECK (char_length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR char_length(case_reference) BETWEEN 1 AND 256),
  CHECK (created_at >= effective_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);

CREATE INDEX IF NOT EXISTS idx_legal_hold_events_account
  ON legal_hold_events(tenant_id, account_id, created_at DESC, event_id DESC);

CREATE OR REPLACE FUNCTION authrim_legal_hold_event_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'legal_hold_event_immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_hold_events_immutable_update ON legal_hold_events;
CREATE TRIGGER trg_legal_hold_events_immutable_update
BEFORE UPDATE ON legal_hold_events
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_event_immutable();

DROP TRIGGER IF EXISTS trg_legal_hold_events_immutable_delete ON legal_hold_events;
CREATE TRIGGER trg_legal_hold_events_immutable_delete
BEFORE DELETE ON legal_hold_events
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_event_immutable();

CREATE TABLE IF NOT EXISTS account_legal_hold_states (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  active_hold_id TEXT,
  projection_state TEXT NOT NULL DEFAULT 'inactive'
    CHECK (projection_state IN ('active', 'inactive')),
  projection_generation BIGINT NOT NULL CHECK (projection_generation >= 1),
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  CHECK ((projection_state = 'active' AND active_hold_id IS NOT NULL) OR
         (projection_state = 'inactive' AND active_hold_id IS NULL))
);

INSERT INTO account_legal_hold_states (
  tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
)
SELECT tenant_id, id, NULL, 'inactive', 1, updated_at FROM identity_accounts
ON CONFLICT (tenant_id, account_id) DO NOTHING;

CREATE OR REPLACE FUNCTION authrim_identity_account_legal_hold_state_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.id, NULL, 'inactive', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_identity_accounts_legal_hold_state_insert ON identity_accounts;
CREATE TRIGGER trg_identity_accounts_legal_hold_state_insert
AFTER INSERT ON identity_accounts
FOR EACH ROW EXECUTE FUNCTION authrim_identity_account_legal_hold_state_insert();

CREATE OR REPLACE FUNCTION authrim_legal_hold_projection_state_change()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO account_legal_hold_states (
      tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
    ) VALUES (NEW.tenant_id, NEW.subject_id, NEW.id, 'active', 1, NEW.updated_at)
    ON CONFLICT (tenant_id, account_id) DO UPDATE SET
      active_hold_id = EXCLUDED.active_hold_id,
      projection_state = 'active',
      projection_generation = account_legal_hold_states.projection_generation + 1,
      updated_at = EXCLUDED.updated_at;
  ELSIF OLD.state = 'active' AND NEW.state IN ('released', 'expired') THEN
    UPDATE account_legal_hold_states
       SET active_hold_id = NULL, projection_state = 'inactive',
           projection_generation = projection_generation + 1, updated_at = NEW.updated_at
     WHERE tenant_id = NEW.tenant_id AND account_id = NEW.subject_id
       AND active_hold_id = NEW.id AND projection_state = 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_legal_holds_projection_state_insert ON legal_holds;
CREATE TRIGGER trg_legal_holds_projection_state_insert
AFTER INSERT ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_projection_state_change();

DROP TRIGGER IF EXISTS trg_legal_holds_projection_state_update ON legal_holds;
CREATE TRIGGER trg_legal_holds_projection_state_update
AFTER UPDATE OF state ON legal_holds
FOR EACH ROW EXECUTE FUNCTION authrim_legal_hold_projection_state_change();

CREATE TABLE IF NOT EXISTS legal_hold_projection_outbox (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  projection_generation BIGINT NOT NULL CHECK (projection_generation >= 1),
  hold_version BIGINT NOT NULL CHECK (hold_version >= 1),
  projection_state TEXT NOT NULL CHECK (projection_state IN ('active', 'inactive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count BIGINT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at BIGINT NOT NULL,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
  CHECK (char_length(operation_id) BETWEEN 1 AND 256),
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
  tenant_id TEXT PRIMARY KEY CHECK (char_length(tenant_id) BETWEEN 1 AND 256),
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 3650),
  policy_generation BIGINT NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 256),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CHECK (updated_at >= created_at)
);

INSERT INTO lookup_retention_policies (
  tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
)
SELECT id, 180, 1, 'migration:024', created_at, updated_at FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS lookup_retention_policy_projection_outbox (
  operation_id TEXT PRIMARY KEY CHECK (char_length(operation_id) BETWEEN 1 AND 256),
  tenant_id TEXT NOT NULL,
  policy_generation BIGINT NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at BIGINT NOT NULL,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  last_error_code TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
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
SELECT 'lookup-retention-policy:init:' || md5(tenant_id || ':' || policy_generation::text),
       tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
  FROM lookup_retention_policies
ON CONFLICT (tenant_id, policy_generation) DO NOTHING;

CREATE OR REPLACE FUNCTION authrim_tenant_lookup_retention_policy_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO lookup_retention_policies (
    tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
  ) VALUES (NEW.id, 180, 1, 'tenant-default', NEW.created_at, NEW.updated_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO lookup_retention_policy_projection_outbox (
    operation_id, tenant_id, policy_generation, retention_days,
    next_attempt_at, created_at, updated_at
  )
  SELECT 'lookup-retention-policy:init:' || md5(tenant_id || ':' || policy_generation::text),
         tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
    FROM lookup_retention_policies WHERE tenant_id = NEW.id
  ON CONFLICT (tenant_id, policy_generation) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenants_lookup_retention_policy_insert ON tenants;
CREATE TRIGGER trg_tenants_lookup_retention_policy_insert
AFTER INSERT ON tenants
FOR EACH ROW EXECUTE FUNCTION authrim_tenant_lookup_retention_policy_insert();

CREATE OR REPLACE FUNCTION authrim_identity_account_active_hold_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legal_holds hold
     WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
       AND hold.subject_id = OLD.id AND hold.state = 'active'
  ) THEN
    RAISE EXCEPTION 'account_legal_hold_active';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_identity_accounts_active_hold_delete ON identity_accounts;
CREATE TRIGGER trg_identity_accounts_active_hold_delete
BEFORE DELETE ON identity_accounts
FOR EACH ROW EXECUTE FUNCTION authrim_identity_account_active_hold_delete();

CREATE TABLE IF NOT EXISTS account_support_contexts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES identity_accounts(id) ON DELETE CASCADE,
  context_json JSONB NOT NULL DEFAULT '{"schema_version":1}'::jsonb
    CHECK (jsonb_typeof(context_json) = 'object' AND
           octet_length(context_json::text) BETWEEN 20 AND 32768),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  CHECK (char_length(tenant_id) BETWEEN 1 AND 256),
  CHECK (char_length(account_id) BETWEEN 1 AND 256),
  CHECK (char_length(created_by) BETWEEN 1 AND 256),
  CHECK (char_length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);

CREATE OR REPLACE FUNCTION authrim_support_context_validate_account()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_accounts account
     WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'account_support_context_account_not_found';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_support_context_account_tenant_insert
  ON account_support_contexts;
CREATE TRIGGER trg_account_support_context_account_tenant_insert
BEFORE INSERT ON account_support_contexts
FOR EACH ROW EXECUTE FUNCTION authrim_support_context_validate_account();

CREATE OR REPLACE FUNCTION authrim_support_context_validate_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.tenant_id <> NEW.tenant_id OR OLD.account_id <> NEW.account_id THEN
    RAISE EXCEPTION 'account_support_context_account_immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 OR NEW.created_by <> OLD.created_by OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'account_support_context_version_invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_support_context_version ON account_support_contexts;
CREATE TRIGGER trg_account_support_context_version
BEFORE UPDATE ON account_support_contexts
FOR EACH ROW EXECUTE FUNCTION authrim_support_context_validate_update();

CREATE OR REPLACE FUNCTION authrim_support_context_active_hold_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM legal_holds hold
     WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
       AND hold.subject_id = OLD.account_id AND hold.state = 'active'
  ) THEN
    RAISE EXCEPTION 'account_support_context_legal_hold_active';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_support_context_active_hold_delete
  ON account_support_contexts;
CREATE TRIGGER trg_account_support_context_active_hold_delete
BEFORE DELETE ON account_support_contexts
FOR EACH ROW EXECUTE FUNCTION authrim_support_context_active_hold_delete();
