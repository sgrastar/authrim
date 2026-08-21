-- Authrim 0.4.0 pre-1.0 semantic fresh-install baseline.
-- Logical stream: d1-pii.
-- Generated from the final database state; do not append historical migration SQL here.
-- Pre-1.0 databases are not upgrade-compatible and must be recreated.
PRAGMA foreign_keys = OFF;

CREATE TABLE users_pii (
  -- Primary key (same as users_core.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- PII sensitivity classification
  -- IDENTITY_CORE | PROFILE | DEMOGRAPHIC | LOCATION | HIGH_RISK
  pii_class TEXT NOT NULL DEFAULT 'PROFILE',

  -- Email (IDENTITY_CORE)
  email TEXT NOT NULL,

  -- Blind index for email search (HMAC-SHA256 of normalized email)
  -- Allows searching without exposing plaintext in query logs
  email_blind_index TEXT,

  -- Phone (IDENTITY_CORE)
  phone_number TEXT,

  -- Name claims (PROFILE)
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,

  -- Profile URL (PROFILE)
  profile TEXT,
  picture TEXT,
  website TEXT,

  -- Demographic (DEMOGRAPHIC - GDPR Art.9 sensitive)
  gender TEXT,
  birthdate TEXT,

  -- Locale (PROFILE)
  locale TEXT,
  zoneinfo TEXT,

  -- Address claims (LOCATION)
  address_formatted TEXT,
  address_street_address TEXT,
  address_locality TEXT,
  address_region TEXT,
  address_postal_code TEXT,
  address_country TEXT,

  -- User-declared residence (for partition routing, HIGH TRUST)
  declared_residence TEXT,

  -- Custom attributes (JSON)
  custom_attributes_json TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE subject_identifiers (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- User reference (logical FK to users_core.id)
  user_id TEXT NOT NULL,

  -- Client ID that requested this subject
  client_id TEXT NOT NULL,

  -- Sector identifier (domain for pairwise calculation)
  sector_identifier TEXT NOT NULL,

  -- The pairwise subject value
  subject TEXT NOT NULL,

  -- Timestamp
  created_at INTEGER NOT NULL
);
CREATE TABLE audit_log_pii (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Actor who accessed PII (user/admin/system)
  user_id TEXT,

  -- Action performed
  -- pii_accessed | pii_created | pii_updated | pii_deleted | pii_exported
  action TEXT NOT NULL,

  -- Target user whose PII was accessed
  target_user_id TEXT,

  -- Action details (JSON)
  details TEXT,

  -- Request context
  ip_address TEXT,
  user_agent TEXT,

  -- Timestamps
  created_at INTEGER NOT NULL,

  -- Export tracking (NULL = not exported yet)
  exported_at INTEGER
);
CREATE TABLE users_pii_tombstone (
  -- Primary key (same as original users_core.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Email blind index (for preventing re-registration)
  email_blind_index TEXT,

  -- Deletion timestamp
  deleted_at INTEGER NOT NULL,

  -- Actor who initiated deletion
  -- user: User requested (GDPR Art.17)
  -- admin: Admin initiated
  -- system: Automated cleanup
  deleted_by TEXT,

  -- Deletion reason
  -- user_request | admin_action | inactivity | account_abuse | data_breach_response | other
  deletion_reason TEXT,

  -- Auto-purge date (typically deleted_at + 90 days)
  retention_until INTEGER NOT NULL,

  -- Additional metadata (JSON)
  -- { request_id, ip_address, consent_reference, ... }
  deletion_metadata TEXT,

  -- Timestamps for BaseRepository compatibility
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE user_anonymization_map (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  anonymized_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  UNIQUE(tenant_id, user_id)
);
CREATE TABLE pii_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  anonymized_user_id TEXT NOT NULL,
  change_type TEXT NOT NULL,
  affected_fields TEXT NOT NULL,
  values_r2_key TEXT,
  values_encrypted TEXT,
  encryption_key_id TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  actor_user_id TEXT,
  actor_type TEXT NOT NULL,
  request_id TEXT,
  legal_basis TEXT,
  consent_reference TEXT,
  retention_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "linked_identities" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_name TEXT,
  raw_attributes TEXT,
  linked_at INTEGER NOT NULL,
  last_used_at INTEGER
, email_verified INTEGER NOT NULL DEFAULT 0, access_token_encrypted TEXT, refresh_token_encrypted TEXT, token_expires_at INTEGER, raw_claims TEXT, profile_data TEXT, last_login_at INTEGER, updated_at INTEGER, provisioning_state TEXT NOT NULL DEFAULT 'active'
  CHECK (provisioning_state IN ('pending', 'active')));
CREATE TABLE identity_sensitive_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  value_key TEXT NOT NULL,
  value_json TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'sensitive',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_type, owner_id, value_key)
);
CREATE TABLE identity_identifier_replacement_challenges (
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
  updated_at INTEGER NOT NULL, operation_mode TEXT NOT NULL DEFAULT 'replacement'
    CHECK (operation_mode IN ('addition', 'replacement')),
  CHECK (recent_reauth_verified_at <= created_at AND
         created_at - recent_reauth_verified_at <= 300),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= expires_at)),
  CHECK ((raw_value_erased_at IS NULL AND json_type(normalized_value_json) = 'text') OR
         (raw_value_erased_at IS NOT NULL AND normalized_value_json = 'null'))
);
CREATE TABLE identity_identifier_replacement_history (
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
CREATE TABLE identity_identifier_replacement_projections (
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
CREATE TABLE identity_identifier_replacement_outbox (
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
CREATE TABLE external_identifier_unlink_operations (
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
CREATE TABLE tenant_placement_migration_captures (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  capture_state TEXT NOT NULL DEFAULT 'capturing'
    CHECK (capture_state IN ('capturing', 'write_fenced', 'cutover_committed', 'canceled')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  installed_at INTEGER NOT NULL,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  canceled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((capture_state = 'write_fenced' AND write_fenced_at IS NOT NULL)
    OR capture_state <> 'write_fenced'),
  CHECK ((capture_state = 'cutover_committed' AND cutover_committed_at IS NOT NULL)
    OR capture_state <> 'cutover_committed'),
  CHECK ((capture_state = 'canceled' AND canceled_at IS NOT NULL)
    OR capture_state <> 'canceled')
);
CREATE TABLE tenant_placement_migration_outbox (
  source_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (
    length(table_name) BETWEEN 1 AND 128 AND table_name NOT GLOB '*[^a-z0-9_]*'
  ),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('upsert', 'delete')),
  mutation_key_json TEXT NOT NULL CHECK (json_valid(mutation_key_json)),
  row_json TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  capture_fencing_token INTEGER NOT NULL CHECK (capture_fencing_token >= 1),
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'applied')),
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES tenant_placement_migration_captures(operation_id),
  CHECK ((mutation_kind = 'upsert' AND row_json IS NOT NULL) OR
         (mutation_kind = 'delete' AND row_json IS NULL)),
  CHECK ((delivery_state = 'applied' AND applied_at IS NOT NULL) OR
         (delivery_state = 'pending' AND applied_at IS NULL))
);
CREATE TABLE IF NOT EXISTS "authrim_control_plane_shard_metadata" (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  binding_ref TEXT NOT NULL CHECK (
    binding_ref GLOB '[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]*'
  ),
  data_role TEXT NOT NULL CHECK (data_role = 'tenant_pii'),
  residency_partition TEXT NOT NULL
    CHECK (length(residency_partition) BETWEEN 1 AND 63),
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 1 AND 128),
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  expected_file_count INTEGER NOT NULL CHECK (expected_file_count >= 1),
  last_filename TEXT NOT NULL CHECK (length(last_filename) BETWEEN 1 AND 255),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "identity_identifier_replacement_operations" (
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
CREATE TRIGGER trg_external_identifier_unlink_link_required
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
CREATE TRIGGER trg_tenant_placement_capture_one_active_insert
BEFORE INSERT ON tenant_placement_migration_captures
WHEN NEW.capture_state IN ('capturing', 'write_fenced', 'cutover_committed') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND capture_state IN ('capturing', 'write_fenced', 'cutover_committed')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_active_conflict');
END;
CREATE TRIGGER trg_tenant_placement_capture_one_active_update
BEFORE UPDATE OF tenant_id, capture_state ON tenant_placement_migration_captures
WHEN NEW.capture_state IN ('capturing', 'write_fenced', 'cutover_committed') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND operation_id <> OLD.operation_id
     AND capture_state IN ('capturing', 'write_fenced', 'cutover_committed')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_active_conflict');
END;
CREATE TRIGGER trg_tenant_placement_capture_identity_immutable
BEFORE UPDATE OF operation_id, tenant_id, source_shard_id, migration_generation
ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_identity_immutable');
END;
CREATE TRIGGER trg_tenant_placement_capture_transition
BEFORE UPDATE OF capture_state ON tenant_placement_migration_captures
WHEN NOT (
  (OLD.capture_state = 'capturing' AND NEW.capture_state IN ('write_fenced', 'canceled')) OR
  (OLD.capture_state = 'write_fenced' AND NEW.capture_state IN ('capturing', 'cutover_committed', 'canceled')) OR
  OLD.capture_state = NEW.capture_state
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_transition_invalid');
END;
CREATE TRIGGER trg_tenant_placement_capture_no_delete
BEFORE DELETE ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_delete_forbidden');
END;
CREATE TRIGGER trg_tenant_placement_outbox_payload_immutable
BEFORE UPDATE OF source_sequence, operation_id, tenant_id, table_name, mutation_kind,
                 mutation_key_json, row_json, capture_fencing_token, created_at
ON tenant_placement_migration_outbox
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_outbox_payload_immutable');
END;
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
CREATE UNIQUE INDEX idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index);
CREATE INDEX idx_users_pii_tenant
  ON users_pii(tenant_id);
CREATE INDEX idx_users_pii_class
  ON users_pii(pii_class);
CREATE UNIQUE INDEX idx_subject_ids_unique
  ON subject_identifiers(user_id, sector_identifier);
CREATE INDEX idx_subject_ids_subject
  ON subject_identifiers(subject);
CREATE INDEX idx_subject_ids_client
  ON subject_identifiers(client_id);
CREATE INDEX idx_audit_pii_user
  ON audit_log_pii(user_id);
CREATE INDEX idx_audit_pii_target
  ON audit_log_pii(target_user_id);
CREATE INDEX idx_audit_pii_action
  ON audit_log_pii(action);
CREATE INDEX idx_audit_pii_exported
  ON audit_log_pii(exported_at);
CREATE INDEX idx_audit_pii_created
  ON audit_log_pii(created_at DESC);
CREATE INDEX idx_tombstone_tenant
  ON users_pii_tombstone(tenant_id);
CREATE INDEX idx_tombstone_email
  ON users_pii_tombstone(email_blind_index);
CREATE INDEX idx_tombstone_retention
  ON users_pii_tombstone(retention_until);
CREATE INDEX idx_anon_map_tenant_user
  ON user_anonymization_map(tenant_id, user_id);
CREATE INDEX idx_anon_map_anon_id
  ON user_anonymization_map(anonymized_user_id);
CREATE INDEX idx_pii_log_tenant_user
  ON pii_log(tenant_id, user_id);
CREATE INDEX idx_pii_log_anon_user
  ON pii_log(anonymized_user_id);
CREATE INDEX idx_pii_log_request_id
  ON pii_log(request_id);
CREATE INDEX idx_pii_log_change_type
  ON pii_log(change_type);
CREATE INDEX idx_pii_log_retention
  ON pii_log(retention_until);
CREATE INDEX idx_pii_log_actor
  ON pii_log(actor_user_id);
CREATE UNIQUE INDEX idx_linked_ids_provider
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX idx_linked_ids_user ON linked_identities(user_id);
CREATE INDEX idx_linked_ids_tenant_user
  ON linked_identities(tenant_id, user_id);
CREATE INDEX idx_linked_ids_provider_sub
  ON linked_identities(provider_id, provider_user_id);
CREATE INDEX idx_linked_ids_email ON linked_identities(provider_email);
CREATE INDEX idx_identity_sensitive_values_owner
  ON identity_sensitive_values(tenant_id, owner_type, owner_id, value_key, lifecycle_state);
CREATE INDEX idx_identifier_replacement_challenge_account
  ON identity_identifier_replacement_challenges(tenant_id, account_id, created_at DESC);
CREATE INDEX idx_identifier_replacement_challenge_expiry
  ON identity_identifier_replacement_challenges(expires_at, consumed_at);
CREATE UNIQUE INDEX idx_identifier_replacement_projection_digest
  ON identity_identifier_replacement_projections(
    operation_id, identifier_side, hmac_key_generation, blind_digest
  );
CREATE INDEX idx_identifier_replacement_outbox_due
  ON identity_identifier_replacement_outbox(status, next_attempt_at, lease_expires_at);
CREATE INDEX idx_external_identifier_unlink_due
  ON external_identifier_unlink_operations(state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX idx_linked_identities_provisioning
  ON linked_identities(tenant_id, provider_id, provider_user_id, provisioning_state);
CREATE INDEX idx_tenant_placement_capture_tenant_state
  ON tenant_placement_migration_captures(tenant_id, capture_state);
CREATE INDEX idx_tenant_placement_outbox_pending
  ON tenant_placement_migration_outbox(operation_id, delivery_state, source_sequence);
CREATE INDEX idx_identifier_replacement_operation_due
  ON identity_identifier_replacement_operations(state, next_attempt_at, lease_expires_at);
CREATE UNIQUE INDEX idx_identifier_replacement_operation_account_active
  ON identity_identifier_replacement_operations(tenant_id, account_id, identifier_kind)
  WHERE state NOT IN ('completed', 'canceled');

PRAGMA foreign_keys = ON;
