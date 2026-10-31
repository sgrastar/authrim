-- Authrim 0.5.0 semantic fresh-install baseline.
-- Logical stream: pii-d1.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
PRAGMA foreign_keys = OFF;

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
CREATE TABLE account_webhook_delivery_fields (
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  destination_url TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, event_id, webhook_id)
);
CREATE TABLE service_group_inputs (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
);
CREATE TABLE account_webhook_snapshots (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  email_before_json TEXT,
  email_after_json TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE audit_log_pii (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

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
CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
CREATE TABLE external_identifier_unlink_operations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE guest_upgrade_operations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  initiating_session_id TEXT NOT NULL,
  request_token_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('email', 'passkey')),
  state TEXT NOT NULL DEFAULT 'awaiting_proof'
    CHECK (state IN ('awaiting_proof', 'verified', 'committing', 'completed', 'canceled')),
  proof_payload_json TEXT,
  challenge_verifier TEXT,
  reservation_publication_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (attempt_count >= 0 AND attempt_count <= 5),
  CHECK (expires_at > created_at)
);
CREATE TABLE identity_identifier_replacement_challenges (
  challenge_id TEXT PRIMARY KEY
 NOT NULL
,
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
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE IF NOT EXISTS "identity_identifier_replacement_operations" (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE identity_identifier_replacement_outbox (
  outbox_id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE identity_sensitive_values (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE IF NOT EXISTS "linked_identities" (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global'
 NOT NULL
,
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS "pairwise_subject_identifiers" (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

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
, tenant_id TEXT NOT NULL DEFAULT 'default');
CREATE TABLE pii_log (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY
 NOT NULL
, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE subject_identifiers (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  verification_method TEXT,
  destination_type TEXT NOT NULL DEFAULT 'global',
  destination_id TEXT NOT NULL DEFAULT 'default',
  identifier_value_hash TEXT,
  identifier_storage_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE tenant_placement_migration_captures (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE user_anonymization_map (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  anonymized_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  UNIQUE(tenant_id, user_id)
);
CREATE TABLE users_pii (
  -- Primary key (same as users_core.id)
  id TEXT PRIMARY KEY
 NOT NULL
,

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
CREATE TABLE users_pii_tombstone (
  -- Primary key (same as original users_core.id)
  id TEXT PRIMARY KEY
 NOT NULL
,

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
CREATE TABLE tenant_backup_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('capturing', 'sealed', 'invalid')),
  tenant_key TEXT CHECK (tenant_key IS NULL OR length(tenant_key) > 0)
);
CREATE TABLE tenant_backup_preimages (
  snapshot_id TEXT NOT NULL REFERENCES tenant_backup_snapshots(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  record_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  row_json TEXT, row_partition TEXT
  CHECK (
    row_partition IS NULL OR (
      typeof(row_partition) = 'text'
      AND length(row_partition) BETWEEN 1 AND 64
    )
  ),
  PRIMARY KEY (snapshot_id, source_table, record_key),
  CHECK ((present = 0 AND row_json IS NULL) OR (present = 1 AND row_json IS NOT NULL))
);
CREATE TABLE tenant_backup_restore_targets (
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
CREATE TABLE pii_log_purge_operations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  old_anonymized_user_id TEXT NOT NULL,
  new_anonymized_user_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, user_id)
);
CREATE TABLE guest_pii_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO guest_pii_mutation_epoch VALUES(1,0);
CREATE TABLE guest_pii_erasure_markers (
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 256),
  user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 256),
  account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 512),
  account_route_generation INTEGER NOT NULL CHECK(account_route_generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('erasing','deleted')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  operation_id TEXT,
  boundary_id TEXT,
  source_started_at_ms INTEGER,
  permit_table TEXT,
  permit_keys_json TEXT,
  PRIMARY KEY(tenant_id,user_id),
  UNIQUE(tenant_id,account_id),
  CHECK((state='deleted' AND operation_id IS NULL AND boundary_id IS NULL AND source_started_at_ms IS NULL
      AND permit_table IS NULL AND permit_keys_json IS NULL)
    OR (state='erasing' AND operation_id IS NOT NULL AND boundary_id IS NOT NULL AND source_started_at_ms IS NOT NULL
      AND length(operation_id) BETWEEN 1 AND 256 AND length(boundary_id)=78
      AND source_started_at_ms BETWEEN 1 AND 9007199254740991
      AND ((permit_table IS NULL AND permit_keys_json IS NULL)
        OR (permit_table IS NOT NULL AND permit_keys_json IS NOT NULL AND permit_table IN ('users_pii','identity_sensitive_values','linked_identities','subject_identifiers','pairwise_subject_identifiers','guest_upgrade_operations','identity_identifier_replacement_challenges','identity_identifier_replacement_operations','identity_identifier_replacement_history','identity_identifier_replacement_outbox','external_identifier_unlink_operations','user_anonymization_map') AND length(permit_keys_json)<=8192 AND json_valid(permit_keys_json) AND json_type(permit_keys_json)='array' AND json_array_length(permit_keys_json) BETWEEN 1 AND 16))))
);
CREATE TRIGGER sg_identity_sensitive_values_delete AFTER DELETE ON identity_sensitive_values BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.owner_id, 1 WHERE (OLD.owner_type = 'runtime_user') AND OLD.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_identity_sensitive_values_insert AFTER INSERT ON identity_sensitive_values BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = 'runtime_user') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_identity_sensitive_values_update AFTER UPDATE ON identity_sensitive_values BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = 'runtime_user') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
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
CREATE TRIGGER trg_tenant_placement_capture_identity_immutable
BEFORE UPDATE OF operation_id, tenant_id, source_shard_id, migration_generation
ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_identity_immutable');
END;
CREATE TRIGGER trg_tenant_placement_capture_no_delete
BEFORE DELETE ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_delete_forbidden');
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
CREATE TRIGGER trg_tenant_placement_outbox_payload_immutable
BEFORE UPDATE OF source_sequence, operation_id, tenant_id, table_name, mutation_kind,
                 mutation_key_json, row_json, capture_fencing_token, created_at
ON tenant_placement_migration_outbox
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_outbox_payload_immutable');
END;
CREATE TRIGGER tenant_backup_snapshot_identity_immutable
BEFORE UPDATE OF id, tenant_id, tenant_key ON tenant_backup_snapshots
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.tenant_key IS NOT OLD.tenant_key
BEGIN SELECT RAISE(ABORT, 'snapshot_identity_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_state_monotonic
BEFORE UPDATE OF state ON tenant_backup_snapshots
WHEN (OLD.state='invalid' AND NEW.state!='invalid') OR (OLD.state='sealed' AND NEW.state='capturing')
BEGIN SELECT RAISE(ABORT,'snapshot_state_regression'); END;
CREATE TRIGGER tenant_backup_restore_target_identity
BEFORE UPDATE OF id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint ON tenant_backup_restore_targets
BEGIN SELECT RAISE(ABORT,'backup_restore_target_identity'); END;
CREATE TRIGGER tenant_backup_restore_target_monotonic
BEFORE UPDATE ON tenant_backup_restore_targets
WHEN NEW.fencing_token<OLD.fencing_token
  OR (NEW.fencing_token=OLD.fencing_token AND NEW.owner!=OLD.owner)
  OR (OLD.state='invalid' AND NEW.state!='invalid')
  OR (OLD.state='sealed' AND NEW.state='loading')
BEGIN SELECT RAISE(ABORT,'backup_restore_target_regression'); END;
CREATE TRIGGER trg_guest_pii_epoch_no_delete BEFORE DELETE ON guest_pii_mutation_epoch BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_immutable'); END;
CREATE TRIGGER trg_guest_pii_epoch_no_replace BEFORE INSERT ON guest_pii_mutation_epoch WHEN EXISTS(SELECT 1 FROM guest_pii_mutation_epoch) BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_immutable'); END;
CREATE TRIGGER trg_guest_pii_epoch_monotonic BEFORE UPDATE ON guest_pii_mutation_epoch BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_immutable') WHERE (NEW.id IS NOT OLD.id OR NEW.revision IS NOT OLD.revision+1); END;
CREATE TRIGGER trg_guest_pii_marker_no_delete BEFORE DELETE ON guest_pii_erasure_markers BEGIN
 SELECT RAISE(ABORT,'guest_pii_marker_immutable'); END;
CREATE TRIGGER trg_guest_pii_marker_insert BEFORE INSERT ON guest_pii_erasure_markers BEGIN
 SELECT RAISE(ABORT,'guest_pii_marker_initial_invalid') WHERE (NEW.permit_table IS NOT NULL OR NEW.permit_keys_json IS NOT NULL OR (NEW.state='erasing' AND NEW.revision<>1));
 SELECT RAISE(ABORT,'guest_pii_marker_identity_conflict') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers WHERE tenant_id=NEW.tenant_id AND (user_id=NEW.user_id OR account_id=NEW.account_id)));
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 UPDATE guest_pii_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_pii_marker_update BEFORE UPDATE ON guest_pii_erasure_markers BEGIN
 SELECT RAISE(ABORT,'guest_pii_marker_immutable') WHERE (NEW.schema_version IS NOT OLD.schema_version OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.user_id IS NOT OLD.user_id OR NEW.account_id IS NOT OLD.account_id OR NEW.account_route_generation IS NOT OLD.account_route_generation OR NOT (OLD.state='erasing' AND (
  (NEW.state='deleted' AND OLD.permit_table IS NULL AND OLD.permit_keys_json IS NULL AND NEW.revision=OLD.revision+1)
  OR (NEW.state='erasing' AND NEW.operation_id IS OLD.operation_id AND NEW.boundary_id IS OLD.boundary_id
    AND NEW.source_started_at_ms IS OLD.source_started_at_ms AND (
      (OLD.permit_table IS NULL AND OLD.permit_keys_json IS NULL AND NEW.permit_table IS NOT NULL AND NEW.permit_keys_json IS NOT NULL AND NEW.revision=OLD.revision)
      OR (OLD.permit_table IS NOT NULL AND OLD.permit_keys_json IS NOT NULL AND NEW.permit_table IS NULL AND NEW.permit_keys_json IS NULL AND NEW.revision=OLD.revision+1)
    )))
));
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 UPDATE guest_pii_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_pii_users_pii_insert BEFORE INSERT ON "users_pii" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.id) OR EXISTS(SELECT 1 FROM "users_pii" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."email_blind_index"=NEW."email_blind_index") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.id)));
END;
CREATE TRIGGER trg_guest_pii_users_pii_delete BEFORE DELETE ON "users_pii" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.id AND NOT (m.state='erasing' AND m.permit_table='users_pii' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_users_pii_update BEFORE UPDATE ON "users_pii" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."id" IS OLD."id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.id)) AND NOT (m.state='erasing' AND m.permit_table='users_pii' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_sensitive_values_insert BEFORE INSERT ON "identity_sensitive_values" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.owner_id AND NEW.owner_type='runtime_user') OR EXISTS(SELECT 1 FROM "identity_sensitive_values" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."owner_type"=NEW."owner_type" AND existing."owner_id"=NEW."owner_id" AND existing."value_key"=NEW."value_key") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.owner_id AND existing.owner_type='runtime_user')));
END;
CREATE TRIGGER trg_guest_pii_identity_sensitive_values_delete BEFORE DELETE ON "identity_sensitive_values" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.owner_id AND OLD.owner_type='runtime_user' AND NOT (m.state='erasing' AND m.permit_table='identity_sensitive_values' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_sensitive_values_update BEFORE UPDATE ON "identity_sensitive_values" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.owner_id AND OLD.owner_type='runtime_user') OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.owner_id AND NEW.owner_type='runtime_user')) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."owner_id" IS OLD."owner_id" AND NEW.owner_type IS OLD.owner_type)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.owner_id AND OLD.owner_type='runtime_user') OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.owner_id AND NEW.owner_type='runtime_user')) AND NOT (m.state='erasing' AND m.permit_table='identity_sensitive_values' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_linked_identities_insert BEFORE INSERT ON "linked_identities" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id) OR EXISTS(SELECT 1 FROM "linked_identities" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."provider_id"=NEW."provider_id" AND existing."provider_user_id"=NEW."provider_user_id") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.user_id)));
END;
CREATE TRIGGER trg_guest_pii_linked_identities_delete BEFORE DELETE ON "linked_identities" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id AND NOT (m.state='erasing' AND m.permit_table='linked_identities' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_linked_identities_update BEFORE UPDATE ON "linked_identities" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (m.state='erasing' AND m.permit_table='linked_identities' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_subject_identifiers_insert BEFORE INSERT ON "subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.subject_id) OR EXISTS(SELECT 1 FROM "subject_identifiers" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."identifier_type"=NEW."identifier_type" AND existing."identifier_value"=NEW."identifier_value") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.subject_id)));
END;
CREATE TRIGGER trg_guest_pii_subject_identifiers_delete BEFORE DELETE ON "subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.subject_id AND NOT (m.state='erasing' AND m.permit_table='subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_subject_identifiers_update BEFORE UPDATE ON "subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.subject_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.subject_id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."subject_id" IS OLD."subject_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.subject_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.subject_id)) AND NOT (m.state='erasing' AND m.permit_table='subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers_insert BEFORE INSERT ON "pairwise_subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id) OR EXISTS(SELECT 1 FROM "pairwise_subject_identifiers" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."user_id"=NEW."user_id" AND existing."sector_identifier"=NEW."sector_identifier") OR (existing."id"=NEW."id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.user_id)));
END;
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers_delete BEFORE DELETE ON "pairwise_subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id AND NOT (m.state='erasing' AND m.permit_table='pairwise_subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_pairwise_subject_identifiers_update BEFORE UPDATE ON "pairwise_subject_identifiers" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (NEW."id" IS OLD."id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (m.state='erasing' AND m.permit_table='pairwise_subject_identifiers' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."id"))));
END;
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations_insert BEFORE INSERT ON "guest_upgrade_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id) OR EXISTS(SELECT 1 FROM "guest_upgrade_operations" existing WHERE ((existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.user_id)));
END;
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations_delete BEFORE DELETE ON "guest_upgrade_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id AND NOT (m.state='erasing' AND m.permit_table='guest_upgrade_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_guest_upgrade_operations_update BEFORE UPDATE ON "guest_upgrade_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (NEW."operation_id" IS OLD."operation_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.user_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.user_id)) AND NOT (m.state='erasing' AND m.permit_table='guest_upgrade_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_challenges_insert BEFORE INSERT ON "identity_identifier_replacement_challenges" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_challenges" existing WHERE ((existing."challenge_id"=NEW."challenge_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.account_id)));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_challenges_delete BEFORE DELETE ON "identity_identifier_replacement_challenges" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_challenges' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."challenge_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_challenges_update BEFORE UPDATE ON "identity_identifier_replacement_challenges" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (NEW."challenge_id" IS OLD."challenge_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."account_id" IS OLD."account_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_challenges' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."challenge_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_operations_insert BEFORE INSERT ON "identity_identifier_replacement_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_operations" existing WHERE ((existing."tenant_id"=NEW."tenant_id" AND existing."account_id"=NEW."account_id" AND existing."identifier_kind"=NEW."identifier_kind" AND existing.state NOT IN ('completed','canceled') AND NEW.state NOT IN ('completed','canceled')) OR (existing."tenant_id"=NEW."tenant_id" AND existing."authority"=NEW."authority" AND existing."idempotency_key_sha256"=NEW."idempotency_key_sha256") OR (existing."outbox_id"=NEW."outbox_id") OR (existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.account_id)));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_operations_delete BEFORE DELETE ON "identity_identifier_replacement_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_operations_update BEFORE UPDATE ON "identity_identifier_replacement_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (NEW."operation_id" IS OLD."operation_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."account_id" IS OLD."account_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_history_insert BEFORE INSERT ON "identity_identifier_replacement_history" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=NEW.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id)) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_history" existing WHERE ((existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=existing.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_history_delete BEFORE DELETE ON "identity_identifier_replacement_history" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=OLD.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_history' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_history_update BEFORE UPDATE ON "identity_identifier_replacement_history" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=OLD.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=NEW.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id))) AND NOT (NEW."operation_id" IS OLD."operation_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=OLD.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id)) OR (EXISTS (SELECT 1 FROM identity_identifier_replacement_operations owner WHERE owner.operation_id=NEW.operation_id AND m.tenant_id=owner.tenant_id AND m.user_id=owner.account_id))) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_history' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_outbox_insert BEFORE INSERT ON "identity_identifier_replacement_outbox" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id) OR EXISTS(SELECT 1 FROM "identity_identifier_replacement_outbox" existing WHERE ((existing."operation_id"=NEW."operation_id") OR (existing."outbox_id"=NEW."outbox_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND m.user_id=existing.account_id)));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_outbox_delete BEFORE DELETE ON "identity_identifier_replacement_outbox" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_outbox' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."outbox_id"))));
END;
CREATE TRIGGER trg_guest_pii_identity_identifier_replacement_outbox_update BEFORE UPDATE ON "identity_identifier_replacement_outbox" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (NEW."outbox_id" IS OLD."outbox_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."account_id" IS OLD."account_id")) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND m.user_id=OLD.account_id) OR (m.tenant_id=NEW.tenant_id AND m.user_id=NEW.account_id)) AND NOT (m.state='erasing' AND m.permit_table='identity_identifier_replacement_outbox' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."outbox_id"))));
END;
CREATE TRIGGER trg_guest_pii_external_identifier_unlink_operations_insert BEFORE INSERT ON "external_identifier_unlink_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND (m.user_id=NEW.user_id OR m.account_id=NEW.account_id)) OR EXISTS(SELECT 1 FROM "external_identifier_unlink_operations" existing WHERE ((existing."operation_id"=NEW."operation_id")) AND EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=existing.tenant_id AND (m.user_id=existing.user_id OR m.account_id=existing.account_id))));
END;
CREATE TRIGGER trg_guest_pii_external_identifier_unlink_operations_delete BEFORE DELETE ON "external_identifier_unlink_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND (m.user_id=OLD.user_id OR m.account_id=OLD.account_id) AND NOT (m.state='erasing' AND m.permit_table='external_identifier_unlink_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE TRIGGER trg_guest_pii_external_identifier_unlink_operations_update BEFORE UPDATE ON "external_identifier_unlink_operations" BEGIN
 SELECT RAISE(ABORT,'guest_pii_admission_unavailable') WHERE (NOT EXISTS(SELECT 1 FROM guest_pii_mutation_epoch WHERE id=1));
 SELECT RAISE(ABORT,'guest_pii_erasure_mutation_blocked') WHERE (((EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=OLD.tenant_id AND (m.user_id=OLD.user_id OR m.account_id=OLD.account_id)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE m.tenant_id=NEW.tenant_id AND (m.user_id=NEW.user_id OR m.account_id=NEW.account_id))) AND NOT (NEW."operation_id" IS OLD."operation_id" AND NEW.tenant_id IS OLD.tenant_id AND NEW."user_id" IS OLD."user_id" AND NEW.account_id IS OLD.account_id)) OR EXISTS(SELECT 1 FROM guest_pii_erasure_markers m WHERE ((m.tenant_id=OLD.tenant_id AND (m.user_id=OLD.user_id OR m.account_id=OLD.account_id)) OR (m.tenant_id=NEW.tenant_id AND (m.user_id=NEW.user_id OR m.account_id=NEW.account_id))) AND NOT (m.state='erasing' AND m.permit_table='external_identifier_unlink_operations' AND EXISTS(SELECT 1 FROM json_each(m.permit_keys_json) key WHERE key.type='text' AND key.value=OLD."operation_id"))));
END;
CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until);
CREATE INDEX idx_account_webhook_snapshot_expiry ON account_webhook_snapshots (tenant_id, expires_at);
CREATE INDEX idx_anon_map_anon_id
  ON user_anonymization_map(anonymized_user_id);
CREATE INDEX idx_anon_map_tenant_user
  ON user_anonymization_map(tenant_id, user_id);
CREATE INDEX idx_audit_pii_action
  ON audit_log_pii(action);
CREATE INDEX idx_audit_pii_created
  ON audit_log_pii(created_at DESC);
CREATE INDEX idx_audit_pii_exported
  ON audit_log_pii(exported_at);
CREATE INDEX idx_audit_pii_target
  ON audit_log_pii(target_user_id);
CREATE INDEX idx_audit_pii_user
  ON audit_log_pii(user_id);
CREATE INDEX idx_external_identifier_unlink_due
  ON external_identifier_unlink_operations(state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX idx_guest_upgrade_operations_account
  ON guest_upgrade_operations (tenant_id, user_id, created_at);
CREATE INDEX idx_guest_upgrade_operations_recovery
  ON guest_upgrade_operations (tenant_id, state, lease_expires_at, updated_at);
CREATE INDEX idx_identifier_replacement_challenge_account
  ON identity_identifier_replacement_challenges(tenant_id, account_id, created_at DESC);
CREATE INDEX idx_identifier_replacement_challenge_expiry
  ON identity_identifier_replacement_challenges(expires_at, consumed_at);
CREATE UNIQUE INDEX idx_identifier_replacement_operation_account_active
  ON identity_identifier_replacement_operations(tenant_id, account_id, identifier_kind)
  WHERE state NOT IN ('completed', 'canceled');
CREATE INDEX idx_identifier_replacement_operation_due
  ON identity_identifier_replacement_operations(state, next_attempt_at, lease_expires_at);
CREATE INDEX idx_identifier_replacement_outbox_due
  ON identity_identifier_replacement_outbox(status, next_attempt_at, lease_expires_at);
CREATE UNIQUE INDEX idx_identifier_replacement_projection_digest
  ON identity_identifier_replacement_projections(
    operation_id, identifier_side, hmac_key_generation, blind_digest
  );
CREATE INDEX idx_identity_sensitive_values_owner
  ON identity_sensitive_values(tenant_id, owner_type, owner_id, value_key, lifecycle_state);
CREATE INDEX idx_linked_identities_provisioning
  ON linked_identities(tenant_id, provider_id, provider_user_id, provisioning_state);
CREATE INDEX idx_linked_ids_email ON linked_identities(provider_email);
CREATE UNIQUE INDEX idx_linked_ids_provider
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX idx_linked_ids_provider_sub
  ON linked_identities(provider_id, provider_user_id);
CREATE INDEX idx_linked_ids_tenant_user
  ON linked_identities(tenant_id, user_id);
CREATE INDEX idx_linked_ids_user ON linked_identities(user_id);
CREATE INDEX idx_pairwise_subject_identifiers_client
  ON pairwise_subject_identifiers(tenant_id, client_id);
CREATE INDEX idx_pairwise_subject_identifiers_subject
  ON pairwise_subject_identifiers(tenant_id, subject);
CREATE UNIQUE INDEX idx_pairwise_subject_identifiers_unique
  ON pairwise_subject_identifiers(tenant_id, user_id, sector_identifier);
CREATE INDEX idx_pii_log_actor
  ON pii_log(actor_user_id);
CREATE INDEX idx_pii_log_anon_user
  ON pii_log(anonymized_user_id);
CREATE INDEX idx_pii_log_change_type
  ON pii_log(change_type);
CREATE INDEX idx_pii_log_request_id
  ON pii_log(request_id);
CREATE INDEX idx_pii_log_retention
  ON pii_log(retention_until);
CREATE INDEX idx_pii_log_tenant_user
  ON pii_log(tenant_id, user_id);
CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id);
CREATE INDEX idx_subject_identifiers_destination
  ON subject_identifiers(tenant_id, subject_id, destination_type, lifecycle_state);
CREATE INDEX idx_subject_identifiers_hash
  ON subject_identifiers(tenant_id, identifier_type, identifier_value_hash, lifecycle_state);
CREATE INDEX idx_subject_identifiers_primary
  ON subject_identifiers(tenant_id, subject_id, is_primary);
CREATE INDEX idx_subject_identifiers_tenant_subject
  ON subject_identifiers(tenant_id, subject_id);
CREATE UNIQUE INDEX idx_subject_identifiers_unique
  ON subject_identifiers(tenant_id, identifier_type, identifier_value);
CREATE INDEX idx_tenant_placement_capture_tenant_state
  ON tenant_placement_migration_captures(tenant_id, capture_state);
CREATE INDEX idx_tenant_placement_outbox_pending
  ON tenant_placement_migration_outbox(operation_id, delivery_state, source_sequence);
CREATE INDEX idx_tombstone_email
  ON users_pii_tombstone(email_blind_index);
CREATE INDEX idx_tombstone_retention
  ON users_pii_tombstone(retention_until);
CREATE INDEX idx_users_pii_class
  ON users_pii(pii_class);
CREATE UNIQUE INDEX idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index);
CREATE INDEX tenant_backup_snapshots_capture
  ON tenant_backup_snapshots(state, tenant_id, id);
CREATE UNIQUE INDEX tenant_backup_restore_target_exclusive ON tenant_backup_restore_targets((1));
CREATE INDEX tenant_backup_preimages_native_order
  ON tenant_backup_preimages(snapshot_id, source_table, present,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[0][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[0][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[0][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[0][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[0][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[1][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[1][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[1][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[1][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[1][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[2][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[2][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[2][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[2][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[2][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[3][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[3][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[3][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[3][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[3][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[4][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[4][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[4][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[4][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[4][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[5][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[5][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[5][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[5][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[5][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[6][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[6][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[6][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[6][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[6][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[7][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[7][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[7][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[7][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[7][1]')) END);
CREATE INDEX idx_users_pii_tenant ON users_pii(tenant_id, id);
CREATE INDEX idx_tombstone_tenant ON users_pii_tombstone(tenant_id, id);
CREATE INDEX idx_pii_log_purge_operations_tenant_created
  ON pii_log_purge_operations (tenant_id, created_at, id);
CREATE INDEX idx_guest_pii_sensitive_drain ON identity_sensitive_values(tenant_id,owner_type,owner_id,id);
CREATE INDEX idx_guest_pii_linked_drain ON linked_identities(tenant_id,user_id,id);
CREATE INDEX idx_guest_pii_subject_drain ON subject_identifiers(tenant_id,subject_id,id);
CREATE INDEX idx_guest_pii_pairwise_drain ON pairwise_subject_identifiers(tenant_id,user_id,id);
CREATE INDEX idx_guest_pii_upgrade_drain ON guest_upgrade_operations(tenant_id,user_id,operation_id);
CREATE INDEX idx_guest_pii_replacement_challenge_drain ON identity_identifier_replacement_challenges(tenant_id,account_id,challenge_id);
CREATE INDEX idx_guest_pii_replacement_operation_drain ON identity_identifier_replacement_operations(tenant_id,account_id,operation_id);
CREATE INDEX idx_guest_pii_replacement_outbox_drain ON identity_identifier_replacement_outbox(tenant_id,account_id,outbox_id);
CREATE INDEX idx_guest_pii_unlink_drain ON external_identifier_unlink_operations(tenant_id,user_id,account_id,operation_id);

PRAGMA foreign_keys = ON;
