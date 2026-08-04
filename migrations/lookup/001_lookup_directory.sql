-- Tenant Lookup D1 schema. Raw email addresses and provider subjects are prohibited.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lookup_schema_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup_identifiers (
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  index_kind TEXT NOT NULL CHECK (index_kind IN ('email_exact', 'external_subject', 'account_id')),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  identifier_blind_digest TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  account_route_generation INTEGER NOT NULL CHECK (account_route_generation >= 1),
  required_binding_route_generation INTEGER NOT NULL CHECK (required_binding_route_generation >= 1),
  residency_policy_id TEXT NOT NULL,
  route_projection_json TEXT NOT NULL,
  tenant_lifecycle_state TEXT NOT NULL
    CHECK (tenant_lifecycle_state IN ('creating', 'active', 'quarantining', 'quarantined', 'disabled')),
  runtime_route_status TEXT NOT NULL
    CHECK (runtime_route_status IN ('pending', 'active', 'quarantining', 'disabled')),
  lifecycle_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (lifecycle_state IN ('pending', 'active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  PRIMARY KEY (
    virtual_bucket,
    index_kind,
    normalization_version,
    hmac_key_generation,
    identifier_blind_digest,
    tenant_id,
    account_id
  ),
  CHECK (lifecycle_state <> 'active' OR
         (tenant_lifecycle_state = 'active' AND runtime_route_status = 'active'))
);

CREATE INDEX IF NOT EXISTS idx_lookup_identifiers_exact_active
  ON lookup_identifiers(
    virtual_bucket,
    index_kind,
    hmac_key_generation,
    identifier_blind_digest,
    lifecycle_state
  );
CREATE INDEX IF NOT EXISTS idx_lookup_identifiers_account
  ON lookup_identifiers(tenant_id, account_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_lookup_identifiers_route_generation
  ON lookup_identifiers(account_route_generation, required_binding_route_generation);

CREATE TABLE IF NOT EXISTS lookup_tenant_aliases (
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  alias_kind TEXT NOT NULL CHECK (alias_kind IN (
    'tenant_code',
    'tenant_slug',
    'environment_tenant',
    'client_id',
    'invitation_token',
    'custom_domain'
  )),
  alias_sha256_digest TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  route_projection_json TEXT NOT NULL,
  tenant_lifecycle_state TEXT NOT NULL
    CHECK (tenant_lifecycle_state IN ('creating', 'active', 'quarantining', 'quarantined', 'disabled')),
  runtime_route_status TEXT NOT NULL
    CHECK (runtime_route_status IN ('pending', 'active', 'quarantining', 'disabled')),
  lifecycle_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (lifecycle_state IN ('pending', 'active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (virtual_bucket, alias_kind, alias_sha256_digest, tenant_id),
  CHECK (lifecycle_state <> 'active' OR
         (tenant_lifecycle_state = 'active' AND runtime_route_status = 'active'))
);

CREATE INDEX IF NOT EXISTS idx_lookup_tenant_aliases_exact_active
  ON lookup_tenant_aliases(virtual_bucket, alias_kind, alias_sha256_digest, lifecycle_state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lookup_tenant_aliases_unique_live
  ON lookup_tenant_aliases(virtual_bucket, alias_kind, alias_sha256_digest)
  WHERE lifecycle_state <> 'disabled'
    AND alias_kind IN ('tenant_code', 'tenant_slug', 'invitation_token', 'custom_domain');

CREATE TABLE IF NOT EXISTS lookup_identifier_reservations (
  virtual_bucket INTEGER NOT NULL CHECK (virtual_bucket BETWEEN 0 AND 4095),
  tenant_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (index_kind IN ('email_exact', 'external_subject')),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  identifier_blind_digest TEXT NOT NULL,
  account_id TEXT NOT NULL,
  reservation_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (reservation_state IN ('reserved', 'committed', 'releasing', 'released', 'repair_required')),
  operation_id TEXT NOT NULL,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  released_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    virtual_bucket,
    tenant_id,
    index_kind,
    normalization_version,
    hmac_key_generation,
    identifier_blind_digest
  ),
  CHECK ((reservation_state = 'released' AND released_at IS NOT NULL) OR reservation_state <> 'released')
);

CREATE INDEX IF NOT EXISTS idx_lookup_identifier_reservations_account
  ON lookup_identifier_reservations(tenant_id, account_id, reservation_state);
CREATE INDEX IF NOT EXISTS idx_lookup_identifier_reservations_repair
  ON lookup_identifier_reservations(reservation_state, updated_at);

CREATE TABLE IF NOT EXISTS lookup_bucket_counters (
  virtual_bucket INTEGER PRIMARY KEY CHECK (virtual_bucket BETWEEN 0 AND 4095),
  estimated_active_identifier_count INTEGER NOT NULL DEFAULT 0
    CHECK (estimated_active_identifier_count >= 0),
  estimated_active_alias_count INTEGER NOT NULL DEFAULT 0
    CHECK (estimated_active_alias_count >= 0),
  exact_count_checked_at INTEGER,
  reconciliation_cursor TEXT,
  reconciliation_error_code TEXT,
  updated_at INTEGER NOT NULL
);

WITH RECURSIVE lookup_counter_bucket(virtual_bucket) AS (
  SELECT 0
  UNION ALL
  SELECT virtual_bucket + 1 FROM lookup_counter_bucket WHERE virtual_bucket < 4095
)
INSERT INTO lookup_bucket_counters (
  virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
  exact_count_checked_at, reconciliation_cursor, reconciliation_error_code, updated_at
)
SELECT virtual_bucket, 0, 0, unixepoch(), 'bootstrap', NULL, unixepoch()
  FROM lookup_counter_bucket
 WHERE NOT EXISTS (
   SELECT 1
     FROM lookup_bucket_counters existing
    WHERE existing.virtual_bucket = lookup_counter_bucket.virtual_bucket
 );

CREATE TRIGGER IF NOT EXISTS trg_lookup_identifier_counter_insert
AFTER INSERT ON lookup_identifiers
WHEN NEW.lifecycle_state = 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (NEW.virtual_bucket, 1, 0, 'identifier-trigger', NEW.updated_at)
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_identifier_count = estimated_active_identifier_count + 1,
    reconciliation_cursor = 'identifier-trigger', reconciliation_error_code = NULL,
    updated_at = NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_identifier_counter_activate
AFTER UPDATE OF lifecycle_state ON lookup_identifiers
WHEN OLD.lifecycle_state <> 'active' AND NEW.lifecycle_state = 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (NEW.virtual_bucket, 1, 0, 'identifier-trigger', NEW.updated_at)
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_identifier_count = estimated_active_identifier_count + 1,
    reconciliation_cursor = 'identifier-trigger', reconciliation_error_code = NULL,
    updated_at = NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_identifier_counter_deactivate
AFTER UPDATE OF lifecycle_state ON lookup_identifiers
WHEN OLD.lifecycle_state = 'active' AND NEW.lifecycle_state <> 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (NEW.virtual_bucket, 0, 0, 'identifier-trigger', NEW.updated_at)
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_identifier_count =
      CASE WHEN estimated_active_identifier_count > 0
           THEN estimated_active_identifier_count - 1 ELSE 0 END,
    reconciliation_cursor = 'identifier-trigger', reconciliation_error_code = NULL,
    updated_at = NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_identifier_counter_delete
AFTER DELETE ON lookup_identifiers
WHEN OLD.lifecycle_state = 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (OLD.virtual_bucket, 0, 0, 'identifier-trigger', unixepoch())
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_identifier_count =
      CASE WHEN estimated_active_identifier_count > 0
           THEN estimated_active_identifier_count - 1 ELSE 0 END,
    reconciliation_cursor = 'identifier-trigger', reconciliation_error_code = NULL,
    updated_at = unixepoch();
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_alias_counter_insert
AFTER INSERT ON lookup_tenant_aliases
WHEN NEW.lifecycle_state = 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (NEW.virtual_bucket, 0, 1, 'alias-trigger', NEW.updated_at)
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_alias_count = estimated_active_alias_count + 1,
    reconciliation_cursor = 'alias-trigger', reconciliation_error_code = NULL,
    updated_at = NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_alias_counter_activate
AFTER UPDATE OF lifecycle_state ON lookup_tenant_aliases
WHEN OLD.lifecycle_state <> 'active' AND NEW.lifecycle_state = 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (NEW.virtual_bucket, 0, 1, 'alias-trigger', NEW.updated_at)
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_alias_count = estimated_active_alias_count + 1,
    reconciliation_cursor = 'alias-trigger', reconciliation_error_code = NULL,
    updated_at = NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_alias_counter_deactivate
AFTER UPDATE OF lifecycle_state ON lookup_tenant_aliases
WHEN OLD.lifecycle_state = 'active' AND NEW.lifecycle_state <> 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (NEW.virtual_bucket, 0, 0, 'alias-trigger', NEW.updated_at)
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_alias_count =
      CASE WHEN estimated_active_alias_count > 0
           THEN estimated_active_alias_count - 1 ELSE 0 END,
    reconciliation_cursor = 'alias-trigger', reconciliation_error_code = NULL,
    updated_at = NEW.updated_at;
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_alias_counter_delete
AFTER DELETE ON lookup_tenant_aliases
WHEN OLD.lifecycle_state = 'active'
BEGIN
  INSERT INTO lookup_bucket_counters (
    virtual_bucket, estimated_active_identifier_count, estimated_active_alias_count,
    reconciliation_cursor, updated_at
  ) VALUES (OLD.virtual_bucket, 0, 0, 'alias-trigger', unixepoch())
  ON CONFLICT(virtual_bucket) DO UPDATE SET
    estimated_active_alias_count =
      CASE WHEN estimated_active_alias_count > 0
           THEN estimated_active_alias_count - 1 ELSE 0 END,
    reconciliation_cursor = 'alias-trigger', reconciliation_error_code = NULL,
    updated_at = unixepoch();
END;

CREATE TABLE IF NOT EXISTS lookup_discovery_otp_challenges (
  challenge_id TEXT PRIMARY KEY,
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  email_blind_digest TEXT NOT NULL,
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  previous_email_blind_digest TEXT,
  previous_hmac_key_generation INTEGER
    CHECK (previous_hmac_key_generation IS NULL OR previous_hmac_key_generation >= 1),
  previous_virtual_bucket INTEGER
    CHECK (previous_virtual_bucket IS NULL OR previous_virtual_bucket BETWEEN 0 AND 4095),
  otp_verifier TEXT NOT NULL,
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'sent', 'failed', 'unavailable')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_limit INTEGER NOT NULL CHECK (attempt_limit BETWEEN 1 AND 20),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  rate_limit_ip_digest TEXT,
  rate_limit_device_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  CHECK (
    (previous_email_blind_digest IS NULL AND previous_hmac_key_generation IS NULL AND
     previous_virtual_bucket IS NULL) OR
    (previous_email_blind_digest IS NOT NULL AND previous_hmac_key_generation IS NOT NULL AND
     previous_virtual_bucket IS NOT NULL)
  ),
  CHECK (previous_email_blind_digest IS NULL OR
         (previous_email_blind_digest <> email_blind_digest AND
          previous_hmac_key_generation <> hmac_key_generation))
);

CREATE INDEX IF NOT EXISTS idx_lookup_discovery_challenge_digest
  ON lookup_discovery_otp_challenges(email_blind_digest, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lookup_discovery_challenge_expiry
  ON lookup_discovery_otp_challenges(expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS lookup_identifier_replacements (
  replacement_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (index_kind IN ('email_exact', 'external_subject')),
  old_blind_digest TEXT NOT NULL,
  new_blind_digest TEXT NOT NULL,
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  recent_reauth_verified_at INTEGER NOT NULL,
  new_identifier_otp_challenge_id TEXT NOT NULL,
  new_identifier_verified_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_authoritative'
    CHECK (state IN (
      'pending_authoritative',
      'authoritative_updated',
      'directory_pending',
      'completed',
      'blocked_forward_repair'
    )),
  initiating_session_ref TEXT NOT NULL,
  revoke_session_generation INTEGER NOT NULL DEFAULT 0 CHECK (revoke_session_generation >= 0),
  revoke_token_generation INTEGER NOT NULL DEFAULT 0 CHECK (revoke_token_generation >= 0),
  old_identifier_notification_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (old_identifier_notification_state IN ('pending', 'sent', 'failed', 'not_required')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (new_identifier_otp_challenge_id)
    REFERENCES lookup_discovery_otp_challenges(challenge_id),
  CHECK (old_blind_digest <> new_blind_digest),
  CHECK (recent_reauth_verified_at <= created_at AND
         created_at - recent_reauth_verified_at <= 300),
  CHECK (new_identifier_verified_at >= recent_reauth_verified_at AND
         new_identifier_verified_at <= created_at),
  CHECK ((state = 'completed' AND completed_at IS NOT NULL) OR state <> 'completed')
);

CREATE INDEX IF NOT EXISTS idx_lookup_identifier_replacements_repair
  ON lookup_identifier_replacements(state, updated_at);

CREATE TRIGGER IF NOT EXISTS trg_lookup_identifier_replacement_verified_otp_insert
BEFORE INSERT ON lookup_identifier_replacements
WHEN NOT EXISTS (
  SELECT 1 FROM lookup_discovery_otp_challenges challenge
   WHERE challenge.challenge_id = NEW.new_identifier_otp_challenge_id
     AND challenge.email_blind_digest = NEW.new_blind_digest
     AND challenge.hmac_key_generation = NEW.hmac_key_generation
     AND challenge.consumed_at IS NOT NULL
     AND challenge.consumed_at = NEW.new_identifier_verified_at
     AND challenge.consumed_at <= challenge.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'lookup_identifier_replacement_verified_otp_required');
END;

CREATE TRIGGER IF NOT EXISTS trg_lookup_identifier_replacement_verified_otp_update
BEFORE UPDATE OF new_blind_digest, hmac_key_generation, new_identifier_otp_challenge_id,
                 new_identifier_verified_at
ON lookup_identifier_replacements
WHEN NOT EXISTS (
  SELECT 1 FROM lookup_discovery_otp_challenges challenge
   WHERE challenge.challenge_id = NEW.new_identifier_otp_challenge_id
     AND challenge.email_blind_digest = NEW.new_blind_digest
     AND challenge.hmac_key_generation = NEW.hmac_key_generation
     AND challenge.consumed_at IS NOT NULL
     AND challenge.consumed_at = NEW.new_identifier_verified_at
     AND challenge.consumed_at <= challenge.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'lookup_identifier_replacement_verified_otp_required');
END;

CREATE TABLE IF NOT EXISTS lookup_directory_job_cursors (
  job_class TEXT PRIMARY KEY
    CHECK (job_class IN ('routing_outbox', 'hmac_reindex', 'bucket_counter_reconciliation')),
  owner_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at INTEGER,
  cursor_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(cursor_json) AND length(cursor_json) <= 4096),
  budget_remaining INTEGER NOT NULL DEFAULT 0 CHECK (budget_remaining >= 0),
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (owner_id IS NULL AND lease_expires_at IS NULL) OR
    (owner_id IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

INSERT INTO lookup_directory_job_cursors (
  job_class, cursor_json, budget_remaining, updated_at
)
SELECT 'routing_outbox', '{}', 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM lookup_directory_job_cursors WHERE job_class = 'routing_outbox'
);

INSERT INTO lookup_directory_job_cursors (
  job_class, cursor_json, budget_remaining, updated_at
)
SELECT 'hmac_reindex', '{}', 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM lookup_directory_job_cursors WHERE job_class = 'hmac_reindex'
);

INSERT INTO lookup_directory_job_cursors (
  job_class, cursor_json, budget_remaining, updated_at
)
SELECT 'bucket_counter_reconciliation', '{"next_bucket":0}', 0, 0
WHERE NOT EXISTS (
  SELECT 1 FROM lookup_directory_job_cursors WHERE job_class = 'bucket_counter_reconciliation'
);

CREATE TABLE IF NOT EXISTS lookup_migration_state (
  stream_id TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  sql_digest TEXT NOT NULL CHECK (length(sql_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'applying', 'applied', 'failed')),
  operation_id TEXT NOT NULL,
  applied_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stream_id, migration_id)
);
