-- Authoritative identifier replacement state. Raw identifier values remain in Tenant PII.

CREATE TABLE IF NOT EXISTS identity_identifier_replacement_challenges (
  challenge_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identifier_kind TEXT NOT NULL CHECK (identifier_kind = 'email_exact'),
  normalized_value_json TEXT NOT NULL CHECK (json_valid(normalized_value_json)),
  raw_value_erased_at INTEGER,
  value_sha256 TEXT NOT NULL CHECK (length(value_sha256) = 64),
  otp_verifier TEXT NOT NULL CHECK (length(otp_verifier) = 64),
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sent', 'failed', 'unavailable')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 20),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  initiating_session_ref TEXT NOT NULL,
  recent_reauth_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (recent_reauth_verified_at <= created_at AND
         created_at - recent_reauth_verified_at <= 300),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= expires_at)),
  CHECK ((raw_value_erased_at IS NULL AND json_type(normalized_value_json) = 'text') OR
         (raw_value_erased_at IS NOT NULL AND normalized_value_json = 'null'))
);

CREATE INDEX IF NOT EXISTS idx_identifier_replacement_challenge_account
  ON identity_identifier_replacement_challenges(tenant_id, account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_identifier_replacement_challenge_expiry
  ON identity_identifier_replacement_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS identity_identifier_replacement_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identifier_kind TEXT NOT NULL CHECK (identifier_kind = 'email_exact'),
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
          initiating_session_ref IS NOT NULL) OR authority <> 'self_service'),
  CHECK ((state IN ('authoritative_switched', 'revocation_pending', 'completed',
                    'blocked_forward_repair') AND authoritative_switched_at IS NOT NULL) OR
         state IN ('directory_pending', 'authoritative_switch_pending', 'canceled')),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL) OR state <> 'completed'),
  CHECK (retry_budget_expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_identifier_replacement_operation_due
  ON identity_identifier_replacement_operations(state, next_attempt_at, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identifier_replacement_operation_account_active
  ON identity_identifier_replacement_operations(tenant_id, account_id, identifier_kind)
  WHERE state NOT IN ('completed', 'canceled');

CREATE TABLE IF NOT EXISTS identity_identifier_replacement_history (
  operation_id TEXT PRIMARY KEY,
  old_value_json TEXT CHECK (old_value_json IS NULL OR json_valid(old_value_json)),
  new_value_json TEXT CHECK (new_value_json IS NULL OR json_valid(new_value_json)),
  old_value_sha256 TEXT NOT NULL CHECK (length(old_value_sha256) = 64),
  new_value_sha256 TEXT NOT NULL CHECK (length(new_value_sha256) = 64),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  actor_ref TEXT NOT NULL,
  authority_evidence_json TEXT NOT NULL CHECK (json_valid(authority_evidence_json)),
  verification_evidence_json TEXT NOT NULL CHECK (json_valid(verification_evidence_json)),
  raw_values_erased_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES identity_identifier_replacement_operations(operation_id),
  CHECK (old_value_sha256 <> new_value_sha256),
  CHECK ((raw_values_erased_at IS NULL AND old_value_json IS NOT NULL AND new_value_json IS NOT NULL) OR
         (raw_values_erased_at IS NOT NULL AND old_value_json IS NULL AND new_value_json IS NULL))
);

CREATE TRIGGER IF NOT EXISTS trg_identifier_replacement_history_immutable
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

CREATE TABLE IF NOT EXISTS identity_identifier_replacement_projections (
  operation_id TEXT NOT NULL,
  identifier_side TEXT NOT NULL CHECK (identifier_side IN ('old', 'new')),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  blind_digest TEXT NOT NULL CHECK (length(blind_digest) = 64),
  projection_state TEXT NOT NULL DEFAULT 'planned'
    CHECK (projection_state IN ('planned', 'reserved', 'pending', 'active', 'disabled', 'released')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, identifier_side, hmac_key_generation),
  FOREIGN KEY (operation_id) REFERENCES identity_identifier_replacement_operations(operation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identifier_replacement_projection_digest
  ON identity_identifier_replacement_projections(
    operation_id, identifier_side, hmac_key_generation, blind_digest
  );

CREATE TABLE IF NOT EXISTS identity_identifier_replacement_outbox (
  outbox_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind = 'identifier_replacement'),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND
    json_type(payload_json, '$.operationId') = 'text' AND
    json_type(payload_json, '$.tenantId') = 'text' AND
    json_type(payload_json, '$.accountId') = 'text' AND
    json_type(payload_json, '$.projections') = 'array' AND
    json_type(payload_json, '$.oldValue') IS NULL AND
    json_type(payload_json, '$.newValue') IS NULL AND
    length(payload_json) <= 16384
  ),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES identity_identifier_replacement_operations(operation_id),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
);

CREATE INDEX IF NOT EXISTS idx_identifier_replacement_outbox_due
  ON identity_identifier_replacement_outbox(status, next_attempt_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS external_identifier_unlink_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  issuer_json TEXT CHECK (issuer_json IS NULL OR json_type(issuer_json) = 'text'),
  subject_json TEXT CHECK (subject_json IS NULL OR json_type(subject_json) = 'text'),
  issuer_sha256 TEXT NOT NULL CHECK (length(issuer_sha256) = 64),
  subject_sha256 TEXT NOT NULL CHECK (length(subject_sha256) = 64),
  route_projection_json TEXT NOT NULL CHECK (json_valid(route_projection_json)),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'directory_pending', 'completed', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  error_code TEXT,
  raw_values_erased_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((raw_values_erased_at IS NULL AND issuer_json IS NOT NULL AND subject_json IS NOT NULL) OR
         (raw_values_erased_at IS NOT NULL AND issuer_json IS NULL AND subject_json IS NULL)),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL AND raw_values_erased_at IS NOT NULL) OR
         state <> 'completed')
);

CREATE INDEX IF NOT EXISTS idx_external_identifier_unlink_due
  ON external_identifier_unlink_operations(state, next_attempt_at, lease_expires_at, created_at);

CREATE TRIGGER IF NOT EXISTS trg_external_identifier_unlink_link_required
BEFORE INSERT ON external_identifier_unlink_operations
WHEN NOT EXISTS (
  SELECT 1 FROM linked_identities link
   WHERE link.tenant_id = NEW.tenant_id AND link.user_id = NEW.user_id
     AND link.provider_id = json_extract(NEW.issuer_json, '$')
     AND link.provider_user_id = json_extract(NEW.subject_json, '$')
)
BEGIN
  SELECT RAISE(ABORT, 'external_identifier_unlink_link_required');
END;
