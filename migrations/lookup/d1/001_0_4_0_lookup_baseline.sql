-- Authrim 0.4.0 semantic fresh-install baseline.
-- Logical stream: lookup-d1.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
PRAGMA foreign_keys = OFF;

CREATE TABLE lookup_schema_metadata (
  metadata_key TEXT PRIMARY KEY,
  metadata_value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE lookup_identifiers (
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
CREATE TABLE lookup_tenant_aliases (
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
  updated_at INTEGER NOT NULL, disabled_at INTEGER,
  PRIMARY KEY (virtual_bucket, alias_kind, alias_sha256_digest, tenant_id),
  CHECK (lifecycle_state <> 'active' OR
         (tenant_lifecycle_state = 'active' AND runtime_route_status = 'active'))
);
CREATE TABLE lookup_identifier_reservations (
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
CREATE TABLE lookup_bucket_counters (
  virtual_bucket INTEGER PRIMARY KEY CHECK (virtual_bucket BETWEEN 0 AND 4095),
  estimated_active_identifier_count INTEGER NOT NULL DEFAULT 0
    CHECK (estimated_active_identifier_count >= 0),
  estimated_active_alias_count INTEGER NOT NULL DEFAULT 0
    CHECK (estimated_active_alias_count >= 0),
  exact_count_checked_at INTEGER,
  reconciliation_cursor TEXT,
  reconciliation_error_code TEXT,
  updated_at INTEGER NOT NULL
, successful_route_publication_count INTEGER NOT NULL DEFAULT 0
    CHECK (successful_route_publication_count >= 0), publication_counter_updated_at INTEGER NOT NULL DEFAULT 0
    CHECK (publication_counter_updated_at >= 0));
WITH RECURSIVE lookup_bucket_seed(virtual_bucket) AS (
  SELECT 0
  UNION ALL
  SELECT virtual_bucket + 1
    FROM lookup_bucket_seed
   WHERE virtual_bucket < 4095
)
INSERT INTO lookup_bucket_counters (
  virtual_bucket,
  estimated_active_identifier_count,
  estimated_active_alias_count,
  exact_count_checked_at,
  reconciliation_cursor,
  reconciliation_error_code,
  updated_at,
  successful_route_publication_count,
  publication_counter_updated_at
)
SELECT virtual_bucket, 0, 0, __AUTHRIM_NOW_EPOCH_SECONDS__, 'bootstrap', NULL, __AUTHRIM_NOW_EPOCH_SECONDS__, 0, __AUTHRIM_NOW_EPOCH_SECONDS__
  FROM lookup_bucket_seed;
CREATE TABLE lookup_discovery_otp_challenges (
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
  updated_at INTEGER NOT NULL, virtual_bucket INTEGER
  CHECK (virtual_bucket IS NULL OR virtual_bucket BETWEEN 0 AND 4095),
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
CREATE TABLE lookup_directory_job_cursors (
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
INSERT INTO lookup_directory_job_cursors VALUES('routing_outbox',NULL,0,NULL,'{}',0,NULL,NULL,NULL,0);
INSERT INTO lookup_directory_job_cursors VALUES('hmac_reindex',NULL,0,NULL,'{}',0,NULL,NULL,NULL,0);
INSERT INTO lookup_directory_job_cursors VALUES('bucket_counter_reconciliation',NULL,0,NULL,'{"next_bucket":0}',0,NULL,NULL,NULL,0);
CREATE TABLE lookup_migration_state (
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
CREATE TABLE IF NOT EXISTS "lookup_identifier_replacements" (
  replacement_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  index_kind TEXT NOT NULL CHECK (index_kind IN ('email_exact', 'external_subject')),
  normalization_version INTEGER NOT NULL CHECK (normalization_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  old_virtual_bucket INTEGER NOT NULL CHECK (old_virtual_bucket BETWEEN 0 AND 4095),
  old_blind_digest TEXT NOT NULL CHECK (length(old_blind_digest) = 64),
  new_virtual_bucket INTEGER NOT NULL CHECK (new_virtual_bucket BETWEEN 0 AND 4095),
  new_blind_digest TEXT NOT NULL CHECK (length(new_blind_digest) = 64),
  gate_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (gate_state IN ('pending', 'authoritative_verified', 'completed', 'blocked')),
  authoritative_checked_at INTEGER,
  completed_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (replacement_id, hmac_key_generation),
  CHECK (old_blind_digest <> new_blind_digest),
  CHECK ((gate_state IN ('authoritative_verified', 'completed') AND
          authoritative_checked_at IS NOT NULL) OR
         gate_state IN ('pending', 'blocked')),
  CHECK ((gate_state = 'completed' AND completed_at IS NOT NULL) OR gate_state <> 'completed')
);
CREATE TRIGGER trg_lookup_identifier_counter_insert
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
CREATE TRIGGER trg_lookup_identifier_counter_activate
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
CREATE TRIGGER trg_lookup_identifier_counter_deactivate
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
CREATE TRIGGER trg_lookup_identifier_counter_delete
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
CREATE TRIGGER trg_lookup_alias_counter_insert
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
CREATE TRIGGER trg_lookup_alias_counter_activate
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
CREATE TRIGGER trg_lookup_alias_counter_deactivate
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
CREATE TRIGGER trg_lookup_alias_counter_delete
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
CREATE TRIGGER trg_lookup_tenant_alias_disabled_at_insert
AFTER INSERT ON lookup_tenant_aliases
WHEN NEW.lifecycle_state = 'disabled' AND NEW.disabled_at IS NULL
BEGIN
  UPDATE lookup_tenant_aliases
     SET disabled_at = NEW.updated_at
   WHERE virtual_bucket = NEW.virtual_bucket
     AND alias_kind = NEW.alias_kind
     AND alias_sha256_digest = NEW.alias_sha256_digest
     AND tenant_id = NEW.tenant_id;
END;
CREATE TRIGGER trg_lookup_tenant_alias_disabled_at_update
AFTER UPDATE OF lifecycle_state ON lookup_tenant_aliases
WHEN NEW.lifecycle_state = 'disabled' AND NEW.disabled_at IS NULL
BEGIN
  UPDATE lookup_tenant_aliases
     SET disabled_at = NEW.updated_at
   WHERE virtual_bucket = NEW.virtual_bucket
     AND alias_kind = NEW.alias_kind
     AND alias_sha256_digest = NEW.alias_sha256_digest
     AND tenant_id = NEW.tenant_id;
END;
CREATE TRIGGER trg_lookup_discovery_otp_bucket_required_insert
BEFORE INSERT ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL
BEGIN
  SELECT RAISE(ABORT, 'lookup_discovery_otp_virtual_bucket_required');
END;
CREATE TRIGGER trg_lookup_discovery_otp_bucket_immutable
BEFORE UPDATE OF virtual_bucket ON lookup_discovery_otp_challenges
WHEN NEW.virtual_bucket IS NULL OR NEW.virtual_bucket <> OLD.virtual_bucket
BEGIN
  SELECT RAISE(ABORT, 'lookup_discovery_otp_virtual_bucket_immutable');
END;
CREATE INDEX idx_lookup_identifiers_exact_active
  ON lookup_identifiers(
    virtual_bucket,
    index_kind,
    hmac_key_generation,
    identifier_blind_digest,
    lifecycle_state
  );
CREATE INDEX idx_lookup_identifiers_account
  ON lookup_identifiers(tenant_id, account_id, lifecycle_state);
CREATE INDEX idx_lookup_identifiers_route_generation
  ON lookup_identifiers(account_route_generation, required_binding_route_generation);
CREATE INDEX idx_lookup_tenant_aliases_exact_active
  ON lookup_tenant_aliases(virtual_bucket, alias_kind, alias_sha256_digest, lifecycle_state);
CREATE UNIQUE INDEX idx_lookup_tenant_aliases_unique_live
  ON lookup_tenant_aliases(virtual_bucket, alias_kind, alias_sha256_digest)
  WHERE lifecycle_state <> 'disabled'
    AND alias_kind IN ('tenant_code', 'tenant_slug', 'invitation_token', 'custom_domain');
CREATE INDEX idx_lookup_identifier_reservations_account
  ON lookup_identifier_reservations(tenant_id, account_id, reservation_state);
CREATE INDEX idx_lookup_identifier_reservations_repair
  ON lookup_identifier_reservations(reservation_state, updated_at);
CREATE INDEX idx_lookup_discovery_challenge_digest
  ON lookup_discovery_otp_challenges(email_blind_digest, created_at DESC);
CREATE INDEX idx_lookup_discovery_challenge_expiry
  ON lookup_discovery_otp_challenges(expires_at, consumed_at);
CREATE INDEX idx_lookup_identifier_replacements_repair
  ON lookup_identifier_replacements(gate_state, updated_at);
CREATE INDEX idx_lookup_identifier_replacements_old_bucket
  ON lookup_identifier_replacements(old_virtual_bucket, gate_state);
CREATE INDEX idx_lookup_identifier_replacements_new_bucket
  ON lookup_identifier_replacements(new_virtual_bucket, gate_state);
CREATE INDEX idx_lookup_identifiers_retention
  ON lookup_identifiers(
    lifecycle_state,
    disabled_at,
    tenant_id,
    virtual_bucket,
    index_kind,
    normalization_version,
    hmac_key_generation,
    identifier_blind_digest,
    account_id
  )
  WHERE lifecycle_state = 'disabled';
CREATE INDEX idx_lookup_tenant_aliases_retention
  ON lookup_tenant_aliases(
    lifecycle_state,
    disabled_at,
    tenant_id,
    virtual_bucket,
    alias_kind,
    alias_sha256_digest
  )
  WHERE lifecycle_state = 'disabled';
CREATE INDEX idx_lookup_identifier_reservations_retention
  ON lookup_identifier_reservations(
    reservation_state,
    released_at,
    tenant_id,
    virtual_bucket,
    operation_id
  )
  WHERE reservation_state = 'released';
CREATE INDEX idx_lookup_identifier_replacements_retention
  ON lookup_identifier_replacements(
    gate_state,
    completed_at,
    tenant_id,
    new_virtual_bucket,
    replacement_id,
    hmac_key_generation
  )
  WHERE gate_state = 'completed';
CREATE INDEX idx_lookup_discovery_otp_cleanup
  ON lookup_discovery_otp_challenges(consumed_at, expires_at, virtual_bucket, challenge_id);

PRAGMA foreign_keys = ON;
