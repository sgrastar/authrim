-- Statement consent step B: additive tables only. Triggers and D1 FK removal follow in PR7.
-- Guards are rebuilt projections; target restore identity must be rebound before writes.

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

-- Metadata-owned durable projection work, co-committed with the definition generation bump.
CREATE TABLE statement_consent_projection_jobs (
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  closed_generation INTEGER NOT NULL CHECK (closed_generation BETWEEN 0 AND 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('enforced', 'closed')),
  targets_json TEXT,
  cursor_binding_ref TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, statement_id)
) WITHOUT ROWID;
