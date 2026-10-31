-- Step-B enforcement fixture; production trigger parity is pinned by tests.
-- Existing consent tables/FKs/indexes are not rebuilt or altered.

CREATE TABLE IF NOT EXISTS tenant_backup_restore_targets (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
  seed_fingerprint TEXT NOT NULL CHECK(length(seed_fingerprint)=64),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  lease_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('loading','sealed','invalid'))
);

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
  cutoff_at INTEGER NOT NULL CHECK (cutoff_at BETWEEN 0 AND 9007199254740991) CHECK(typeof(cutoff_at)='integer'),
  legacy_retention_days INTEGER CHECK (legacy_retention_days BETWEEN 0 AND 9007199254740991 / 86400000) CHECK(legacy_retention_days IS NULL OR typeof(legacy_retention_days)='integer'),
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991) CHECK(typeof(issued_at)='integer'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991) CHECK(typeof(expires_at)='integer'),
  PRIMARY KEY (tenant_id,permit_id)
) WITHOUT ROWID;

CREATE TABLE statement_consent_guards (
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'statement')),
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'enforced', 'closed')),
  definition_generation INTEGER NOT NULL DEFAULT 0 CHECK (definition_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(definition_generation) = 'integer'),
  closed_generation INTEGER NOT NULL DEFAULT 0 CHECK (closed_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(closed_generation) = 'integer'),
  account_id TEXT NOT NULL DEFAULT '',
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991) CHECK (typeof(updated_at) = 'integer'),
  PRIMARY KEY (tenant_id, scope_kind, scope_key),
  CHECK ((scope_kind = 'tenant' AND scope_key = '') OR (scope_kind = 'statement' AND length(scope_key) > 0))
) WITHOUT ROWID;
CREATE TABLE statement_consent_key_states (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991) CHECK (typeof(revision) = 'integer'),
  withdrawal_generation INTEGER NOT NULL CHECK (withdrawal_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(withdrawal_generation) = 'integer'),
  last_operation_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(updated_at) = 'integer'),
  PRIMARY KEY (tenant_id, user_id, statement_id)
) WITHOUT ROWID;
CREATE TABLE statement_consent_operations (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 64 AND operation_id NOT GLOB '*[^a-f0-9]*'),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  actor_type TEXT NOT NULL CHECK (length(actor_type) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('grant', 'deny', 'withdraw')),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990) CHECK (typeof(expected_revision) = 'integer'),
  expected_withdrawal_generation INTEGER NOT NULL CHECK (expected_withdrawal_generation BETWEEN 0 AND 9007199254740990) CHECK (typeof(expected_withdrawal_generation) = 'integer'),
  expected_definition_generation INTEGER NOT NULL CHECK (expected_definition_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(expected_definition_generation) = 'integer'),
  expected_closed_generation INTEGER NOT NULL CHECK (expected_closed_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(expected_closed_generation) = 'integer'),
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(issued_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991) CHECK (typeof(expires_at) = 'integer'),
  effect_at INTEGER NOT NULL CHECK (effect_at BETWEEN issued_at AND expires_at) CHECK (typeof(effect_at) = 'integer'),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json) = 'object'),
  before_json TEXT,
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  history_json TEXT CHECK (history_json IS NULL OR (json_valid(history_json) AND json_type(history_json) = 'object')),
  admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)) CHECK (typeof(admitted) = 'integer'),
  is_noop INTEGER NOT NULL CHECK (is_noop IN (0, 1)) CHECK (typeof(is_noop) = 'integer'),
  status TEXT NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'applied', 'rejected')),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)) CHECK (typeof(is_terminal) = 'integer'),
  required_terminal INTEGER NOT NULL DEFAULT 1 CHECK (required_terminal = 1) CHECK (typeof(required_terminal) = 'integer'),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (tenant_id, operation_id, is_terminal),
  CHECK ((status = 'executing' AND is_terminal = 0) OR (status IN ('applied', 'rejected') AND is_terminal = 1)),
  CHECK (before_json IS NULL OR (json_valid(before_json) AND json_type(before_json) = 'object')),
  CHECK ((is_noop = 1 AND history_json IS NULL AND before_json IS NOT NULL) OR (is_noop = 0 AND history_json IS NOT NULL)),
  FOREIGN KEY (tenant_id, operation_id, required_terminal)
    REFERENCES statement_consent_operations (tenant_id, operation_id, is_terminal)
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
CREATE UNIQUE INDEX idx_statement_consent_one_executing_key ON statement_consent_operations
  (tenant_id, user_id, statement_id) WHERE is_terminal = 0;
CREATE TABLE statement_consent_admissions (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 64 AND operation_id NOT GLOB '*[^a-f0-9]*'),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  statement_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(definition_generation) = 'integer'),
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(issued_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991) CHECK (typeof(expires_at) = 'integer'),
  PRIMARY KEY (tenant_id, operation_id)
) WITHOUT ROWID;

CREATE TRIGGER statement_consent_operation_insert_guard BEFORE INSERT ON statement_consent_operations
WHEN NOT (NEW.is_terminal=1 AND NEW.status IN ('applied','rejected')
    AND EXISTS (SELECT 1 FROM tenant_backup_restore_targets t WHERE t.tenant_id=NEW.tenant_id
      AND t.state='loading' AND t.lease_expires_at>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      AND NEW.physical_id=t.resource_id AND NEW.restore_epoch=t.operation_id AND NEW.account_id='restore:' || t.resource_id)
    AND NOT EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=NEW.tenant_id AND o.operation_id=NEW.operation_id)) AND (NEW.status <> 'executing' OR NEW.is_terminal <> 0 OR EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND (o.operation_id = NEW.operation_id OR (o.user_id = NEW.user_id AND o.statement_id = NEW.statement_id AND o.is_terminal = 0))) OR (NOT (json_extract(NEW.after_json, '$.tenant_id') IS NEW.tenant_id) OR NOT (json_extract(NEW.after_json, '$.user_id') IS NEW.user_id) OR NOT (json_extract(NEW.after_json, '$.statement_id') IS NEW.statement_id)
      OR (NEW.is_noop = 1 AND (NEW.action <> 'grant' OR json(NEW.after_json) <> json(NEW.before_json) OR json_extract(NEW.after_json, '$.status') <> 'granted'))
      OR (NEW.is_noop = 0 AND (json_extract(NEW.history_json, '$.id') <> ('sc_' || NEW.operation_id || ':' || NEW.tenant_id)
        OR NOT (json_extract(NEW.history_json, '$.tenant_id') IS NEW.tenant_id)
        OR NOT (json_extract(NEW.history_json, '$.user_id') IS NEW.user_id)
        OR NOT (json_extract(NEW.history_json, '$.statement_id') IS NEW.statement_id)
        OR NOT (json_extract(NEW.history_json, '$.status_before') IS json_extract(NEW.before_json, '$.status'))
        OR NOT (json_extract(NEW.history_json, '$.status_after') IS json_extract(NEW.after_json, '$.status'))
        OR NOT (json_extract(NEW.history_json, '$.version_id_after') IS json_extract(NEW.after_json, '$.version_id'))
        OR NOT (json_extract(NEW.history_json, '$.version_after') IS json_extract(NEW.after_json, '$.version'))
        OR (NEW.action = 'grant' AND (json_extract(NEW.after_json, '$.status') <> 'granted' OR json_extract(NEW.history_json, '$.action') NOT IN ('granted','version_upgraded')))
        OR (NEW.action = 'withdraw' AND (json_extract(NEW.after_json, '$.status') <> 'withdrawn' OR json_extract(NEW.history_json, '$.action') <> 'withdrawn'))
        OR (NEW.action = 'deny' AND (json_extract(NEW.after_json, '$.status') NOT IN ('denied','withdrawn') OR json_extract(NEW.history_json, '$.action') NOT IN ('denied','withdrawn')))))
      OR (NEW.before_json IS NOT NULL AND (json_extract(NEW.after_json, '$.id') <> json_extract(NEW.before_json, '$.id')
        OR json_extract(NEW.after_json, '$.created_at') <> json_extract(NEW.before_json, '$.created_at')
        OR json_extract(NEW.after_json, '$.updated_at') < json_extract(NEW.before_json, '$.updated_at'))) OR (NEW.is_noop = 0 AND NOT ((json_extract(NEW.history_json, '$.content_hash_after') IS json_extract(NEW.after_json, '$.content_hash')) AND (json_extract(NEW.history_json, '$.version_id_after') IS json_extract(NEW.after_json, '$.version_id')) AND (json_extract(NEW.history_json, '$.version_after') IS json_extract(NEW.after_json, '$.version')) AND (json_extract(NEW.history_json, '$.status_after') IS json_extract(NEW.after_json, '$.status')) AND (json_extract(NEW.history_json, '$.granted_at') IS json_extract(NEW.after_json, '$.granted_at')) AND (json_extract(NEW.history_json, '$.withdrawn_at') IS json_extract(NEW.after_json, '$.withdrawn_at')) AND (json_extract(NEW.history_json, '$.expires_at') IS json_extract(NEW.after_json, '$.expires_at')) AND (json_extract(NEW.history_json, '$.retain_until') IS json_extract(NEW.after_json, '$.retain_until')) AND (json_extract(NEW.history_json, '$.consent_settings_snapshot_at') IS json_extract(NEW.after_json, '$.consent_settings_snapshot_at')) AND (json_extract(NEW.history_json, '$.record_retention_days_snapshot') IS json_extract(NEW.after_json, '$.record_retention_days_snapshot')) AND (json_extract(NEW.history_json, '$.reconsent_interval_days_snapshot') IS json_extract(NEW.after_json, '$.reconsent_interval_days_snapshot')))) OR CASE WHEN (json_type(NEW.after_json, '$.created_at') = 'integer' AND json_extract(NEW.after_json, '$.created_at') BETWEEN 0 AND 9007199254740991) AND (json_type(NEW.after_json, '$.updated_at') = 'integer' AND json_extract(NEW.after_json, '$.updated_at') BETWEEN 0 AND 9007199254740991) AND (json_type(NEW.after_json, '$.granted_at') = 'null' OR (json_type(NEW.after_json, '$.granted_at') = 'integer' AND json_extract(NEW.after_json, '$.granted_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.withdrawn_at') = 'null' OR (json_type(NEW.after_json, '$.withdrawn_at') = 'integer' AND json_extract(NEW.after_json, '$.withdrawn_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.expires_at') = 'null' OR (json_type(NEW.after_json, '$.expires_at') = 'integer' AND json_extract(NEW.after_json, '$.expires_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.retain_until') = 'null' OR (json_type(NEW.after_json, '$.retain_until') = 'integer' AND json_extract(NEW.after_json, '$.retain_until') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.consent_settings_snapshot_at') = 'null' OR (json_type(NEW.after_json, '$.consent_settings_snapshot_at') = 'integer' AND json_extract(NEW.after_json, '$.consent_settings_snapshot_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.record_retention_days_snapshot') = 'null' OR (json_type(NEW.after_json, '$.record_retention_days_snapshot') = 'integer' AND json_extract(NEW.after_json, '$.record_retention_days_snapshot') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.reconsent_interval_days_snapshot') = 'null' OR (json_type(NEW.after_json, '$.reconsent_interval_days_snapshot') = 'integer' AND json_extract(NEW.after_json, '$.reconsent_interval_days_snapshot') BETWEEN 0 AND 9007199254740991)) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.granted_at') = 'null' OR (json_type(NEW.history_json, '$.granted_at') = 'integer' AND json_extract(NEW.history_json, '$.granted_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.withdrawn_at') = 'null' OR (json_type(NEW.history_json, '$.withdrawn_at') = 'integer' AND json_extract(NEW.history_json, '$.withdrawn_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.expires_at') = 'null' OR (json_type(NEW.history_json, '$.expires_at') = 'integer' AND json_extract(NEW.history_json, '$.expires_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.retain_until') = 'null' OR (json_type(NEW.history_json, '$.retain_until') = 'integer' AND json_extract(NEW.history_json, '$.retain_until') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.consent_settings_snapshot_at') = 'null' OR (json_type(NEW.history_json, '$.consent_settings_snapshot_at') = 'integer' AND json_extract(NEW.history_json, '$.consent_settings_snapshot_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.record_retention_days_snapshot') = 'null' OR (json_type(NEW.history_json, '$.record_retention_days_snapshot') = 'integer' AND json_extract(NEW.history_json, '$.record_retention_days_snapshot') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.reconsent_interval_days_snapshot') = 'null' OR (json_type(NEW.history_json, '$.reconsent_interval_days_snapshot') = 'integer' AND json_extract(NEW.history_json, '$.reconsent_interval_days_snapshot') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.created_at') = 'integer' AND json_extract(NEW.history_json, '$.created_at') BETWEEN 0 AND 9007199254740991)) THEN 0 ELSE 1 END = 1) OR NEW.admitted <> CASE WHEN EXISTS (SELECT 1 FROM statement_consent_guards t JOIN statement_consent_guards s ON s.tenant_id = t.tenant_id
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
      AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN NEW.issued_at AND NEW.expires_at
      AND ((NEW.before_json IS NULL AND NOT EXISTS (SELECT 1 FROM user_consent_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id))
        OR EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id
          AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id
          AND json_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = json(NEW.before_json))) AND (json_extract(NEW.definition_json, '$.tenant_id')=NEW.tenant_id AND json_extract(NEW.definition_json, '$.statement_id')=NEW.statement_id AND CAST(json_extract(NEW.definition_json, '$.definition_generation') AS INTEGER)=NEW.expected_definition_generation AND json_extract(NEW.definition_json, '$.version_id')=json_extract(NEW.after_json, '$.version_id') AND json_extract(NEW.definition_json, '$.version')=json_extract(NEW.after_json, '$.version') AND (json_extract(NEW.definition_json, '$.content_hash') IS json_extract(NEW.after_json, '$.content_hash')) AND (NEW.action<>'grant' OR (CAST(json_extract(NEW.definition_json, '$.is_active') AS INTEGER)=1 AND json_extract(NEW.definition_json, '$.version_status')='active')))
      AND (NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = json_extract(NEW.history_json, '$.id'))) THEN 1 ELSE 0 END)
BEGIN SELECT RAISE(ABORT, 'statement_consent_operation_insert_guard'); END;

CREATE TRIGGER statement_consent_operation_finalize_guard BEFORE UPDATE ON statement_consent_operations
WHEN OLD.status <> 'executing' OR NOT (NEW.tenant_id IS OLD.tenant_id) OR NOT (NEW.operation_id IS OLD.operation_id) OR NOT (NEW.attempt_id IS OLD.attempt_id) OR NOT (NEW.payload_sha256 IS OLD.payload_sha256) OR NOT (NEW.actor_id IS OLD.actor_id) OR NOT (NEW.actor_type IS OLD.actor_type) OR NOT (NEW.action IS OLD.action) OR NOT (NEW.user_id IS OLD.user_id) OR NOT (NEW.account_id IS OLD.account_id) OR NOT (NEW.statement_id IS OLD.statement_id) OR NOT (NEW.physical_id IS OLD.physical_id) OR NOT (NEW.restore_epoch IS OLD.restore_epoch) OR NOT (NEW.expected_revision IS OLD.expected_revision) OR NOT (NEW.expected_withdrawal_generation IS OLD.expected_withdrawal_generation) OR NOT (NEW.expected_definition_generation IS OLD.expected_definition_generation) OR NOT (NEW.expected_closed_generation IS OLD.expected_closed_generation) OR NOT (NEW.issued_at IS OLD.issued_at) OR NOT (NEW.expires_at IS OLD.expires_at) OR NOT (NEW.effect_at IS OLD.effect_at) OR NOT (NEW.definition_json IS OLD.definition_json) OR NOT (NEW.before_json IS OLD.before_json) OR NOT (NEW.after_json IS OLD.after_json) OR NOT (NEW.history_json IS OLD.history_json) OR NOT (NEW.admitted IS OLD.admitted) OR NOT (NEW.is_noop IS OLD.is_noop) OR NOT (NEW.required_terminal IS OLD.required_terminal) OR NEW.is_terminal <> 1 OR (NEW.admitted = 0 AND NEW.status <> 'rejected') OR (NEW.admitted = 1 AND (NEW.status <> 'applied' OR NOT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN NEW.issued_at AND NEW.expires_at) OR NOT (EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id AND k.statement_id = NEW.statement_id
      AND k.account_id = NEW.account_id AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
      AND k.revision = NEW.expected_revision + CASE WHEN NEW.is_noop = 1 THEN 0 ELSE 1 END
      AND k.withdrawal_generation = NEW.expected_withdrawal_generation + CASE WHEN NEW.is_noop = 0 AND NEW.action IN ('deny', 'withdraw') THEN 1 ELSE 0 END
      AND (NEW.is_noop = 1 OR k.last_operation_id = NEW.operation_id)) AND EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id
      AND r.statement_id = NEW.statement_id AND json_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = json(NEW.after_json)) AND ((NEW.is_noop = 1 AND NEW.before_json = NEW.after_json) OR
      (NEW.is_noop = 0 AND EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = json_extract(NEW.history_json, '$.id')
        AND h.tenant_id = NEW.tenant_id AND json_object('id', h.id, 'tenant_id', h.tenant_id, 'user_id', h.user_id, 'statement_id', h.statement_id, 'action', h.action, 'version_before', h.version_before, 'version_after', h.version_after, 'status_before', h.status_before, 'status_after', h.status_after, 'client_id', h.client_id, 'created_at', h.created_at, 'version_id_before', h.version_id_before, 'version_id_after', h.version_id_after, 'granted_at', h.granted_at, 'withdrawn_at', h.withdrawn_at, 'expires_at', h.expires_at, 'retain_until', h.retain_until, 'consent_settings_snapshot_at', h.consent_settings_snapshot_at, 'record_retention_days_snapshot', h.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', h.reconsent_interval_days_snapshot, 'content_hash_after', h.content_hash_after) = json(NEW.history_json)))) AND (NEW.before_json IS NULL OR NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h
      WHERE h.tenant_id = NEW.tenant_id AND h.user_id = NEW.user_id AND h.statement_id = NEW.statement_id
        AND (h.retain_until IS NULL OR h.retain_until < json_extract(NEW.after_json, '$.retain_until')) AND (NOT (h.retain_until IS json_extract(NEW.after_json, '$.retain_until')) OR NOT (h.consent_settings_snapshot_at IS json_extract(NEW.after_json, '$.consent_settings_snapshot_at')) OR NOT (h.record_retention_days_snapshot IS json_extract(NEW.after_json, '$.record_retention_days_snapshot')) OR NOT (h.reconsent_interval_days_snapshot IS json_extract(NEW.after_json, '$.reconsent_interval_days_snapshot'))))))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_operation_finalize_guard'); END;

CREATE TRIGGER statement_consent_operation_delete_guard BEFORE DELETE ON statement_consent_operations
WHEN OLD.is_terminal = 0
BEGIN SELECT RAISE(ABORT, 'statement_consent_operation_delete_guard'); END;

CREATE TRIGGER statement_consent_user_consent_records_insert_guard BEFORE INSERT ON user_consent_records
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
              AND json_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = json(o.after_json)))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_insert_guard'); END;

CREATE TRIGGER statement_consent_user_consent_records_insert_collision BEFORE INSERT ON user_consent_records
WHEN EXISTS (SELECT 1 FROM user_consent_records r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid OR (r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id)) AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_insert_collision'); END;

CREATE TRIGGER statement_consent_user_consent_records_update_guard BEFORE UPDATE ON user_consent_records
WHEN ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
              AND json_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = json(o.after_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id AND o.status = 'executing' AND json_object('id', OLD.id, 'tenant_id', OLD.tenant_id, 'user_id', OLD.user_id, 'statement_id', OLD.statement_id, 'version_id', OLD.version_id, 'version', OLD.version, 'status', OLD.status, 'granted_at', OLD.granted_at, 'withdrawn_at', OLD.withdrawn_at, 'expires_at', OLD.expires_at, 'client_id', OLD.client_id, 'receipt_id', OLD.receipt_id, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'retain_until', OLD.retain_until, 'consent_settings_snapshot_at', OLD.consent_settings_snapshot_at, 'record_retention_days_snapshot', OLD.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', OLD.reconsent_interval_days_snapshot, 'content_hash', OLD.content_hash) = json(o.before_json)))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_update_guard'); END;

CREATE TRIGGER statement_consent_user_consent_records_update_collision BEFORE UPDATE ON user_consent_records
WHEN EXISTS (SELECT 1 FROM user_consent_records r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid OR (r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id)) AND r.rowid <> OLD.rowid AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_update_collision'); END;

CREATE TRIGGER statement_consent_user_consent_records_delete_guard BEFORE DELETE ON user_consent_records
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='record' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND (CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
      AND OLD.status IN ('withdrawn','denied','expired')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.updated_at<p.cutoff_at-p.legacy_retention_days*86400000))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_delete_guard'); END;

CREATE TRIGGER statement_consent_consent_item_history_insert_guard BEFORE INSERT ON consent_item_history
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
              AND json_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'action', NEW.action, 'version_before', NEW.version_before, 'version_after', NEW.version_after, 'status_before', NEW.status_before, 'status_after', NEW.status_after, 'client_id', NEW.client_id, 'created_at', NEW.created_at, 'version_id_before', NEW.version_id_before, 'version_id_after', NEW.version_id_after, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash_after', NEW.content_hash_after) = json(o.history_json)))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_insert_guard'); END;

CREATE TRIGGER statement_consent_consent_item_history_insert_collision BEFORE INSERT ON consent_item_history
WHEN EXISTS (SELECT 1 FROM consent_item_history r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid) AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_insert_collision'); END;

CREATE TRIGGER statement_consent_consent_item_history_update_guard BEFORE UPDATE ON consent_item_history
WHEN ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (((NEW.id IS OLD.id) AND (NEW.tenant_id IS OLD.tenant_id) AND (NEW.user_id IS OLD.user_id) AND (NEW.statement_id IS OLD.statement_id) AND (NEW.action IS OLD.action) AND (NEW.version_before IS OLD.version_before) AND (NEW.version_after IS OLD.version_after) AND (NEW.status_before IS OLD.status_before) AND (NEW.status_after IS OLD.status_after) AND (NEW.client_id IS OLD.client_id) AND (NEW.created_at IS OLD.created_at) AND (NEW.version_id_before IS OLD.version_id_before) AND (NEW.version_id_after IS OLD.version_id_after) AND (NEW.granted_at IS OLD.granted_at) AND (NEW.withdrawn_at IS OLD.withdrawn_at) AND (NEW.expires_at IS OLD.expires_at) AND (NEW.ip_address_hash IS OLD.ip_address_hash) AND (NEW.user_agent IS OLD.user_agent) AND (NEW.content_hash_after IS OLD.content_hash_after) AND (NEW.metadata_json IS OLD.metadata_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
                  AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.before_json IS NOT NULL AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
                  AND (OLD.retain_until IS NULL OR OLD.retain_until < json_extract(o.after_json, '$.retain_until')) AND (NEW.retain_until IS json_extract(o.after_json, '$.retain_until')) AND (NEW.consent_settings_snapshot_at IS json_extract(o.after_json, '$.consent_settings_snapshot_at')) AND (NEW.record_retention_days_snapshot IS json_extract(o.after_json, '$.record_retention_days_snapshot')) AND (NEW.reconsent_interval_days_snapshot IS json_extract(o.after_json, '$.reconsent_interval_days_snapshot'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_update_guard'); END;

CREATE TRIGGER statement_consent_consent_item_history_update_collision BEFORE UPDATE ON consent_item_history
WHEN EXISTS (SELECT 1 FROM consent_item_history r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid) AND r.rowid <> OLD.rowid AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_update_collision'); END;

CREATE TRIGGER statement_consent_consent_item_history_delete_guard BEFORE DELETE ON consent_item_history
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='history' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND (CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
      AND NOT EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id=OLD.tenant_id AND r.user_id=OLD.user_id AND r.statement_id=OLD.statement_id AND r.status='granted')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.created_at<p.cutoff_at-p.legacy_retention_days*86400000))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_delete_guard'); END;

CREATE TRIGGER statement_consent_key_update_guard BEFORE UPDATE ON statement_consent_key_states
WHEN NOT (NEW.tenant_id IS OLD.tenant_id) OR NOT (NEW.user_id IS OLD.user_id) OR NOT (NEW.statement_id IS OLD.statement_id) OR NOT (NEW.account_id IS OLD.account_id) OR NOT (NEW.physical_id IS OLD.physical_id) OR NOT (NEW.restore_epoch IS OLD.restore_epoch) OR NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
      AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.account_id = OLD.account_id AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
      AND OLD.revision = o.expected_revision AND OLD.withdrawal_generation = o.expected_withdrawal_generation
      AND NEW.revision = OLD.revision + 1 AND NEW.withdrawal_generation = OLD.withdrawal_generation + CASE WHEN o.action IN ('deny','withdraw') THEN 1 ELSE 0 END
      AND NEW.last_operation_id = o.operation_id AND NEW.updated_at >= OLD.updated_at))
BEGIN SELECT RAISE(ABORT, 'statement_consent_key_update_guard'); END;

CREATE TRIGGER statement_consent_key_delete_guard BEFORE DELETE ON statement_consent_key_states
WHEN EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')
BEGIN SELECT RAISE(ABORT, 'statement_consent_key_delete_guard'); END;

CREATE TRIGGER statement_consent_guards_replace_guard BEFORE INSERT ON statement_consent_guards
WHEN EXISTS (SELECT 1 FROM statement_consent_guards r WHERE r.tenant_id = NEW.tenant_id AND r.scope_kind = NEW.scope_kind AND r.scope_key = NEW.scope_key)
BEGIN SELECT RAISE(ABORT, 'statement_consent_guards_replace_guard'); END;

CREATE TRIGGER statement_consent_key_states_replace_guard BEFORE INSERT ON statement_consent_key_states
WHEN EXISTS (SELECT 1 FROM statement_consent_key_states r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id)
BEGIN SELECT RAISE(ABORT, 'statement_consent_key_states_replace_guard'); END;

CREATE TRIGGER statement_consent_admissions_replace_guard BEFORE INSERT ON statement_consent_admissions
WHEN EXISTS (SELECT 1 FROM statement_consent_admissions r WHERE r.tenant_id = NEW.tenant_id AND r.operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'statement_consent_admissions_replace_guard'); END;

CREATE TRIGGER statement_consent_guard_monotonic BEFORE UPDATE ON statement_consent_guards
WHEN NEW.tenant_id <> OLD.tenant_id OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_key <> OLD.scope_key OR NEW.definition_generation < OLD.definition_generation OR NEW.closed_generation < OLD.closed_generation OR NEW.account_id <> OLD.account_id OR NEW.physical_id <> OLD.physical_id OR NEW.restore_epoch <> OLD.restore_epoch OR NEW.updated_at < OLD.updated_at OR (OLD.mode = 'closed' AND NEW.mode <> 'closed' AND NOT (OLD.scope_kind = 'statement' AND NEW.mode = 'enforced' AND NEW.definition_generation > OLD.definition_generation)) OR (OLD.mode = 'enforced' AND NEW.mode = 'disabled')
BEGIN SELECT RAISE(ABORT, 'statement_consent_guard_monotonic'); END;

CREATE TRIGGER statement_consent_guard_delete BEFORE DELETE ON statement_consent_guards
WHEN OLD.mode <> 'disabled'
BEGIN SELECT RAISE(ABORT, 'statement_consent_guard_delete'); END;

CREATE TRIGGER statement_consent_admission_immutable BEFORE UPDATE ON statement_consent_admissions
WHEN 1
BEGIN SELECT RAISE(ABORT, 'statement_consent_admission_immutable'); END;

CREATE TRIGGER statement_consent_retention_permit_immutable BEFORE UPDATE ON statement_consent_retention_permits
BEGIN SELECT RAISE(ABORT,'statement_consent_retention_permit_immutable'); END;
