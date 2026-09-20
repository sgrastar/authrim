CREATE TABLE IF NOT EXISTS authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
);

CREATE TABLE IF NOT EXISTS authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

CREATE TABLE IF NOT EXISTS migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT 'global',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    );

-- Apply this entire migration and its history record as one atomic D1 batch.

-- NULL identities are not repaired, removed or assigned automatically.

CREATE TABLE "__authrim_pk_guard" (target TEXT NOT NULL, violations INTEGER NOT NULL CONSTRAINT primary_key_integrity_preflight CHECK (violations = 0));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_webhook_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_webhook_outbox' AND sql IN ('CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN (''guest'', ''registered'')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:account_webhook_outbox', (SELECT count(*) FROM "account_webhook_outbox" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:account_webhook_snapshots', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_webhook_snapshots' AND sql IN ('CREATE TABLE account_webhook_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN (''guest'', ''registered'')),
  email_before_json TEXT,
  email_after_json TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:account_webhook_snapshots', (SELECT count(*) FROM "account_webhook_snapshots" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:audit_log_pii', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='audit_log_pii' AND sql IN ('CREATE TABLE audit_log_pii (
  -- Primary key
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:audit_log_pii', (SELECT count(*) FROM "audit_log_pii" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_migrations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_migrations' AND sql IN ('CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)','CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_migrations', (SELECT count(*) FROM "authrim_migrations" WHERE "filename" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:authrim_runtime_probes', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='authrim_runtime_probes' AND sql IN ('CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )','CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:authrim_runtime_probes', (SELECT count(*) FROM "authrim_runtime_probes" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:external_identifier_unlink_operations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='external_identifier_unlink_operations' AND sql IN ('CREATE TABLE external_identifier_unlink_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  issuer_json TEXT CHECK (issuer_json IS NULL OR json_type(issuer_json) = ''text''),
  subject_json TEXT CHECK (subject_json IS NULL OR json_type(subject_json) = ''text''),
  issuer_sha256 TEXT NOT NULL CHECK (length(issuer_sha256) = 64),
  subject_sha256 TEXT NOT NULL CHECK (length(subject_sha256) = 64),
  route_projection_json TEXT NOT NULL CHECK (json_valid(route_projection_json)),
  state TEXT NOT NULL DEFAULT ''pending''
    CHECK (state IN (''pending'', ''directory_pending'', ''completed'', ''blocked'')),
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
  CHECK ((state = ''completed'' AND completed_at IS NOT NULL AND raw_values_erased_at IS NOT NULL) OR
         state <> ''completed'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:external_identifier_unlink_operations', (SELECT count(*) FROM "external_identifier_unlink_operations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:guest_upgrade_operations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='guest_upgrade_operations' AND sql IN ('CREATE TABLE guest_upgrade_operations (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  initiating_session_id TEXT NOT NULL,
  request_token_hash TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN (''email'', ''passkey'')),
  state TEXT NOT NULL DEFAULT ''awaiting_proof''
    CHECK (state IN (''awaiting_proof'', ''verified'', ''committing'', ''completed'', ''canceled'')),
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:guest_upgrade_operations', (SELECT count(*) FROM "guest_upgrade_operations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_identifier_replacement_challenges', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_identifier_replacement_challenges' AND sql IN ('CREATE TABLE identity_identifier_replacement_challenges (
  challenge_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identifier_kind TEXT NOT NULL CHECK (identifier_kind = ''email_exact''),
  normalized_value_json TEXT NOT NULL CHECK (json_valid(normalized_value_json)),
  raw_value_erased_at INTEGER,
  value_sha256 TEXT NOT NULL CHECK (length(value_sha256) = 64),
  otp_verifier TEXT NOT NULL CHECK (length(otp_verifier) = 64),
  delivery_state TEXT NOT NULL DEFAULT ''pending''
    CHECK (delivery_state IN (''pending'', ''sent'', ''failed'', ''unavailable'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 20),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  initiating_session_ref TEXT NOT NULL,
  recent_reauth_verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, operation_mode TEXT NOT NULL DEFAULT ''replacement''
    CHECK (operation_mode IN (''addition'', ''replacement'')),
  CHECK (recent_reauth_verified_at <= created_at AND
         created_at - recent_reauth_verified_at <= 300),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at <= expires_at)),
  CHECK ((raw_value_erased_at IS NULL AND json_type(normalized_value_json) = ''text'') OR
         (raw_value_erased_at IS NOT NULL AND normalized_value_json = ''null''))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_identifier_replacement_challenges', (SELECT count(*) FROM "identity_identifier_replacement_challenges" WHERE "challenge_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_identifier_replacement_history', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_identifier_replacement_history' AND sql IN ('CREATE TABLE identity_identifier_replacement_history (
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_identifier_replacement_history', (SELECT count(*) FROM "identity_identifier_replacement_history" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_identifier_replacement_operations', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_identifier_replacement_operations' AND sql IN ('CREATE TABLE "identity_identifier_replacement_operations" (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  identifier_kind TEXT NOT NULL
    CHECK (identifier_kind IN (''email_exact'', ''external_subject'')),
  authority TEXT NOT NULL CHECK (authority IN (''self_service'', ''admin'', ''scim'', ''external_idp'')),
  idempotency_key_sha256 TEXT NOT NULL CHECK (length(idempotency_key_sha256) = 64),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (length(request_fingerprint_sha256) = 64),
  challenge_id TEXT,
  initiating_session_ref TEXT,
  state TEXT NOT NULL DEFAULT ''directory_pending''
    CHECK (state IN (
      ''directory_pending'',
      ''authoritative_switch_pending'',
      ''authoritative_switched'',
      ''revocation_pending'',
      ''completed'',
      ''blocked_forward_repair'',
      ''canceled''
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
  CHECK ((authority = ''self_service'' AND challenge_id IS NOT NULL AND
          initiating_session_ref IS NOT NULL AND identifier_kind = ''email_exact'') OR
         authority <> ''self_service''),
  CHECK ((state IN (''authoritative_switched'', ''revocation_pending'', ''completed'',
                    ''blocked_forward_repair'') AND authoritative_switched_at IS NOT NULL) OR
         state IN (''directory_pending'', ''authoritative_switch_pending'', ''canceled'')),
  CHECK ((state = ''completed'' AND completed_at IS NOT NULL) OR state <> ''completed''),
  CHECK (retry_budget_expires_at > created_at)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_identifier_replacement_operations', (SELECT count(*) FROM "identity_identifier_replacement_operations" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_identifier_replacement_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_identifier_replacement_outbox' AND sql IN ('CREATE TABLE identity_identifier_replacement_outbox (
  outbox_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind = ''identifier_replacement''),
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND
    json_type(payload_json, ''$.operationId'') = ''text'' AND
    json_type(payload_json, ''$.tenantId'') = ''text'' AND
    json_type(payload_json, ''$.accountId'') = ''text'' AND
    json_type(payload_json, ''$.projections'') = ''array'' AND
    json_type(payload_json, ''$.oldValue'') IS NULL AND
    json_type(payload_json, ''$.newValue'') IS NULL AND
    length(payload_json) <= 16384
  ),
  status TEXT NOT NULL DEFAULT ''pending''
    CHECK (status IN (''pending'', ''leased'', ''retry'', ''succeeded'', ''blocked'')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES identity_identifier_replacement_operations(operation_id),
  CHECK ((status = ''succeeded'' AND completed_at IS NOT NULL) OR status <> ''succeeded'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_identifier_replacement_outbox', (SELECT count(*) FROM "identity_identifier_replacement_outbox" WHERE "outbox_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_identifier_replacement_projections', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_identifier_replacement_projections' AND sql IN ('CREATE TABLE identity_identifier_replacement_projections (
  operation_id TEXT NOT NULL,
  identifier_side TEXT NOT NULL CHECK (identifier_side IN (''old'', ''new'')),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  blind_digest TEXT NOT NULL CHECK (length(blind_digest) = 64),
  projection_state TEXT NOT NULL DEFAULT ''planned''
    CHECK (projection_state IN (''planned'', ''reserved'', ''pending'', ''active'', ''disabled'', ''released'')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (operation_id, identifier_side, hmac_key_generation),
  FOREIGN KEY (operation_id) REFERENCES identity_identifier_replacement_operations(operation_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:identity_sensitive_values', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='identity_sensitive_values' AND sql IN ('CREATE TABLE identity_sensitive_values (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  value_key TEXT NOT NULL,
  value_json TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT ''sensitive'',
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, owner_type, owner_id, value_key)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:identity_sensitive_values', (SELECT count(*) FROM "identity_sensitive_values" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:linked_identities', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='linked_identities' AND sql IN ('CREATE TABLE "linked_identities" (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT ''default'',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_name TEXT,
  raw_attributes TEXT,
  linked_at INTEGER NOT NULL,
  last_used_at INTEGER
, email_verified INTEGER NOT NULL DEFAULT 0, access_token_encrypted TEXT, refresh_token_encrypted TEXT, token_expires_at INTEGER, raw_claims TEXT, profile_data TEXT, last_login_at INTEGER, updated_at INTEGER, provisioning_state TEXT NOT NULL DEFAULT ''active''
  CHECK (provisioning_state IN (''pending'', ''active'')))'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:linked_identities', (SELECT count(*) FROM "linked_identities" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:migration_metadata', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='migration_metadata' AND sql IN ('CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)','CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY NOT NULL DEFAULT ''global'',
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT ''development'',
  metadata_json TEXT
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:migration_metadata', (SELECT count(*) FROM "migration_metadata" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:pairwise_subject_identifiers', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='pairwise_subject_identifiers' AND sql IN ('CREATE TABLE "pairwise_subject_identifiers" (
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
, tenant_id TEXT NOT NULL DEFAULT ''default'')'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:pairwise_subject_identifiers', (SELECT count(*) FROM "pairwise_subject_identifiers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:pii_log', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='pii_log' AND sql IN ('CREATE TABLE pii_log (
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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:pii_log', (SELECT count(*) FROM "pii_log" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:service_group_write_boundaries', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='service_group_write_boundaries' AND sql IN ('CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:service_group_write_boundaries', (SELECT count(*) FROM "service_group_write_boundaries" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:subject_identifiers', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='subject_identifiers' AND sql IN ('CREATE TABLE subject_identifiers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_value TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  verification_method TEXT,
  destination_type TEXT NOT NULL DEFAULT ''global'',
  destination_id TEXT NOT NULL DEFAULT ''default'',
  identifier_value_hash TEXT,
  identifier_storage_ref TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT ''active'',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:subject_identifiers', (SELECT count(*) FROM "subject_identifiers" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_database_migration_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_database_migration_state' AND sql IN ('CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )','CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY NOT NULL,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN (''applying'', ''ready'', ''blocked'')),
      last_filename TEXT,
      updated_at INTEGER NOT NULL
    )'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_database_migration_state', (SELECT count(*) FROM "tenant_database_migration_state" WHERE "stream_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_placement_migration_captures', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_placement_migration_captures' AND sql IN ('CREATE TABLE tenant_placement_migration_captures (
  operation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  capture_state TEXT NOT NULL DEFAULT ''capturing''
    CHECK (capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'', ''canceled'')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  installed_at INTEGER NOT NULL,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  canceled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((capture_state = ''write_fenced'' AND write_fenced_at IS NOT NULL)
    OR capture_state <> ''write_fenced''),
  CHECK ((capture_state = ''cutover_committed'' AND cutover_committed_at IS NOT NULL)
    OR capture_state <> ''cutover_committed''),
  CHECK ((capture_state = ''canceled'' AND canceled_at IS NOT NULL)
    OR capture_state <> ''canceled'')
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:tenant_placement_migration_captures', (SELECT count(*) FROM "tenant_placement_migration_captures" WHERE "operation_id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:tenant_placement_migration_outbox', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tenant_placement_migration_outbox' AND sql IN ('CREATE TABLE tenant_placement_migration_outbox (
  source_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (
    length(table_name) BETWEEN 1 AND 128 AND table_name NOT GLOB ''*[^a-z0-9_]*''
  ),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN (''upsert'', ''delete'')),
  mutation_key_json TEXT NOT NULL CHECK (json_valid(mutation_key_json)),
  row_json TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  capture_fencing_token INTEGER NOT NULL CHECK (capture_fencing_token >= 1),
  delivery_state TEXT NOT NULL DEFAULT ''pending''
    CHECK (delivery_state IN (''pending'', ''applied'')),
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES tenant_placement_migration_captures(operation_id),
  CHECK ((mutation_kind = ''upsert'' AND row_json IS NOT NULL) OR
         (mutation_kind = ''delete'' AND row_json IS NULL)),
  CHECK ((delivery_state = ''applied'' AND applied_at IS NOT NULL) OR
         (delivery_state = ''pending'' AND applied_at IS NULL))
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:user_anonymization_map', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='user_anonymization_map' AND sql IN ('CREATE TABLE user_anonymization_map (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  anonymized_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,

  UNIQUE(tenant_id, user_id)
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:user_anonymization_map', (SELECT count(*) FROM "user_anonymization_map" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:users_pii', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users_pii' AND sql IN ('CREATE TABLE users_pii (
  -- Primary key (same as users_core.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

  -- PII sensitivity classification
  -- IDENTITY_CORE | PROFILE | DEMOGRAPHIC | LOCATION | HIGH_RISK
  pii_class TEXT NOT NULL DEFAULT ''PROFILE'',

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:users_pii', (SELECT count(*) FROM "users_pii" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('schema:users_pii_tombstone', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='users_pii_tombstone' AND sql IN ('CREATE TABLE users_pii_tombstone (
  -- Primary key (same as original users_core.id)
  id TEXT PRIMARY KEY,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT ''default'',

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
)'))));

INSERT INTO "__authrim_pk_guard" VALUES ('null-primary-key:users_pii_tombstone', (SELECT count(*) FROM "users_pii_tombstone" WHERE "id" IS NULL));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_webhook_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_webhook_outbox_due' AND sql='CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_account_webhook_snapshot_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_account_webhook_snapshot_expiry' AND sql='CREATE INDEX idx_account_webhook_snapshot_expiry ON account_webhook_snapshots (tenant_id, expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_anon_map_anon_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_anon_map_anon_id' AND sql='CREATE INDEX idx_anon_map_anon_id
  ON user_anonymization_map(anonymized_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_anon_map_tenant_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_anon_map_tenant_user' AND sql='CREATE INDEX idx_anon_map_tenant_user
  ON user_anonymization_map(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_pii_action', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_pii_action' AND sql='CREATE INDEX idx_audit_pii_action
  ON audit_log_pii(action)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_pii_created', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_pii_created' AND sql='CREATE INDEX idx_audit_pii_created
  ON audit_log_pii(created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_pii_exported', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_pii_exported' AND sql='CREATE INDEX idx_audit_pii_exported
  ON audit_log_pii(exported_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_pii_target', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_pii_target' AND sql='CREATE INDEX idx_audit_pii_target
  ON audit_log_pii(target_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_audit_pii_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_audit_pii_user' AND sql='CREATE INDEX idx_audit_pii_user
  ON audit_log_pii(user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_external_identifier_unlink_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_external_identifier_unlink_due' AND sql='CREATE INDEX idx_external_identifier_unlink_due
  ON external_identifier_unlink_operations(state, next_attempt_at, lease_expires_at, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_upgrade_operations_account', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_upgrade_operations_account' AND sql='CREATE INDEX idx_guest_upgrade_operations_account
  ON guest_upgrade_operations (tenant_id, user_id, created_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_guest_upgrade_operations_recovery', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_guest_upgrade_operations_recovery' AND sql='CREATE INDEX idx_guest_upgrade_operations_recovery
  ON guest_upgrade_operations (tenant_id, state, lease_expires_at, updated_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identifier_replacement_challenge_account', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identifier_replacement_challenge_account' AND sql='CREATE INDEX idx_identifier_replacement_challenge_account
  ON identity_identifier_replacement_challenges(tenant_id, account_id, created_at DESC)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identifier_replacement_challenge_expiry', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identifier_replacement_challenge_expiry' AND sql='CREATE INDEX idx_identifier_replacement_challenge_expiry
  ON identity_identifier_replacement_challenges(expires_at, consumed_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identifier_replacement_operation_account_active', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identifier_replacement_operation_account_active' AND sql='CREATE UNIQUE INDEX idx_identifier_replacement_operation_account_active
  ON identity_identifier_replacement_operations(tenant_id, account_id, identifier_kind)
  WHERE state NOT IN (''completed'', ''canceled'')')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identifier_replacement_operation_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identifier_replacement_operation_due' AND sql='CREATE INDEX idx_identifier_replacement_operation_due
  ON identity_identifier_replacement_operations(state, next_attempt_at, lease_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identifier_replacement_outbox_due', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identifier_replacement_outbox_due' AND sql='CREATE INDEX idx_identifier_replacement_outbox_due
  ON identity_identifier_replacement_outbox(status, next_attempt_at, lease_expires_at)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identifier_replacement_projection_digest', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identifier_replacement_projection_digest' AND sql='CREATE UNIQUE INDEX idx_identifier_replacement_projection_digest
  ON identity_identifier_replacement_projections(
    operation_id, identifier_side, hmac_key_generation, blind_digest
  )')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_identity_sensitive_values_owner', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_identity_sensitive_values_owner' AND sql='CREATE INDEX idx_identity_sensitive_values_owner
  ON identity_sensitive_values(tenant_id, owner_type, owner_id, value_key, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_linked_identities_provisioning', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_linked_identities_provisioning' AND sql='CREATE INDEX idx_linked_identities_provisioning
  ON linked_identities(tenant_id, provider_id, provider_user_id, provisioning_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_linked_ids_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_linked_ids_email' AND sql='CREATE INDEX idx_linked_ids_email ON linked_identities(provider_email)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_linked_ids_provider', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_linked_ids_provider' AND sql='CREATE UNIQUE INDEX idx_linked_ids_provider
  ON linked_identities(tenant_id, provider_id, provider_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_linked_ids_provider_sub', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_linked_ids_provider_sub' AND sql='CREATE INDEX idx_linked_ids_provider_sub
  ON linked_identities(provider_id, provider_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_linked_ids_tenant_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_linked_ids_tenant_user' AND sql='CREATE INDEX idx_linked_ids_tenant_user
  ON linked_identities(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_linked_ids_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_linked_ids_user' AND sql='CREATE INDEX idx_linked_ids_user ON linked_identities(user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pairwise_subject_identifiers_client', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pairwise_subject_identifiers_client' AND sql='CREATE INDEX idx_pairwise_subject_identifiers_client
  ON pairwise_subject_identifiers(tenant_id, client_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pairwise_subject_identifiers_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pairwise_subject_identifiers_subject' AND sql='CREATE INDEX idx_pairwise_subject_identifiers_subject
  ON pairwise_subject_identifiers(tenant_id, subject)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pairwise_subject_identifiers_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pairwise_subject_identifiers_unique' AND sql='CREATE UNIQUE INDEX idx_pairwise_subject_identifiers_unique
  ON pairwise_subject_identifiers(tenant_id, user_id, sector_identifier)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pii_log_actor', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pii_log_actor' AND sql='CREATE INDEX idx_pii_log_actor
  ON pii_log(actor_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pii_log_anon_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pii_log_anon_user' AND sql='CREATE INDEX idx_pii_log_anon_user
  ON pii_log(anonymized_user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pii_log_change_type', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pii_log_change_type' AND sql='CREATE INDEX idx_pii_log_change_type
  ON pii_log(change_type)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pii_log_request_id', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pii_log_request_id' AND sql='CREATE INDEX idx_pii_log_request_id
  ON pii_log(request_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pii_log_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pii_log_retention' AND sql='CREATE INDEX idx_pii_log_retention
  ON pii_log(retention_until)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_pii_log_tenant_user', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_pii_log_tenant_user' AND sql='CREATE INDEX idx_pii_log_tenant_user
  ON pii_log(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_service_group_write_boundaries_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_service_group_write_boundaries_subject' AND sql='CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_identifiers_destination', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_identifiers_destination' AND sql='CREATE INDEX idx_subject_identifiers_destination
  ON subject_identifiers(tenant_id, subject_id, destination_type, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_identifiers_hash', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_identifiers_hash' AND sql='CREATE INDEX idx_subject_identifiers_hash
  ON subject_identifiers(tenant_id, identifier_type, identifier_value_hash, lifecycle_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_identifiers_primary', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_identifiers_primary' AND sql='CREATE INDEX idx_subject_identifiers_primary
  ON subject_identifiers(tenant_id, subject_id, is_primary)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_identifiers_tenant_subject', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_identifiers_tenant_subject' AND sql='CREATE INDEX idx_subject_identifiers_tenant_subject
  ON subject_identifiers(tenant_id, subject_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_subject_identifiers_unique', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_subject_identifiers_unique' AND sql='CREATE UNIQUE INDEX idx_subject_identifiers_unique
  ON subject_identifiers(tenant_id, identifier_type, identifier_value)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_placement_capture_tenant_state', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_placement_capture_tenant_state' AND sql='CREATE INDEX idx_tenant_placement_capture_tenant_state
  ON tenant_placement_migration_captures(tenant_id, capture_state)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tenant_placement_outbox_pending', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tenant_placement_outbox_pending' AND sql='CREATE INDEX idx_tenant_placement_outbox_pending
  ON tenant_placement_migration_outbox(operation_id, delivery_state, source_sequence)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tombstone_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tombstone_email' AND sql='CREATE INDEX idx_tombstone_email
  ON users_pii_tombstone(email_blind_index)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tombstone_retention', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tombstone_retention' AND sql='CREATE INDEX idx_tombstone_retention
  ON users_pii_tombstone(retention_until)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_tombstone_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_tombstone_tenant' AND sql='CREATE INDEX idx_tombstone_tenant
  ON users_pii_tombstone(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_pii_class', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_pii_class' AND sql='CREATE INDEX idx_users_pii_class
  ON users_pii(pii_class)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_pii_email', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_pii_email' AND sql='CREATE UNIQUE INDEX idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:idx_users_pii_tenant', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_users_pii_tenant' AND sql='CREATE INDEX idx_users_pii_tenant
  ON users_pii(tenant_id)')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_identity_sensitive_values_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_identity_sensitive_values_delete' AND sql='CREATE TRIGGER sg_identity_sensitive_values_delete AFTER DELETE ON identity_sensitive_values BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.owner_id, 1 WHERE (OLD.owner_type = ''runtime_user'') AND OLD.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_identity_sensitive_values_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_identity_sensitive_values_insert' AND sql='CREATE TRIGGER sg_identity_sensitive_values_insert AFTER INSERT ON identity_sensitive_values BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = ''runtime_user'') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_identity_sensitive_values_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_identity_sensitive_values_update' AND sql='CREATE TRIGGER sg_identity_sensitive_values_update AFTER UPDATE ON identity_sensitive_values BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.owner_id, 1 WHERE (NEW.owner_type = ''runtime_user'') AND NEW.owner_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_write_boundary_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_write_boundary_delete' AND sql='CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:sg_write_boundary_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='sg_write_boundary_insert' AND sql='CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_external_identifier_unlink_link_required', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_external_identifier_unlink_link_required' AND sql='CREATE TRIGGER trg_external_identifier_unlink_link_required
BEFORE INSERT ON external_identifier_unlink_operations
WHEN NOT EXISTS (
  SELECT 1 FROM linked_identities link
   WHERE link.tenant_id = NEW.tenant_id AND link.user_id = NEW.user_id
     AND link.provider_id = json_extract(NEW.issuer_json, ''$'')
     AND link.provider_user_id = json_extract(NEW.subject_json, ''$'')
)
BEGIN
  SELECT RAISE(ABORT, ''external_identifier_unlink_link_required'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_identifier_replacement_history_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_identifier_replacement_history_immutable' AND sql='CREATE TRIGGER trg_identifier_replacement_history_immutable
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
       AND operation.state IN (''completed'', ''canceled'')
  )
)
BEGIN
  SELECT RAISE(ABORT, ''identifier_replacement_history_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_identity_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_identity_immutable' AND sql='CREATE TRIGGER trg_tenant_placement_capture_identity_immutable
BEFORE UPDATE OF operation_id, tenant_id, source_shard_id, migration_generation
ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_identity_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_no_delete', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_no_delete' AND sql='CREATE TRIGGER trg_tenant_placement_capture_no_delete
BEFORE DELETE ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_delete_forbidden'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_one_active_insert', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_one_active_insert' AND sql='CREATE TRIGGER trg_tenant_placement_capture_one_active_insert
BEFORE INSERT ON tenant_placement_migration_captures
WHEN NEW.capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'')
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_active_conflict'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_one_active_update', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_one_active_update' AND sql='CREATE TRIGGER trg_tenant_placement_capture_one_active_update
BEFORE UPDATE OF tenant_id, capture_state ON tenant_placement_migration_captures
WHEN NEW.capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND operation_id <> OLD.operation_id
     AND capture_state IN (''capturing'', ''write_fenced'', ''cutover_committed'')
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_active_conflict'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_capture_transition', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_capture_transition' AND sql='CREATE TRIGGER trg_tenant_placement_capture_transition
BEFORE UPDATE OF capture_state ON tenant_placement_migration_captures
WHEN NOT (
  (OLD.capture_state = ''capturing'' AND NEW.capture_state IN (''write_fenced'', ''canceled'')) OR
  (OLD.capture_state = ''write_fenced'' AND NEW.capture_state IN (''capturing'', ''cutover_committed'', ''canceled'')) OR
  OLD.capture_state = NEW.capture_state
)
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_capture_transition_invalid'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('object:trg_tenant_placement_outbox_payload_immutable', (SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='trg_tenant_placement_outbox_payload_immutable' AND sql='CREATE TRIGGER trg_tenant_placement_outbox_payload_immutable
BEFORE UPDATE OF source_sequence, operation_id, tenant_id, table_name, mutation_kind,
                 mutation_key_json, row_json, capture_fencing_token, created_at
ON tenant_placement_migration_outbox
BEGIN
  SELECT RAISE(ABORT, ''tenant_placement_migration_outbox_payload_immutable'');
END')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-schema-objects', (SELECT count(*) FROM sqlite_schema WHERE sql IS NOT NULL AND (type='view' OR (type IN ('index','trigger') AND tbl_name IN ('account_webhook_outbox','account_webhook_snapshots','audit_log_pii','authrim_migrations','authrim_runtime_probes','external_identifier_unlink_operations','guest_upgrade_operations','identity_identifier_replacement_challenges','identity_identifier_replacement_history','identity_identifier_replacement_operations','identity_identifier_replacement_outbox','identity_identifier_replacement_projections','identity_sensitive_values','linked_identities','migration_metadata','pairwise_subject_identifiers','pii_log','service_group_write_boundaries','subject_identifiers','tenant_database_migration_state','tenant_placement_migration_captures','tenant_placement_migration_outbox','user_anonymization_map','users_pii','users_pii_tombstone'))) AND name NOT IN ('idx_account_webhook_outbox_due','idx_account_webhook_snapshot_expiry','idx_anon_map_anon_id','idx_anon_map_tenant_user','idx_audit_pii_action','idx_audit_pii_created','idx_audit_pii_exported','idx_audit_pii_target','idx_audit_pii_user','idx_external_identifier_unlink_due','idx_guest_upgrade_operations_account','idx_guest_upgrade_operations_recovery','idx_identifier_replacement_challenge_account','idx_identifier_replacement_challenge_expiry','idx_identifier_replacement_operation_account_active','idx_identifier_replacement_operation_due','idx_identifier_replacement_outbox_due','idx_identifier_replacement_projection_digest','idx_identity_sensitive_values_owner','idx_linked_identities_provisioning','idx_linked_ids_email','idx_linked_ids_provider','idx_linked_ids_provider_sub','idx_linked_ids_tenant_user','idx_linked_ids_user','idx_pairwise_subject_identifiers_client','idx_pairwise_subject_identifiers_subject','idx_pairwise_subject_identifiers_unique','idx_pii_log_actor','idx_pii_log_anon_user','idx_pii_log_change_type','idx_pii_log_request_id','idx_pii_log_retention','idx_pii_log_tenant_user','idx_service_group_write_boundaries_subject','idx_subject_identifiers_destination','idx_subject_identifiers_hash','idx_subject_identifiers_primary','idx_subject_identifiers_tenant_subject','idx_subject_identifiers_unique','idx_tenant_placement_capture_tenant_state','idx_tenant_placement_outbox_pending','idx_tombstone_email','idx_tombstone_retention','idx_tombstone_tenant','idx_users_pii_class','idx_users_pii_email','idx_users_pii_tenant','sg_identity_sensitive_values_delete','sg_identity_sensitive_values_insert','sg_identity_sensitive_values_update','sg_write_boundary_delete','sg_write_boundary_insert','trg_external_identifier_unlink_link_required','trg_identifier_replacement_history_immutable','trg_tenant_placement_capture_identity_immutable','trg_tenant_placement_capture_no_delete','trg_tenant_placement_capture_one_active_insert','trg_tenant_placement_capture_one_active_update','trg_tenant_placement_capture_transition','trg_tenant_placement_outbox_payload_immutable')));

INSERT INTO "__authrim_pk_guard" VALUES ('unknown-dependent-table', (WITH candidates AS MATERIALIZED (SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT IN ('account_webhook_outbox','account_webhook_snapshots','audit_log_pii','authrim_migrations','authrim_runtime_probes','external_identifier_unlink_operations','guest_upgrade_operations','identity_identifier_replacement_challenges','identity_identifier_replacement_history','identity_identifier_replacement_operations','identity_identifier_replacement_outbox','identity_identifier_replacement_projections','identity_sensitive_values','linked_identities','migration_metadata','pairwise_subject_identifiers','pii_log','service_group_write_boundaries','subject_identifiers','tenant_database_migration_state','tenant_placement_migration_captures','tenant_placement_migration_outbox','user_anonymization_map','users_pii','users_pii_tombstone')) SELECT count(*) FROM candidates s JOIN pragma_foreign_key_list(s.name) f WHERE f."table" IN ('account_webhook_outbox','account_webhook_snapshots','audit_log_pii','authrim_migrations','authrim_runtime_probes','external_identifier_unlink_operations','guest_upgrade_operations','identity_identifier_replacement_challenges','identity_identifier_replacement_history','identity_identifier_replacement_operations','identity_identifier_replacement_outbox','identity_identifier_replacement_projections','identity_sensitive_values','linked_identities','migration_metadata','pairwise_subject_identifiers','pii_log','service_group_write_boundaries','subject_identifiers','tenant_database_migration_state','tenant_placement_migration_captures','tenant_placement_migration_outbox','user_anonymization_map','users_pii','users_pii_tombstone')));

CREATE TABLE "__authrim_pk_copy_account_webhook_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","event_type","registration_state","previous_registration_state","changed_field","occurred_at","attempts","next_attempt_at","lease_token","lease_until","delivered_at" FROM "account_webhook_outbox";

CREATE TABLE "__authrim_pk_copy_account_webhook_snapshots" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","account_id","event_type","registration_state","email_before_json","email_after_json","created_at","expires_at" FROM "account_webhook_snapshots";

CREATE TABLE "__authrim_pk_copy_audit_log_pii" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","action","target_user_id","details","ip_address","user_agent","created_at","exported_at" FROM "audit_log_pii";

CREATE TABLE "__authrim_pk_copy_authrim_migrations" AS SELECT "rowid" AS "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "authrim_migrations";

CREATE TABLE "__authrim_pk_copy_authrim_runtime_probes" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "authrim_runtime_probes";

CREATE TABLE "__authrim_pk_copy_external_identifier_unlink_operations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","account_id","user_id","issuer_json","subject_json","issuer_sha256","subject_sha256","route_projection_json","state","attempt_count","next_attempt_at","lease_owner","lease_expires_at","fencing_token","error_code","raw_values_erased_at","completed_at","created_at","updated_at" FROM "external_identifier_unlink_operations";

CREATE TABLE "__authrim_pk_copy_guest_upgrade_operations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","user_id","client_id","initiating_session_id","request_token_hash","method","state","proof_payload_json","challenge_verifier","reservation_publication_json","attempt_count","expires_at","lease_owner","lease_expires_at","completed_at","created_at","updated_at" FROM "guest_upgrade_operations";

CREATE TABLE "__authrim_pk_copy_identity_identifier_replacement_challenges" AS SELECT "rowid" AS "__authrim_original_rowid","challenge_id","tenant_id","account_id","identifier_kind","normalized_value_json","raw_value_erased_at","value_sha256","otp_verifier","delivery_state","attempt_count","attempt_limit","expires_at","consumed_at","initiating_session_ref","recent_reauth_verified_at","created_at","updated_at","operation_mode" FROM "identity_identifier_replacement_challenges";

CREATE TABLE "__authrim_pk_copy_identity_identifier_replacement_history" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","old_value_json","new_value_json","old_value_sha256","new_value_sha256","normalization_version","actor_ref","authority_evidence_json","verification_evidence_json","raw_values_erased_at","created_at" FROM "identity_identifier_replacement_history";

CREATE TABLE "__authrim_pk_copy_identity_identifier_replacement_operations" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","account_id","identifier_kind","authority","idempotency_key_sha256","request_fingerprint_sha256","challenge_id","initiating_session_ref","state","outbox_id","attempt_count","next_attempt_at","retry_budget_expires_at","lease_owner","lease_expires_at","fencing_token","error_code","authoritative_switched_at","completed_at","created_at","updated_at" FROM "identity_identifier_replacement_operations";

CREATE TABLE "__authrim_pk_copy_identity_identifier_replacement_outbox" AS SELECT "rowid" AS "__authrim_original_rowid","outbox_id","operation_id","tenant_id","account_id","event_kind","payload_json","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","error_code","created_at","completed_at","updated_at" FROM "identity_identifier_replacement_outbox";

CREATE TABLE "__authrim_pk_copy_identity_identifier_replacement_projections" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","identifier_side","hmac_key_generation","normalization_version","virtual_bucket","blind_digest","projection_state","created_at","updated_at" FROM "identity_identifier_replacement_projections";

CREATE TABLE "__authrim_pk_copy_identity_sensitive_values" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","owner_type","owner_id","value_key","value_json","value_hash","classification","lifecycle_state","created_at","updated_at" FROM "identity_sensitive_values";

CREATE TABLE "__authrim_pk_copy_linked_identities" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","provider_id","provider_user_id","provider_email","provider_name","raw_attributes","linked_at","last_used_at","email_verified","access_token_encrypted","refresh_token_encrypted","token_expires_at","raw_claims","profile_data","last_login_at","updated_at","provisioning_state" FROM "linked_identities";

CREATE TABLE "__authrim_pk_copy_migration_metadata" AS SELECT "rowid" AS "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "migration_metadata";

CREATE TABLE "__authrim_pk_copy_pairwise_subject_identifiers" AS SELECT "rowid" AS "__authrim_original_rowid","id","user_id","client_id","sector_identifier","subject","created_at","tenant_id" FROM "pairwise_subject_identifiers";

CREATE TABLE "__authrim_pk_copy_pii_log" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","anonymized_user_id","change_type","affected_fields","values_r2_key","values_encrypted","encryption_key_id","encryption_iv","actor_user_id","actor_type","request_id","legal_basis","consent_reference","retention_until","created_at" FROM "pii_log";

CREATE TABLE "__authrim_pk_copy_service_group_write_boundaries" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","operation","status","created_at" FROM "service_group_write_boundaries";

CREATE TABLE "__authrim_pk_copy_subject_identifiers" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","subject_id","identifier_type","identifier_value","is_primary","verified_at","verification_method","destination_type","destination_id","identifier_value_hash","identifier_storage_ref","lifecycle_state","created_at","updated_at" FROM "subject_identifiers";

CREATE TABLE "__authrim_pk_copy_tenant_database_migration_state" AS SELECT "rowid" AS "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "tenant_database_migration_state";

CREATE TABLE "__authrim_pk_copy_tenant_placement_migration_captures" AS SELECT "rowid" AS "__authrim_original_rowid","operation_id","tenant_id","source_shard_id","migration_generation","capture_state","fencing_token","installed_at","write_fenced_at","cutover_committed_at","canceled_at","updated_at" FROM "tenant_placement_migration_captures";

CREATE TABLE "__authrim_pk_copy_tenant_placement_migration_outbox" AS SELECT "source_sequence","operation_id","tenant_id","table_name","mutation_kind","mutation_key_json","row_json","capture_fencing_token","delivery_state","applied_at","created_at" FROM "tenant_placement_migration_outbox";

CREATE TABLE "__authrim_pk_copy_user_anonymization_map" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","user_id","anonymized_user_id","created_at" FROM "user_anonymization_map";

CREATE TABLE "__authrim_pk_copy_users_pii" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","pii_class","email","email_blind_index","phone_number","name","given_name","family_name","middle_name","nickname","preferred_username","profile","picture","website","gender","birthdate","locale","zoneinfo","address_formatted","address_street_address","address_locality","address_region","address_postal_code","address_country","declared_residence","custom_attributes_json","created_at","updated_at" FROM "users_pii";

CREATE TABLE "__authrim_pk_copy_users_pii_tombstone" AS SELECT "rowid" AS "__authrim_original_rowid","id","tenant_id","email_blind_index","deleted_at","deleted_by","deletion_reason","retention_until","deletion_metadata","created_at","updated_at" FROM "users_pii_tombstone";

CREATE TABLE "__authrim_pk_sequences" AS SELECT name, seq FROM sqlite_sequence WHERE name IN ('tenant_placement_migration_outbox');

PRAGMA defer_foreign_keys = ON;

DROP TRIGGER "sg_identity_sensitive_values_delete";

DROP TRIGGER "sg_identity_sensitive_values_insert";

DROP TRIGGER "sg_identity_sensitive_values_update";

DROP TRIGGER "sg_write_boundary_delete";

DROP TRIGGER "sg_write_boundary_insert";

DROP TRIGGER "trg_external_identifier_unlink_link_required";

DROP TRIGGER "trg_identifier_replacement_history_immutable";

DROP TRIGGER "trg_tenant_placement_capture_identity_immutable";

DROP TRIGGER "trg_tenant_placement_capture_no_delete";

DROP TRIGGER "trg_tenant_placement_capture_one_active_insert";

DROP TRIGGER "trg_tenant_placement_capture_one_active_update";

DROP TRIGGER "trg_tenant_placement_capture_transition";

DROP TRIGGER "trg_tenant_placement_outbox_payload_immutable";

DROP TABLE "account_webhook_outbox";

DROP TABLE "account_webhook_snapshots";

DROP TABLE "audit_log_pii";

DROP TABLE "authrim_migrations";

DROP TABLE "authrim_runtime_probes";

DROP TABLE "external_identifier_unlink_operations";

DROP TABLE "guest_upgrade_operations";

DROP TABLE "identity_identifier_replacement_history";

DROP TABLE "identity_identifier_replacement_outbox";

DROP TABLE "identity_identifier_replacement_projections";

DROP TABLE "identity_sensitive_values";

DROP TABLE "linked_identities";

DROP TABLE "migration_metadata";

DROP TABLE "pairwise_subject_identifiers";

DROP TABLE "pii_log";

DROP TABLE "service_group_write_boundaries";

DROP TABLE "subject_identifiers";

DROP TABLE "tenant_database_migration_state";

DROP TABLE "tenant_placement_migration_outbox";

DROP TABLE "user_anonymization_map";

DROP TABLE "users_pii";

DROP TABLE "users_pii_tombstone";

DROP TABLE "identity_identifier_replacement_operations";

DROP TABLE "tenant_placement_migration_captures";

DROP TABLE "identity_identifier_replacement_challenges";

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

CREATE TABLE authrim_migrations (
  filename TEXT PRIMARY KEY
 NOT NULL
,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  execution_time_ms INTEGER,
  setup_version TEXT,
  tool_version TEXT
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

CREATE TABLE "identity_identifier_replacement_operations" (
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

CREATE TABLE "linked_identities" (
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

CREATE TABLE "pairwise_subject_identifiers" (
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

CREATE TABLE tenant_database_migration_state (
      stream_id TEXT PRIMARY KEY
 NOT NULL
,
      release_id TEXT NOT NULL,
      manifest_digest TEXT NOT NULL,
      applied_file_count INTEGER NOT NULL CHECK (applied_file_count >= 0),
      state TEXT NOT NULL CHECK (state IN ('applying', 'ready', 'blocked')),
      last_filename TEXT,
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

CREATE INDEX idx_tombstone_tenant
  ON users_pii_tombstone(tenant_id);

CREATE INDEX idx_users_pii_class
  ON users_pii(pii_class);

CREATE UNIQUE INDEX idx_users_pii_email
  ON users_pii(tenant_id, email_blind_index);

CREATE INDEX idx_users_pii_tenant
  ON users_pii(tenant_id);

INSERT INTO "account_webhook_outbox" ("rowid","id","tenant_id","user_id","event_type","registration_state","previous_registration_state","changed_field","occurred_at","attempts","next_attempt_at","lease_token","lease_until","delivered_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","event_type","registration_state","previous_registration_state","changed_field","occurred_at","attempts","next_attempt_at","lease_token","lease_until","delivered_at" FROM "__authrim_pk_copy_account_webhook_outbox";

INSERT INTO "account_webhook_snapshots" ("rowid","id","tenant_id","user_id","account_id","event_type","registration_state","email_before_json","email_after_json","created_at","expires_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","account_id","event_type","registration_state","email_before_json","email_after_json","created_at","expires_at" FROM "__authrim_pk_copy_account_webhook_snapshots";

INSERT INTO "audit_log_pii" ("rowid","id","tenant_id","user_id","action","target_user_id","details","ip_address","user_agent","created_at","exported_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","action","target_user_id","details","ip_address","user_agent","created_at","exported_at" FROM "__authrim_pk_copy_audit_log_pii";

INSERT INTO "authrim_migrations" ("rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version") SELECT "__authrim_original_rowid","filename","checksum","applied_at","execution_time_ms","setup_version","tool_version" FROM "__authrim_pk_copy_authrim_migrations";

INSERT INTO "authrim_runtime_probes" ("rowid","id","tenant_id","role","probe_kind","nonce","created_at") SELECT "__authrim_original_rowid","id","tenant_id","role","probe_kind","nonce","created_at" FROM "__authrim_pk_copy_authrim_runtime_probes";

INSERT INTO "external_identifier_unlink_operations" ("rowid","operation_id","tenant_id","account_id","user_id","issuer_json","subject_json","issuer_sha256","subject_sha256","route_projection_json","state","attempt_count","next_attempt_at","lease_owner","lease_expires_at","fencing_token","error_code","raw_values_erased_at","completed_at","created_at","updated_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","account_id","user_id","issuer_json","subject_json","issuer_sha256","subject_sha256","route_projection_json","state","attempt_count","next_attempt_at","lease_owner","lease_expires_at","fencing_token","error_code","raw_values_erased_at","completed_at","created_at","updated_at" FROM "__authrim_pk_copy_external_identifier_unlink_operations";

INSERT INTO "guest_upgrade_operations" ("rowid","operation_id","tenant_id","user_id","client_id","initiating_session_id","request_token_hash","method","state","proof_payload_json","challenge_verifier","reservation_publication_json","attempt_count","expires_at","lease_owner","lease_expires_at","completed_at","created_at","updated_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","user_id","client_id","initiating_session_id","request_token_hash","method","state","proof_payload_json","challenge_verifier","reservation_publication_json","attempt_count","expires_at","lease_owner","lease_expires_at","completed_at","created_at","updated_at" FROM "__authrim_pk_copy_guest_upgrade_operations";

INSERT INTO "identity_identifier_replacement_challenges" ("rowid","challenge_id","tenant_id","account_id","identifier_kind","normalized_value_json","raw_value_erased_at","value_sha256","otp_verifier","delivery_state","attempt_count","attempt_limit","expires_at","consumed_at","initiating_session_ref","recent_reauth_verified_at","created_at","updated_at","operation_mode") SELECT "__authrim_original_rowid","challenge_id","tenant_id","account_id","identifier_kind","normalized_value_json","raw_value_erased_at","value_sha256","otp_verifier","delivery_state","attempt_count","attempt_limit","expires_at","consumed_at","initiating_session_ref","recent_reauth_verified_at","created_at","updated_at","operation_mode" FROM "__authrim_pk_copy_identity_identifier_replacement_challenges";

INSERT INTO "identity_identifier_replacement_history" ("rowid","operation_id","old_value_json","new_value_json","old_value_sha256","new_value_sha256","normalization_version","actor_ref","authority_evidence_json","verification_evidence_json","raw_values_erased_at","created_at") SELECT "__authrim_original_rowid","operation_id","old_value_json","new_value_json","old_value_sha256","new_value_sha256","normalization_version","actor_ref","authority_evidence_json","verification_evidence_json","raw_values_erased_at","created_at" FROM "__authrim_pk_copy_identity_identifier_replacement_history";

INSERT INTO "identity_identifier_replacement_operations" ("rowid","operation_id","tenant_id","account_id","identifier_kind","authority","idempotency_key_sha256","request_fingerprint_sha256","challenge_id","initiating_session_ref","state","outbox_id","attempt_count","next_attempt_at","retry_budget_expires_at","lease_owner","lease_expires_at","fencing_token","error_code","authoritative_switched_at","completed_at","created_at","updated_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","account_id","identifier_kind","authority","idempotency_key_sha256","request_fingerprint_sha256","challenge_id","initiating_session_ref","state","outbox_id","attempt_count","next_attempt_at","retry_budget_expires_at","lease_owner","lease_expires_at","fencing_token","error_code","authoritative_switched_at","completed_at","created_at","updated_at" FROM "__authrim_pk_copy_identity_identifier_replacement_operations";

INSERT INTO "identity_identifier_replacement_outbox" ("rowid","outbox_id","operation_id","tenant_id","account_id","event_kind","payload_json","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","error_code","created_at","completed_at","updated_at") SELECT "__authrim_original_rowid","outbox_id","operation_id","tenant_id","account_id","event_kind","payload_json","status","attempt_count","next_attempt_at","lease_owner","lease_expires_at","error_code","created_at","completed_at","updated_at" FROM "__authrim_pk_copy_identity_identifier_replacement_outbox";

INSERT INTO "identity_identifier_replacement_projections" ("rowid","operation_id","identifier_side","hmac_key_generation","normalization_version","virtual_bucket","blind_digest","projection_state","created_at","updated_at") SELECT "__authrim_original_rowid","operation_id","identifier_side","hmac_key_generation","normalization_version","virtual_bucket","blind_digest","projection_state","created_at","updated_at" FROM "__authrim_pk_copy_identity_identifier_replacement_projections";

INSERT INTO "identity_sensitive_values" ("rowid","id","tenant_id","owner_type","owner_id","value_key","value_json","value_hash","classification","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","owner_type","owner_id","value_key","value_json","value_hash","classification","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_identity_sensitive_values";

INSERT INTO "linked_identities" ("rowid","id","tenant_id","user_id","provider_id","provider_user_id","provider_email","provider_name","raw_attributes","linked_at","last_used_at","email_verified","access_token_encrypted","refresh_token_encrypted","token_expires_at","raw_claims","profile_data","last_login_at","updated_at","provisioning_state") SELECT "__authrim_original_rowid","id","tenant_id","user_id","provider_id","provider_user_id","provider_email","provider_name","raw_attributes","linked_at","last_used_at","email_verified","access_token_encrypted","refresh_token_encrypted","token_expires_at","raw_claims","profile_data","last_login_at","updated_at","provisioning_state" FROM "__authrim_pk_copy_linked_identities";

INSERT INTO "migration_metadata" ("rowid","id","current_version","last_migration_at","environment","metadata_json") SELECT "__authrim_original_rowid","id","current_version","last_migration_at","environment","metadata_json" FROM "__authrim_pk_copy_migration_metadata";

INSERT INTO "pairwise_subject_identifiers" ("rowid","id","user_id","client_id","sector_identifier","subject","created_at","tenant_id") SELECT "__authrim_original_rowid","id","user_id","client_id","sector_identifier","subject","created_at","tenant_id" FROM "__authrim_pk_copy_pairwise_subject_identifiers";

INSERT INTO "pii_log" ("rowid","id","tenant_id","user_id","anonymized_user_id","change_type","affected_fields","values_r2_key","values_encrypted","encryption_key_id","encryption_iv","actor_user_id","actor_type","request_id","legal_basis","consent_reference","retention_until","created_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","anonymized_user_id","change_type","affected_fields","values_r2_key","values_encrypted","encryption_key_id","encryption_iv","actor_user_id","actor_type","request_id","legal_basis","consent_reference","retention_until","created_at" FROM "__authrim_pk_copy_pii_log";

INSERT INTO "service_group_write_boundaries" ("rowid","id","tenant_id","user_id","operation","status","created_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","operation","status","created_at" FROM "__authrim_pk_copy_service_group_write_boundaries";

INSERT INTO "subject_identifiers" ("rowid","id","tenant_id","subject_id","identifier_type","identifier_value","is_primary","verified_at","verification_method","destination_type","destination_id","identifier_value_hash","identifier_storage_ref","lifecycle_state","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","subject_id","identifier_type","identifier_value","is_primary","verified_at","verification_method","destination_type","destination_id","identifier_value_hash","identifier_storage_ref","lifecycle_state","created_at","updated_at" FROM "__authrim_pk_copy_subject_identifiers";

INSERT INTO "tenant_database_migration_state" ("rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at") SELECT "__authrim_original_rowid","stream_id","release_id","manifest_digest","applied_file_count","state","last_filename","updated_at" FROM "__authrim_pk_copy_tenant_database_migration_state";

INSERT INTO "tenant_placement_migration_captures" ("rowid","operation_id","tenant_id","source_shard_id","migration_generation","capture_state","fencing_token","installed_at","write_fenced_at","cutover_committed_at","canceled_at","updated_at") SELECT "__authrim_original_rowid","operation_id","tenant_id","source_shard_id","migration_generation","capture_state","fencing_token","installed_at","write_fenced_at","cutover_committed_at","canceled_at","updated_at" FROM "__authrim_pk_copy_tenant_placement_migration_captures";

INSERT INTO "tenant_placement_migration_outbox" ("source_sequence","operation_id","tenant_id","table_name","mutation_kind","mutation_key_json","row_json","capture_fencing_token","delivery_state","applied_at","created_at") SELECT "source_sequence","operation_id","tenant_id","table_name","mutation_kind","mutation_key_json","row_json","capture_fencing_token","delivery_state","applied_at","created_at" FROM "__authrim_pk_copy_tenant_placement_migration_outbox";

INSERT INTO "user_anonymization_map" ("rowid","id","tenant_id","user_id","anonymized_user_id","created_at") SELECT "__authrim_original_rowid","id","tenant_id","user_id","anonymized_user_id","created_at" FROM "__authrim_pk_copy_user_anonymization_map";

INSERT INTO "users_pii" ("rowid","id","tenant_id","pii_class","email","email_blind_index","phone_number","name","given_name","family_name","middle_name","nickname","preferred_username","profile","picture","website","gender","birthdate","locale","zoneinfo","address_formatted","address_street_address","address_locality","address_region","address_postal_code","address_country","declared_residence","custom_attributes_json","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","pii_class","email","email_blind_index","phone_number","name","given_name","family_name","middle_name","nickname","preferred_username","profile","picture","website","gender","birthdate","locale","zoneinfo","address_formatted","address_street_address","address_locality","address_region","address_postal_code","address_country","declared_residence","custom_attributes_json","created_at","updated_at" FROM "__authrim_pk_copy_users_pii";

INSERT INTO "users_pii_tombstone" ("rowid","id","tenant_id","email_blind_index","deleted_at","deleted_by","deletion_reason","retention_until","deletion_metadata","created_at","updated_at") SELECT "__authrim_original_rowid","id","tenant_id","email_blind_index","deleted_at","deleted_by","deletion_reason","retention_until","deletion_metadata","created_at","updated_at" FROM "__authrim_pk_copy_users_pii_tombstone";

DELETE FROM sqlite_sequence WHERE name IN ('tenant_placement_migration_outbox');

INSERT INTO sqlite_sequence (name,seq) SELECT name,seq FROM "__authrim_pk_sequences";

DROP TABLE "__authrim_pk_sequences";

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

INSERT INTO "__authrim_pk_guard" VALUES ('foreign-key-check', (SELECT count(*) FROM pragma_foreign_key_check));

DROP TABLE "__authrim_pk_copy_account_webhook_outbox";

DROP TABLE "__authrim_pk_copy_account_webhook_snapshots";

DROP TABLE "__authrim_pk_copy_audit_log_pii";

DROP TABLE "__authrim_pk_copy_authrim_migrations";

DROP TABLE "__authrim_pk_copy_authrim_runtime_probes";

DROP TABLE "__authrim_pk_copy_external_identifier_unlink_operations";

DROP TABLE "__authrim_pk_copy_guest_upgrade_operations";

DROP TABLE "__authrim_pk_copy_identity_identifier_replacement_challenges";

DROP TABLE "__authrim_pk_copy_identity_identifier_replacement_history";

DROP TABLE "__authrim_pk_copy_identity_identifier_replacement_operations";

DROP TABLE "__authrim_pk_copy_identity_identifier_replacement_outbox";

DROP TABLE "__authrim_pk_copy_identity_identifier_replacement_projections";

DROP TABLE "__authrim_pk_copy_identity_sensitive_values";

DROP TABLE "__authrim_pk_copy_linked_identities";

DROP TABLE "__authrim_pk_copy_migration_metadata";

DROP TABLE "__authrim_pk_copy_pairwise_subject_identifiers";

DROP TABLE "__authrim_pk_copy_pii_log";

DROP TABLE "__authrim_pk_copy_service_group_write_boundaries";

DROP TABLE "__authrim_pk_copy_subject_identifiers";

DROP TABLE "__authrim_pk_copy_tenant_database_migration_state";

DROP TABLE "__authrim_pk_copy_tenant_placement_migration_captures";

DROP TABLE "__authrim_pk_copy_tenant_placement_migration_outbox";

DROP TABLE "__authrim_pk_copy_user_anonymization_map";

DROP TABLE "__authrim_pk_copy_users_pii";

DROP TABLE "__authrim_pk_copy_users_pii_tombstone";

DROP TABLE "__authrim_pk_guard";

PRAGMA defer_foreign_keys = OFF;
