-- Statement consent step B: additive tables only. Triggers and D1 FK removal follow in PR7.
-- Guards are rebuilt projections; target restore identity must be rebound before writes.

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

-- Metadata-owned durable projection work, co-committed with the definition generation bump.
CREATE TABLE statement_consent_projection_jobs (
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  definition_generation BIGINT NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  closed_generation BIGINT NOT NULL CHECK (closed_generation BETWEEN 0 AND 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('enforced', 'closed')),
  targets_json TEXT,
  cursor_binding_ref TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, statement_id)
);
