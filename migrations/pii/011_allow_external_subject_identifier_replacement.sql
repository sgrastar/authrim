-- Allow durable replacement of the SCIM userName external-subject identifier.

PRAGMA foreign_keys = OFF;

DROP TRIGGER IF EXISTS trg_identifier_replacement_history_immutable;

CREATE TABLE identity_identifier_replacement_operations_next (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identifier_kind TEXT NOT NULL
    CHECK (identifier_kind IN ('email_exact', 'external_subject')),
  authority TEXT NOT NULL CHECK (authority IN ('self_service', 'admin', 'scim', 'external_idp')),
  idempotency_key_sha256 TEXT NOT NULL CHECK (length(idempotency_key_sha256) = 64),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64),
  challenge_id TEXT,
  initiating_session_ref TEXT,
  state TEXT NOT NULL DEFAULT 'directory_pending'
    CHECK (state IN (
      'directory_pending',
      'authoritative_switch_pending',
      'authoritative_switched',
      'revocation_pending',
      'completed',
      'blocked_forward_repair',
      'canceled'
    )),
  outbox_id TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  retry_budget_expires_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  error_code TEXT,
  authoritative_switched_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (challenge_id) REFERENCES identity_identifier_replacement_challenges(challenge_id),
  UNIQUE (tenant_id, authority, idempotency_key_sha256),
  CHECK ((authority = 'self_service' AND challenge_id IS NOT NULL AND
          initiating_session_ref IS NOT NULL AND identifier_kind = 'email_exact') OR
         authority <> 'self_service'),
  CHECK ((state IN ('authoritative_switched', 'revocation_pending', 'completed',
                    'blocked_forward_repair') AND authoritative_switched_at IS NOT NULL) OR
         state IN ('directory_pending', 'authoritative_switch_pending', 'canceled')),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL) OR state <> 'completed'),
  CHECK (retry_budget_expires_at > created_at)
);

INSERT INTO identity_identifier_replacement_operations_next (
  operation_id, tenant_id, account_id, identifier_kind, authority,
  idempotency_key_sha256, request_fingerprint_sha256, challenge_id,
  initiating_session_ref, state, outbox_id, attempt_count, next_attempt_at,
  retry_budget_expires_at, lease_owner, lease_expires_at, fencing_token,
  error_code, authoritative_switched_at, completed_at, created_at, updated_at
)
SELECT
  operation_id, tenant_id, account_id, identifier_kind, authority,
  idempotency_key_sha256, request_fingerprint_sha256, challenge_id,
  initiating_session_ref, state, outbox_id, attempt_count, next_attempt_at,
  retry_budget_expires_at, lease_owner, lease_expires_at, fencing_token,
  error_code, authoritative_switched_at, completed_at, created_at, updated_at
FROM identity_identifier_replacement_operations;

DROP TABLE identity_identifier_replacement_operations;
ALTER TABLE identity_identifier_replacement_operations_next
  RENAME TO identity_identifier_replacement_operations;

CREATE INDEX idx_identifier_replacement_operation_due
  ON identity_identifier_replacement_operations(state, next_attempt_at, lease_expires_at);
CREATE UNIQUE INDEX idx_identifier_replacement_operation_account_active
  ON identity_identifier_replacement_operations(tenant_id, account_id, identifier_kind)
  WHERE state NOT IN ('completed', 'canceled');

CREATE TRIGGER trg_identifier_replacement_history_immutable
BEFORE UPDATE ON identity_identifier_replacement_history
WHEN NOT (
  OLD.raw_values_erased_at IS NULL AND NEW.raw_values_erased_at IS NOT NULL AND
  NEW.old_value_json IS NULL AND NEW.new_value_json IS NULL AND
  NEW.operation_id = OLD.operation_id AND
  NEW.old_value_sha256 = OLD.old_value_sha256 AND
  NEW.new_value_sha256 = OLD.new_value_sha256 AND
  NEW.normalization_version = OLD.normalization_version AND
  NEW.actor_ref = OLD.actor_ref AND
  NEW.authority_evidence_json = OLD.authority_evidence_json AND
  NEW.verification_evidence_json = OLD.verification_evidence_json AND
  NEW.created_at = OLD.created_at AND
  EXISTS (
    SELECT 1 FROM identity_identifier_replacement_operations operation
     WHERE operation.operation_id = OLD.operation_id
       AND operation.state IN ('completed', 'canceled')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'identifier_replacement_history_immutable');
END;

PRAGMA foreign_keys = ON;
