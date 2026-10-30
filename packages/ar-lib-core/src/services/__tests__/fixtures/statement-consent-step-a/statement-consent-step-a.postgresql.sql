-- PRIVATE UNNUMBERED postgresql Step B fixture. Not applied, not activated, not runtime-verified.
-- Existing consent tables/FKs/indexes are not rebuilt or altered.

CREATE TABLE statement_consent_retention_permits (
  tenant_id TEXT NOT NULL,
  permit_id TEXT NOT NULL,
  row_kind TEXT NOT NULL CHECK (row_kind IN ('record','history')),
  row_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  cutoff_at BIGINT NOT NULL CHECK (cutoff_at BETWEEN 0 AND 9007199254740991),
  legacy_retention_days BIGINT CHECK (legacy_retention_days BETWEEN 0 AND 9007199254740991 / 86400000),
  issued_at BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991),
  PRIMARY KEY (tenant_id,permit_id)
);

CREATE TABLE statement_consent_guards (
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'statement')),
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'enforced', 'closed')),
  definition_generation BIGINT NOT NULL DEFAULT 0 CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  closed_generation BIGINT NOT NULL DEFAULT 0 CHECK (closed_generation BETWEEN 0 AND 9007199254740991),
  account_id TEXT NOT NULL DEFAULT '',
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  created_at BIGINT NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
  updated_at BIGINT NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991),
  PRIMARY KEY (tenant_id, scope_kind, scope_key),
  CHECK ((scope_kind = 'tenant' AND scope_key = '') OR (scope_kind = 'statement' AND length(scope_key) > 0))
);
CREATE TABLE statement_consent_key_states (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  withdrawal_generation BIGINT NOT NULL CHECK (withdrawal_generation BETWEEN 0 AND 9007199254740991),
  last_operation_id TEXT,
  updated_at BIGINT NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (tenant_id, user_id, statement_id)
);
CREATE TABLE statement_consent_operations (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  actor_type TEXT NOT NULL CHECK (length(actor_type) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('grant', 'deny', 'withdraw')),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  expected_revision BIGINT NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990),
  expected_withdrawal_generation BIGINT NOT NULL CHECK (expected_withdrawal_generation BETWEEN 0 AND 9007199254740990),
  expected_definition_generation BIGINT NOT NULL CHECK (expected_definition_generation BETWEEN 0 AND 9007199254740991),
  expected_closed_generation BIGINT NOT NULL CHECK (expected_closed_generation BETWEEN 0 AND 9007199254740991),
  issued_at BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991),
  effect_at BIGINT NOT NULL CHECK (effect_at BETWEEN issued_at AND expires_at),
  definition_json TEXT NOT NULL CHECK (jsonb_typeof(definition_json::jsonb) = 'object'),
  before_json TEXT,
  after_json TEXT NOT NULL CHECK (jsonb_typeof((after_json)::jsonb) = 'object'),
  history_json TEXT CHECK (history_json IS NULL OR (jsonb_typeof((history_json)::jsonb) = 'object')),
  admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)),
  is_noop INTEGER NOT NULL CHECK (is_noop IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'applied', 'rejected')),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)),
  required_terminal INTEGER NOT NULL DEFAULT 1 CHECK (required_terminal = 1),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (tenant_id, operation_id, is_terminal),
  CHECK ((status = 'executing' AND is_terminal = 0) OR (status IN ('applied', 'rejected') AND is_terminal = 1)),
  CHECK (before_json IS NULL OR (jsonb_typeof((before_json)::jsonb) = 'object')),
  CHECK ((is_noop = 1 AND history_json IS NULL AND before_json IS NOT NULL) OR (is_noop = 0 AND history_json IS NOT NULL)),
  FOREIGN KEY (tenant_id, operation_id, required_terminal)
    REFERENCES statement_consent_operations (tenant_id, operation_id, is_terminal)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX idx_statement_consent_one_executing_key ON statement_consent_operations
  (tenant_id, user_id, statement_id) WHERE is_terminal = 0;
CREATE TABLE statement_consent_admissions (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (operation_id ~ '^[a-f0-9]{64}$'),
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  statement_id TEXT NOT NULL,
  definition_generation BIGINT NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  issued_at BIGINT NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991),
  expires_at BIGINT NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991),
  PRIMARY KEY (tenant_id, operation_id)
);

CREATE FUNCTION statement_consent_operation_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only terminal evidence may be rebound by the isolated importer transaction.
  IF NEW.is_terminal=1 AND NEW.status IN ('applied','rejected')
    AND NEW.tenant_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'tenant_id')
    AND NEW.account_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'account_id')
    AND NEW.physical_id=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'physical_id')
    AND NEW.restore_epoch=(NULLIF(current_setting('authrim.statement_consent_restore',true),'')::jsonb ->> 'restore_epoch')
    AND NOT EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=NEW.tenant_id AND o.operation_id=NEW.operation_id)
  THEN RETURN NEW; END IF;

  IF NEW.status <> 'executing' OR NEW.is_terminal <> 0 OR EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND (o.operation_id = NEW.operation_id OR (o.user_id = NEW.user_id AND o.statement_id = NEW.statement_id AND o.is_terminal = 0))) OR (NOT ((NEW.after_json::jsonb ->> 'tenant_id') IS NOT DISTINCT FROM NEW.tenant_id) OR NOT ((NEW.after_json::jsonb ->> 'user_id') IS NOT DISTINCT FROM NEW.user_id) OR NOT ((NEW.after_json::jsonb ->> 'statement_id') IS NOT DISTINCT FROM NEW.statement_id)
      OR (NEW.is_noop = 1 AND (NEW.action <> 'grant' OR (NEW.after_json)::jsonb <> (NEW.before_json)::jsonb OR (NEW.after_json::jsonb ->> 'status') <> 'granted'))
      OR (NEW.is_noop = 0 AND ((NEW.history_json::jsonb ->> 'id') <> ('sc_' || NEW.operation_id || ':' || NEW.tenant_id)
        OR NOT ((NEW.history_json::jsonb ->> 'tenant_id') IS NOT DISTINCT FROM NEW.tenant_id)
        OR NOT ((NEW.history_json::jsonb ->> 'user_id') IS NOT DISTINCT FROM NEW.user_id)
        OR NOT ((NEW.history_json::jsonb ->> 'statement_id') IS NOT DISTINCT FROM NEW.statement_id)
        OR NOT ((NEW.history_json::jsonb ->> 'status_before') IS NOT DISTINCT FROM (NEW.before_json::jsonb ->> 'status'))
        OR NOT ((NEW.history_json::jsonb ->> 'status_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'status'))
        OR NOT ((NEW.history_json::jsonb ->> 'version_id_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version_id'))
        OR NOT ((NEW.history_json::jsonb ->> 'version_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version'))
        OR (NEW.action = 'grant' AND ((NEW.after_json::jsonb ->> 'status') <> 'granted' OR (NEW.history_json::jsonb ->> 'action') NOT IN ('granted','version_upgraded')))
        OR (NEW.action = 'withdraw' AND ((NEW.after_json::jsonb ->> 'status') <> 'withdrawn' OR (NEW.history_json::jsonb ->> 'action') <> 'withdrawn'))
        OR (NEW.action = 'deny' AND ((NEW.after_json::jsonb ->> 'status') NOT IN ('denied','withdrawn') OR (NEW.history_json::jsonb ->> 'action') NOT IN ('denied','withdrawn')))))
      OR (NEW.before_json IS NOT NULL AND ((NEW.after_json::jsonb ->> 'id') <> (NEW.before_json::jsonb ->> 'id')
        OR CAST((NEW.after_json::jsonb ->> 'created_at') AS BIGINT) <> CAST((NEW.before_json::jsonb ->> 'created_at') AS BIGINT)
        OR CAST((NEW.after_json::jsonb ->> 'updated_at') AS BIGINT) < CAST((NEW.before_json::jsonb ->> 'updated_at') AS BIGINT))) OR (NEW.is_noop = 0 AND NOT (((NEW.history_json::jsonb ->> 'content_hash_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'content_hash')) AND ((NEW.history_json::jsonb ->> 'version_id_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version_id')) AND ((NEW.history_json::jsonb ->> 'version_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'version')) AND ((NEW.history_json::jsonb ->> 'status_after') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'status')) AND ((NEW.history_json::jsonb ->> 'granted_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'granted_at')) AND ((NEW.history_json::jsonb ->> 'withdrawn_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'withdrawn_at')) AND ((NEW.history_json::jsonb ->> 'expires_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'expires_at')) AND ((NEW.history_json::jsonb ->> 'retain_until') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'retain_until')) AND ((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'consent_settings_snapshot_at')) AND ((NEW.history_json::jsonb ->> 'record_retention_days_snapshot') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'record_retention_days_snapshot')) AND ((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot')))) OR CASE WHEN (jsonb_typeof(NEW.after_json::jsonb -> 'created_at') = 'number' AND ((NEW.after_json::jsonb ->> 'created_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'created_at'))::numeric,1)=0) AND (jsonb_typeof(NEW.after_json::jsonb -> 'updated_at') = 'number' AND ((NEW.after_json::jsonb ->> 'updated_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'updated_at'))::numeric,1)=0) AND (jsonb_typeof(NEW.after_json::jsonb -> 'granted_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'granted_at') = 'number' AND ((NEW.after_json::jsonb ->> 'granted_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'granted_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'withdrawn_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'withdrawn_at') = 'number' AND ((NEW.after_json::jsonb ->> 'withdrawn_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'withdrawn_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'expires_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'expires_at') = 'number' AND ((NEW.after_json::jsonb ->> 'expires_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'expires_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'retain_until') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'retain_until') = 'number' AND ((NEW.after_json::jsonb ->> 'retain_until'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'retain_until'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'consent_settings_snapshot_at') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'consent_settings_snapshot_at') = 'number' AND ((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'record_retention_days_snapshot') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'record_retention_days_snapshot') = 'number' AND ((NEW.after_json::jsonb ->> 'record_retention_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'record_retention_days_snapshot'))::numeric,1)=0)) AND (jsonb_typeof(NEW.after_json::jsonb -> 'reconsent_interval_days_snapshot') = 'null' OR (jsonb_typeof(NEW.after_json::jsonb -> 'reconsent_interval_days_snapshot') = 'number' AND ((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric,1)=0)) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'granted_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'granted_at') = 'number' AND ((NEW.history_json::jsonb ->> 'granted_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'granted_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'withdrawn_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'withdrawn_at') = 'number' AND ((NEW.history_json::jsonb ->> 'withdrawn_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'withdrawn_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'expires_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'expires_at') = 'number' AND ((NEW.history_json::jsonb ->> 'expires_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'expires_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'retain_until') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'retain_until') = 'number' AND ((NEW.history_json::jsonb ->> 'retain_until'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'retain_until'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'consent_settings_snapshot_at') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'consent_settings_snapshot_at') = 'number' AND ((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'consent_settings_snapshot_at'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'record_retention_days_snapshot') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'record_retention_days_snapshot') = 'number' AND ((NEW.history_json::jsonb ->> 'record_retention_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'record_retention_days_snapshot'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'reconsent_interval_days_snapshot') = 'null' OR (jsonb_typeof(NEW.history_json::jsonb -> 'reconsent_interval_days_snapshot') = 'number' AND ((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'reconsent_interval_days_snapshot'))::numeric,1)=0))) AND (NEW.is_noop=1 OR (jsonb_typeof(NEW.history_json::jsonb -> 'created_at') = 'number' AND ((NEW.history_json::jsonb ->> 'created_at'))::numeric BETWEEN 0 AND 9007199254740991 AND mod(((NEW.history_json::jsonb ->> 'created_at'))::numeric,1)=0)) THEN 0 ELSE 1 END = 1) OR NEW.admitted <> (CASE WHEN EXISTS (SELECT 1 FROM statement_consent_guards t JOIN statement_consent_guards s ON s.tenant_id = t.tenant_id
      WHERE t.tenant_id = NEW.tenant_id AND t.scope_kind = 'tenant' AND t.scope_key = '' AND t.mode = 'enforced'
        AND s.scope_kind = 'statement' AND s.scope_key = NEW.statement_id AND (s.mode = 'enforced' OR (NEW.action <> 'grant' AND s.mode = 'closed'))
        AND t.account_id = NEW.account_id AND s.account_id = NEW.account_id
        AND t.physical_id = NEW.physical_id AND s.physical_id = NEW.physical_id
        AND t.restore_epoch = NEW.restore_epoch AND s.restore_epoch = NEW.restore_epoch
        AND s.definition_generation = NEW.expected_definition_generation
        AND s.closed_generation = NEW.expected_closed_generation)
      AND EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id
        AND k.statement_id = NEW.statement_id AND k.account_id = NEW.account_id
        AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
        AND k.revision = NEW.expected_revision AND k.withdrawal_generation = NEW.expected_withdrawal_generation)
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN NEW.issued_at AND NEW.expires_at
      AND ((NEW.before_json IS NULL AND NOT EXISTS (SELECT 1 FROM user_consent_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id))
        OR EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id
          AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id
          AND jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = (NEW.before_json)::jsonb)) AND ((NEW.definition_json::jsonb ->> 'tenant_id')=NEW.tenant_id AND (NEW.definition_json::jsonb ->> 'statement_id')=NEW.statement_id AND CAST((NEW.definition_json::jsonb ->> 'definition_generation') AS BIGINT)=NEW.expected_definition_generation AND (NEW.definition_json::jsonb ->> 'version_id')=(NEW.after_json::jsonb ->> 'version_id') AND (NEW.definition_json::jsonb ->> 'version')=(NEW.after_json::jsonb ->> 'version') AND ((NEW.definition_json::jsonb ->> 'content_hash') IS NOT DISTINCT FROM (NEW.after_json::jsonb ->> 'content_hash')) AND (NEW.action<>'grant' OR (CAST((NEW.definition_json::jsonb ->> 'is_active') AS BIGINT)=1 AND (NEW.definition_json::jsonb ->> 'version_status')='active')))
      AND (NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = (NEW.history_json::jsonb ->> 'id'))) THEN 1 ELSE 0 END) THEN RAISE EXCEPTION 'statement_consent_operation_insert_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_operation_insert_guard BEFORE INSERT ON statement_consent_operations FOR EACH ROW EXECUTE FUNCTION statement_consent_operation_insert_guard_fn();

CREATE FUNCTION statement_consent_operation_finalize_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'executing' OR NOT (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) OR NOT (NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id) OR NOT (NEW.attempt_id IS NOT DISTINCT FROM OLD.attempt_id) OR NOT (NEW.payload_sha256 IS NOT DISTINCT FROM OLD.payload_sha256) OR NOT (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id) OR NOT (NEW.actor_type IS NOT DISTINCT FROM OLD.actor_type) OR NOT (NEW.action IS NOT DISTINCT FROM OLD.action) OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id) OR NOT (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) OR NOT (NEW.physical_id IS NOT DISTINCT FROM OLD.physical_id) OR NOT (NEW.restore_epoch IS NOT DISTINCT FROM OLD.restore_epoch) OR NOT (NEW.expected_revision IS NOT DISTINCT FROM OLD.expected_revision) OR NOT (NEW.expected_withdrawal_generation IS NOT DISTINCT FROM OLD.expected_withdrawal_generation) OR NOT (NEW.expected_definition_generation IS NOT DISTINCT FROM OLD.expected_definition_generation) OR NOT (NEW.expected_closed_generation IS NOT DISTINCT FROM OLD.expected_closed_generation) OR NOT (NEW.issued_at IS NOT DISTINCT FROM OLD.issued_at) OR NOT (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) OR NOT (NEW.effect_at IS NOT DISTINCT FROM OLD.effect_at) OR NOT (NEW.definition_json IS NOT DISTINCT FROM OLD.definition_json) OR NOT (NEW.before_json IS NOT DISTINCT FROM OLD.before_json) OR NOT (NEW.after_json IS NOT DISTINCT FROM OLD.after_json) OR NOT (NEW.history_json IS NOT DISTINCT FROM OLD.history_json) OR NOT (NEW.admitted IS NOT DISTINCT FROM OLD.admitted) OR NOT (NEW.is_noop IS NOT DISTINCT FROM OLD.is_noop) OR NOT (NEW.required_terminal IS NOT DISTINCT FROM OLD.required_terminal) OR NEW.is_terminal <> 1 OR (NEW.admitted = 0 AND NEW.status <> 'rejected') OR (NEW.admitted = 1 AND (NEW.status <> 'applied' OR NOT (CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN NEW.issued_at AND NEW.expires_at) OR NOT (EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id AND k.statement_id = NEW.statement_id
      AND k.account_id = NEW.account_id AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
      AND k.revision = NEW.expected_revision + CASE WHEN NEW.is_noop = 1 THEN 0 ELSE 1 END
      AND k.withdrawal_generation = NEW.expected_withdrawal_generation + CASE WHEN NEW.is_noop = 0 AND NEW.action IN ('deny', 'withdraw') THEN 1 ELSE 0 END
      AND (NEW.is_noop = 1 OR k.last_operation_id = NEW.operation_id)) AND EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id
      AND r.statement_id = NEW.statement_id AND jsonb_build_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = (NEW.after_json)::jsonb) AND ((NEW.is_noop = 1 AND NEW.before_json = NEW.after_json) OR
      (NEW.is_noop = 0 AND EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = (NEW.history_json::jsonb ->> 'id')
        AND h.tenant_id = NEW.tenant_id AND jsonb_build_object('id', h.id, 'tenant_id', h.tenant_id, 'user_id', h.user_id, 'statement_id', h.statement_id, 'action', h.action, 'version_before', h.version_before, 'version_after', h.version_after, 'status_before', h.status_before, 'status_after', h.status_after, 'client_id', h.client_id, 'created_at', h.created_at, 'version_id_before', h.version_id_before, 'version_id_after', h.version_id_after, 'granted_at', h.granted_at, 'withdrawn_at', h.withdrawn_at, 'expires_at', h.expires_at, 'retain_until', h.retain_until, 'consent_settings_snapshot_at', h.consent_settings_snapshot_at, 'record_retention_days_snapshot', h.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', h.reconsent_interval_days_snapshot, 'content_hash_after', h.content_hash_after) = (NEW.history_json)::jsonb))) AND (NEW.before_json IS NULL OR NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h
      WHERE h.tenant_id = NEW.tenant_id AND h.user_id = NEW.user_id AND h.statement_id = NEW.statement_id
        AND (h.retain_until IS NULL OR h.retain_until < CAST((NEW.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NOT (h.retain_until IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'retain_until') AS BIGINT)) OR NOT (h.consent_settings_snapshot_at IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'consent_settings_snapshot_at') AS BIGINT)) OR NOT (h.record_retention_days_snapshot IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'record_retention_days_snapshot') AS BIGINT)) OR NOT (h.reconsent_interval_days_snapshot IS NOT DISTINCT FROM CAST((NEW.after_json::jsonb ->> 'reconsent_interval_days_snapshot') AS BIGINT)))))))) THEN RAISE EXCEPTION 'statement_consent_operation_finalize_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_operation_finalize_guard BEFORE UPDATE ON statement_consent_operations FOR EACH ROW EXECUTE FUNCTION statement_consent_operation_finalize_guard_fn();

CREATE FUNCTION statement_consent_operation_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_terminal = 0 THEN RAISE EXCEPTION 'statement_consent_operation_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_operation_delete_guard BEFORE DELETE ON statement_consent_operations FOR EACH ROW EXECUTE FUNCTION statement_consent_operation_delete_guard_fn();

CREATE FUNCTION statement_consent_user_consent_records_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = (o.after_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_insert_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_user_consent_records_insert_guard BEFORE INSERT ON user_consent_records FOR EACH ROW EXECUTE FUNCTION statement_consent_user_consent_records_insert_guard_fn();

CREATE FUNCTION statement_consent_user_consent_records_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = (o.after_json)::jsonb) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id AND o.status = 'executing' AND jsonb_build_object('id', OLD.id, 'tenant_id', OLD.tenant_id, 'user_id', OLD.user_id, 'statement_id', OLD.statement_id, 'version_id', OLD.version_id, 'version', OLD.version, 'status', OLD.status, 'granted_at', OLD.granted_at, 'withdrawn_at', OLD.withdrawn_at, 'expires_at', OLD.expires_at, 'client_id', OLD.client_id, 'receipt_id', OLD.receipt_id, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'retain_until', OLD.retain_until, 'consent_settings_snapshot_at', OLD.consent_settings_snapshot_at, 'record_retention_days_snapshot', OLD.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', OLD.reconsent_interval_days_snapshot, 'content_hash', OLD.content_hash) = (o.before_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_update_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_user_consent_records_update_guard BEFORE UPDATE ON user_consent_records FOR EACH ROW EXECUTE FUNCTION statement_consent_user_consent_records_update_guard_fn();

CREATE FUNCTION statement_consent_user_consent_records_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='record' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)
      AND OLD.status IN ('withdrawn','denied','expired')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.updated_at<p.cutoff_at-p.legacy_retention_days*86400000)))) THEN RAISE EXCEPTION 'statement_consent_user_consent_records_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_user_consent_records_delete_guard BEFORE DELETE ON user_consent_records FOR EACH ROW EXECUTE FUNCTION statement_consent_user_consent_records_delete_guard_fn();

CREATE FUNCTION statement_consent_consent_item_history_insert_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
              AND jsonb_build_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'action', NEW.action, 'version_before', NEW.version_before, 'version_after', NEW.version_after, 'status_before', NEW.status_before, 'status_after', NEW.status_after, 'client_id', NEW.client_id, 'created_at', NEW.created_at, 'version_id_before', NEW.version_id_before, 'version_id_after', NEW.version_id_after, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash_after', NEW.content_hash_after) = (o.history_json)::jsonb)) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_insert_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_consent_item_history_insert_guard BEFORE INSERT ON consent_item_history FOR EACH ROW EXECUTE FUNCTION statement_consent_consent_item_history_insert_guard_fn();

CREATE FUNCTION statement_consent_consent_item_history_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (((NEW.id IS NOT DISTINCT FROM OLD.id) AND (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) AND (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) AND (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) AND (NEW.action IS NOT DISTINCT FROM OLD.action) AND (NEW.version_before IS NOT DISTINCT FROM OLD.version_before) AND (NEW.version_after IS NOT DISTINCT FROM OLD.version_after) AND (NEW.status_before IS NOT DISTINCT FROM OLD.status_before) AND (NEW.status_after IS NOT DISTINCT FROM OLD.status_after) AND (NEW.client_id IS NOT DISTINCT FROM OLD.client_id) AND (NEW.created_at IS NOT DISTINCT FROM OLD.created_at) AND (NEW.version_id_before IS NOT DISTINCT FROM OLD.version_id_before) AND (NEW.version_id_after IS NOT DISTINCT FROM OLD.version_id_after) AND (NEW.granted_at IS NOT DISTINCT FROM OLD.granted_at) AND (NEW.withdrawn_at IS NOT DISTINCT FROM OLD.withdrawn_at) AND (NEW.expires_at IS NOT DISTINCT FROM OLD.expires_at) AND (NEW.ip_address_hash IS NOT DISTINCT FROM OLD.ip_address_hash) AND (NEW.user_agent IS NOT DISTINCT FROM OLD.user_agent) AND (NEW.content_hash_after IS NOT DISTINCT FROM OLD.content_hash_after) AND (NEW.metadata_json IS NOT DISTINCT FROM OLD.metadata_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
                  AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.before_json IS NOT NULL AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
                  AND (OLD.retain_until IS NULL OR OLD.retain_until < CAST((o.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NEW.retain_until IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'retain_until') AS BIGINT)) AND (NEW.consent_settings_snapshot_at IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'consent_settings_snapshot_at') AS BIGINT)) AND (NEW.record_retention_days_snapshot IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'record_retention_days_snapshot') AS BIGINT)) AND (NEW.reconsent_interval_days_snapshot IS NOT DISTINCT FROM CAST((o.after_json::jsonb ->> 'reconsent_interval_days_snapshot') AS BIGINT)))) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_update_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_consent_item_history_update_guard BEFORE UPDATE ON consent_item_history FOR EACH ROW EXECUTE FUNCTION statement_consent_consent_item_history_update_guard_fn();

CREATE FUNCTION statement_consent_consent_item_history_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='history' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT)
      AND NOT EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id=OLD.tenant_id AND r.user_id=OLD.user_id AND r.statement_id=OLD.statement_id AND r.status='granted')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.created_at<p.cutoff_at-p.legacy_retention_days*86400000)))) THEN RAISE EXCEPTION 'statement_consent_consent_item_history_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_consent_item_history_delete_guard BEFORE DELETE ON consent_item_history FOR EACH ROW EXECUTE FUNCTION statement_consent_consent_item_history_delete_guard_fn();

CREATE FUNCTION statement_consent_key_update_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id) OR NOT (NEW.user_id IS NOT DISTINCT FROM OLD.user_id) OR NOT (NEW.statement_id IS NOT DISTINCT FROM OLD.statement_id) OR NOT (NEW.account_id IS NOT DISTINCT FROM OLD.account_id) OR NOT (NEW.physical_id IS NOT DISTINCT FROM OLD.physical_id) OR NOT (NEW.restore_epoch IS NOT DISTINCT FROM OLD.restore_epoch) OR NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
      AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.account_id = OLD.account_id AND CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) BETWEEN o.issued_at AND o.expires_at
      AND OLD.revision = o.expected_revision AND OLD.withdrawal_generation = o.expected_withdrawal_generation
      AND NEW.revision = OLD.revision + 1 AND NEW.withdrawal_generation = OLD.withdrawal_generation + CASE WHEN o.action IN ('deny','withdraw') THEN 1 ELSE 0 END
      AND NEW.last_operation_id = o.operation_id AND NEW.updated_at >= OLD.updated_at)) THEN RAISE EXCEPTION 'statement_consent_key_update_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_key_update_guard BEFORE UPDATE ON statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION statement_consent_key_update_guard_fn();

CREATE FUNCTION statement_consent_key_delete_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled') THEN RAISE EXCEPTION 'statement_consent_key_delete_guard'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_key_delete_guard BEFORE DELETE ON statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION statement_consent_key_delete_guard_fn();

CREATE FUNCTION statement_consent_guards_replace_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_guards r WHERE r.tenant_id = NEW.tenant_id AND r.scope_kind = NEW.scope_kind AND r.scope_key = NEW.scope_key) THEN RAISE EXCEPTION 'statement_consent_guards_replace_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_guards_replace_guard BEFORE INSERT ON statement_consent_guards FOR EACH ROW EXECUTE FUNCTION statement_consent_guards_replace_guard_fn();

CREATE FUNCTION statement_consent_key_states_replace_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_key_states r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id) THEN RAISE EXCEPTION 'statement_consent_key_states_replace_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_key_states_replace_guard BEFORE INSERT ON statement_consent_key_states FOR EACH ROW EXECUTE FUNCTION statement_consent_key_states_replace_guard_fn();

CREATE FUNCTION statement_consent_admissions_replace_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM statement_consent_admissions r WHERE r.tenant_id = NEW.tenant_id AND r.operation_id = NEW.operation_id) THEN RAISE EXCEPTION 'statement_consent_admissions_replace_guard'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_admissions_replace_guard BEFORE INSERT ON statement_consent_admissions FOR EACH ROW EXECUTE FUNCTION statement_consent_admissions_replace_guard_fn();

CREATE FUNCTION statement_consent_guard_monotonic_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_key <> OLD.scope_key OR NEW.definition_generation < OLD.definition_generation OR NEW.closed_generation < OLD.closed_generation OR NEW.account_id <> OLD.account_id OR NEW.physical_id <> OLD.physical_id OR NEW.restore_epoch <> OLD.restore_epoch OR NEW.updated_at < OLD.updated_at OR (OLD.mode = 'closed' AND NEW.mode <> 'closed' AND NOT (OLD.scope_kind = 'statement' AND NEW.mode = 'enforced' AND NEW.definition_generation > OLD.definition_generation)) OR (OLD.mode = 'enforced' AND NEW.mode = 'disabled') THEN RAISE EXCEPTION 'statement_consent_guard_monotonic'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_guard_monotonic BEFORE UPDATE ON statement_consent_guards FOR EACH ROW EXECUTE FUNCTION statement_consent_guard_monotonic_fn();

CREATE FUNCTION statement_consent_guard_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.mode <> 'disabled' THEN RAISE EXCEPTION 'statement_consent_guard_delete'; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER statement_consent_guard_delete BEFORE DELETE ON statement_consent_guards FOR EACH ROW EXECUTE FUNCTION statement_consent_guard_delete_fn();

CREATE FUNCTION statement_consent_admission_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TRUE THEN RAISE EXCEPTION 'statement_consent_admission_immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER statement_consent_admission_immutable BEFORE UPDATE ON statement_consent_admissions FOR EACH ROW EXECUTE FUNCTION statement_consent_admission_immutable_fn();

CREATE FUNCTION statement_consent_retention_permit_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'statement_consent_retention_permit_immutable'; END;
$$;
CREATE TRIGGER statement_consent_retention_permit_immutable BEFORE UPDATE ON statement_consent_retention_permits FOR EACH ROW EXECUTE FUNCTION statement_consent_retention_permit_immutable_fn();
